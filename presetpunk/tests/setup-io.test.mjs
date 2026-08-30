// Unit tests for the push/live-push plumbing in lib/setup-io.js.
// Run: npm test  (node --test tests/)
//
// Requires node_modules/@atov/fp-config → ../../vendor/fp-config (symlink,
// mirrors the browser import map).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSendLayout,
  buildSparseParams,
  compareSpawnOrder,
  ensureWireGlobalConfig,
  incrementalSpawnQuietMs,
  needsHoldForLayout,
  normalizeValueForWire,
  padParams,
  paramsWireMatch,
  partitionBySpawnWeight,
  spawnWeight,
  summarizeParamWire,
  forceRestartTouch,
  verifyLayoutSlot,
} from "../lib/setup-io.js";
import { serialize } from "../vendor/fp-config/index.js";

// ---- verifyLayoutSlot (live-push guard) -------------------------------------

const GROOVES = 30;
const ECHOLOT = 33;
const BERNOULLI = 27;

/** Device Layout msg value: [ InnerLayout ] */
function deviceLayout(slots) {
  const inner = Array.from({ length: 16 }, () => undefined);
  for (const [ch, appId, channels, lid] of slots) inner[ch] = [appId, channels, lid];
  return [inner];
}

test("verifyLayoutSlot: matching slot passes", () => {
  const lay = deviceLayout([[0, GROOVES, 1, 0], [1, BERNOULLI, 2, 1]]);
  const r = verifyLayoutSlot(lay, 1, BERNOULLI);
  assert.equal(r.ok, true);
  assert.deepEqual(r.found, { appId: BERNOULLI, channels: 2, ch: 1 });
});

test("verifyLayoutSlot: stale layoutId → wrong app is rejected", () => {
  // Regression: editor reordered rows (echolot now id=1) but device still has
  // bernoulli at id=1. Live param push must NOT write echolot params there.
  const lay = deviceLayout([[0, GROOVES, 1, 0], [1, BERNOULLI, 2, 1]]);
  const r = verifyLayoutSlot(lay, 1, ECHOLOT);
  assert.equal(r.ok, false);
  assert.match(r.reason, /is app 27 .* expects 33/);
});

test("verifyLayoutSlot: missing layoutId is rejected", () => {
  const lay = deviceLayout([[0, GROOVES, 1, 0]]);
  const r = verifyLayoutSlot(lay, 5, GROOVES);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in device layout/);
  assert.equal(r.found, null);
});

test("verifyLayoutSlot: no expectAppId only checks presence", () => {
  const lay = deviceLayout([[3, ECHOLOT, 1, 4]]);
  assert.equal(verifyLayoutSlot(lay, 4, null).ok, true);
  assert.equal(verifyLayoutSlot(lay, 9, null).ok, false);
});

test("verifyLayoutSlot: tolerates empty / malformed layout value", () => {
  assert.equal(verifyLayoutSlot(undefined, 0, GROOVES).ok, false);
  assert.equal(verifyLayoutSlot([], 0, GROOVES).ok, false);
  assert.equal(verifyLayoutSlot([[]], 0, GROOVES).ok, false);
});

// ---- normalizeValueForWire / padParams --------------------------------------

test("normalizeValueForWire: scalar tags never single-element arrays", () => {
  assert.deepEqual(normalizeValueForWire({ tag: "i32", value: [70] }), {
    tag: "i32",
    value: 70,
  });
  assert.deepEqual(normalizeValueForWire({ tag: "Enum", value: [2] }), {
    tag: "Enum",
    value: 2,
  });
  assert.deepEqual(normalizeValueForWire({ tag: "bool", value: [true] }), {
    tag: "bool",
    value: true,
  });
  // Already-scalar stays untouched
  assert.deepEqual(normalizeValueForWire({ tag: "i32", value: 55 }), {
    tag: "i32",
    value: 55,
  });
});

test("normalizeValueForWire: flat MidiOut flags get wrapped", () => {
  assert.deepEqual(
    normalizeValueForWire({ tag: "MidiOut", value: [true, false, true] }),
    { tag: "MidiOut", value: [[true, false, true]] },
  );
  // Correct shape passes through
  const ok = { tag: "MidiOut", value: [[true, true, false]] };
  assert.deepEqual(normalizeValueForWire(ok), ok);
});

test("normalizeValueForWire: Param None is not a wire Value", () => {
  assert.equal(normalizeValueForWire({ tag: "None" }), undefined);
});

test("normalizeValueForWire: NaN MidiNote/MidiChannel from unset note column", () => {
  // Regression: Contura live SetAppParams — enforceRowMidi used Number(row.cc)
  // when unset → [NaN] → "Value ConfigMsgIn has wrong format".
  assert.deepEqual(normalizeValueForWire({ tag: "MidiNote", value: [NaN] }), {
    tag: "MidiNote",
    value: [48],
  });
  assert.deepEqual(normalizeValueForWire({ tag: "MidiChannel", value: [NaN] }), {
    tag: "MidiChannel",
    value: [1],
  });
  assert.deepEqual(normalizeValueForWire({ tag: "MidiNote", value: [60] }), {
    tag: "MidiNote",
    value: [60],
  });
});

test("normalizeValueForWire: non-Value inputs pass through", () => {
  assert.equal(normalizeValueForWire(null), null);
  assert.equal(normalizeValueForWire(undefined), undefined);
  const noTag = { value: 3 };
  assert.equal(normalizeValueForWire(noTag), noTag);
});

test("padParams: None placeholders become undefined holes", () => {
  const out = padParams([
    { tag: "i32", value: 1 },
    { tag: "None" },
    { tag: "bool", value: true },
  ]);
  assert.equal(out.length, 17);
  assert.deepEqual(out[0], { tag: "i32", value: 1 });
  assert.equal(out[1], undefined);
  assert.deepEqual(out[2], { tag: "bool", value: true });
});

test("padParams: always 17 entries, holes undefined, values normalized", () => {
  const out = padParams([
    { tag: "i32", value: [21] },
    { tag: "MidiOut", value: [true, true, true] },
  ]);
  assert.equal(out.length, 17);
  assert.deepEqual(out[0], { tag: "i32", value: 21 });
  assert.deepEqual(out[1], { tag: "MidiOut", value: [[true, true, true]] });
  assert.equal(out[2], undefined);
  assert.equal(out[16], undefined);
});

test("padParams: empty / null input yields 17 undefined", () => {
  assert.equal(padParams([]).length, 17);
  assert.equal(padParams(null).length, 17);
  assert.ok(padParams(null).every((v) => v === undefined));
});

// ---- buildSparseParams (sparse SetAppParams wire) ---------------------------

test("buildSparseParams: equal vectors → all undefined", () => {
  const host = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiChannel", value: [7] },
    { tag: "i32", value: 42 },
  ];
  const device = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiChannel", value: [7] },
    { tag: "i32", value: 42 },
  ];
  const sparse = buildSparseParams(host, device);
  assert.equal(sparse.length, 17);
  assert.ok(sparse.every((v) => v === undefined));
});

test("buildSparseParams: one MidiCc differs → only that index set", () => {
  const host = [
    { tag: "MidiCc", value: [1] },
    { tag: "MidiCc", value: [74] },
    { tag: "MidiCc", value: [7] },
  ];
  const device = [
    { tag: "MidiCc", value: [1] },
    { tag: "MidiCc", value: [71] },
    { tag: "MidiCc", value: [7] },
  ];
  const sparse = buildSparseParams(host, device);
  assert.equal(sparse[0], undefined);
  assert.deepEqual(sparse[1], { tag: "MidiCc", value: [74] });
  assert.equal(sparse[2], undefined);
  assert.ok(sparse.slice(3).every((v) => v === undefined));
});

test("buildSparseParams: trailing undefined preserved", () => {
  const host = [
    { tag: "i32", value: 10 },
    undefined,
    undefined,
    { tag: "Enum", value: 3 },
  ];
  const device = [
    { tag: "i32", value: 99 },
    { tag: "bool", value: true },
    undefined,
    { tag: "Enum", value: 3 },
  ];
  const sparse = buildSparseParams(host, device);
  assert.deepEqual(sparse[0], { tag: "i32", value: 10 });
  assert.equal(sparse[1], undefined);
  assert.equal(sparse[2], undefined);
  assert.equal(sparse[3], undefined);
  assert.ok(sparse.slice(4).every((v) => v === undefined));
});

test("buildSparseParams: missing device slot includes host value", () => {
  const host = [{ tag: "MidiChannel", value: [5] }];
  const sparse = buildSparseParams(host, []);
  assert.deepEqual(sparse[0], { tag: "MidiChannel", value: [5] });
  assert.ok(sparse.slice(1).every((v) => v === undefined));
});

test("forceRestartTouch: flips first bool", () => {
  const host = padParams([
    { tag: "MidiChannel", value: [14] },
    { tag: "bool", value: true },
    { tag: "Enum", value: 2 },
  ]);
  const touch = forceRestartTouch(host);
  assert.equal(touch[0], undefined);
  assert.deepEqual(touch[1], { tag: "bool", value: false });
  assert.equal(touch[2], undefined);
  const restore = buildSparseParams(
    [
      { tag: "MidiChannel", value: [14] },
      { tag: "bool", value: true },
      { tag: "Enum", value: 2 },
    ],
    [
      { tag: "MidiChannel", value: [14] },
      { tag: "bool", value: false },
      { tag: "Enum", value: 2 },
    ],
  );
  assert.deepEqual(restore[1], { tag: "bool", value: true });
});

test("forceRestartTouch: Enum when no bool", () => {
  const host = padParams([
    { tag: "MidiChannel", value: [16] },
    { tag: "Enum", value: 0 },
  ]);
  const touch = forceRestartTouch(host);
  assert.deepEqual(touch[1], { tag: "Enum", value: 1 });
});

test("forceRestartTouch: Color when no bool/Enum", () => {
  const host = padParams([{ tag: "Color", value: { tag: "Yellow" } }]);
  const touch = forceRestartTouch(host);
  assert.deepEqual(touch[0], { tag: "Color", value: { tag: "Red" } });
});

test("forceRestartTouch: null when nothing to bump", () => {
  const host = padParams([{ tag: "MidiChannel", value: [7] }]);
  assert.equal(forceRestartTouch(host), null);
});

// ---- paramsWireMatch (SetAppParams verify without ACK) ----------------------

test("paramsWireMatch: matching scalars, enums, and midi types", () => {
  const sent = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiChannel", value: [7] },
    { tag: "Enum", value: 5 },
    { tag: "i32", value: 100 },
    { tag: "bool", value: true },
  ];
  const got = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiChannel", value: [7] },
    { tag: "Enum", value: 5 },
    { tag: "i32", value: 100 },
    { tag: "bool", value: true },
  ];
  assert.equal(paramsWireMatch(sent, got), true);
});

test("paramsWireMatch: tagged Range/Color/Curve values", () => {
  const sent = [
    { tag: "Range", value: { tag: "_0_10V" } },
    { tag: "Color", value: { tag: "Pink" } },
    { tag: "Curve", value: { tag: "Linear" } },
  ];
  const got = [
    { tag: "Range", value: { tag: "_0_10V" } },
    { tag: "Color", value: { tag: "Pink" } },
    { tag: "Curve", value: { tag: "Linear" } },
  ];
  assert.equal(paramsWireMatch(sent, got), true);
});

test("paramsWireMatch: MidiOut flat vs nested flag triples", () => {
  const sent = [{ tag: "MidiOut", value: [[true, false, true]] }];
  const got = [{ tag: "MidiOut", value: [true, false, true] }];
  assert.equal(paramsWireMatch(sent, got), true);
});

test("paramsWireMatch: ignores trailing undefined holes on sent", () => {
  const sent = [
    { tag: "i32", value: 42 },
    undefined,
    undefined,
  ];
  const got = [{ tag: "i32", value: 42 }, { tag: "Enum", value: 0 }];
  assert.equal(paramsWireMatch(sent, got), true);
});

test("paramsWireMatch: mismatch on scalar value", () => {
  const sent = [{ tag: "i32", value: 70 }];
  const got = [{ tag: "i32", value: 21 }];
  assert.equal(paramsWireMatch(sent, got), false);
});

test("paramsWireMatch: mismatch on tag", () => {
  const sent = [{ tag: "Enum", value: 2 }];
  const got = [{ tag: "i32", value: 2 }];
  assert.equal(paramsWireMatch(sent, got), false);
});

test("paramsWireMatch: rejects empty or non-array input", () => {
  assert.equal(paramsWireMatch([], [{ tag: "i32", value: 1 }]), false);
  assert.equal(paramsWireMatch(null, []), false);
  assert.equal(paramsWireMatch([{ tag: "i32", value: 1 }], null), false);
});

// ---- buildSendLayout ---------------------------------------------------------

test("buildSendLayout: places by startChannel with holes", () => {
  const layout = buildSendLayout([
    { id: 0, app: { appId: GROOVES, channels: 1 }, startChannel: 0 },
    { id: 1, app: { appId: BERNOULLI, channels: 2 }, startChannel: 3 },
  ]);
  assert.deepEqual(layout[0][0], [GROOVES, 1, 0]);
  assert.equal(layout[0][1], undefined);
  assert.equal(layout[0][2], undefined);
  assert.deepEqual(layout[0][3], [BERNOULLI, 2, 1]);
});

test("buildSendLayout: packed fallback when startChannel missing", () => {
  const layout = buildSendLayout([
    { id: 0, app: { appId: GROOVES, channels: 1 } },
    { id: 1, app: { appId: BERNOULLI, channels: 2 } },
    { id: 2, app: { appId: ECHOLOT, channels: 1 } },
  ]);
  assert.deepEqual(layout[0][0], [GROOVES, 1, 0]);
  assert.deepEqual(layout[0][1], [BERNOULLI, 2, 1]);
  // bernoulli spans 2 channels → echolot lands at ch3
  assert.equal(layout[0][2], undefined);
  assert.deepEqual(layout[0][3], [ECHOLOT, 1, 2]);
});

test("buildSendLayout: out-of-range startChannel is skipped", () => {
  const layout = buildSendLayout([
    { id: 0, app: { appId: GROOVES, channels: 1 }, startChannel: 20 },
    { id: 1, app: { appId: ECHOLOT, channels: 1 }, startChannel: 15 },
  ]);
  assert.deepEqual(layout[0][15], [ECHOLOT, 1, 1]);
  assert.ok(layout[0].slice(0, 15).every((s) => s === undefined));
});

// ---- compareSpawnOrder (incremental Full Push) -------------------------------

const VAMP = 35;
const SUPER_LFO = 32;
const HOLD_SAM = 36;

test("spawnWeight: large param vectors cost more; multi-ch flagged heavy", () => {
  assert.equal(
    spawnWeight({ app: { appId: 1, channels: 1, paramCount: 6 } }),
    1,
  );
  assert.equal(
    spawnWeight({ app: { appId: HOLD_SAM, channels: 1, paramCount: 11 } }),
    2,
  );
  assert.equal(
    spawnWeight({ app: { appId: VAMP, channels: 1, paramCount: 16 } }),
    3,
  );
  assert.equal(
    spawnWeight({ app: { appId: SUPER_LFO, channels: 2, paramCount: 9 } }),
    3,
  );
});

test("partitionBySpawnWeight: heavies are multi-ch / large params, not named apps", () => {
  const slots = [
    { id: 0, app: { appId: HOLD_SAM, channels: 1, paramCount: 11, name: "Hold Sam" }, startChannel: 0 },
    { id: 1, app: { appId: GROOVES, channels: 1, paramCount: 14, name: "Grooves" }, startChannel: 1 },
    { id: 2, app: { appId: SUPER_LFO, channels: 2, paramCount: 9, name: "Super LFO" }, startChannel: 2 },
    { id: 3, app: { appId: BERNOULLI, channels: 1, paramCount: 6, name: "Bernoulli" }, startChannel: 3 },
  ];
  const { light, heavy } = partitionBySpawnWeight(slots);
  assert.deepEqual(
    light.map((s) => s.app.appId),
    [HOLD_SAM, BERNOULLI],
  );
  assert.deepEqual(
    heavy.map((s) => s.app.appId).sort((a, b) => a - b),
    [GROOVES, SUPER_LFO].sort((a, b) => a - b),
  );
});

test("compareSpawnOrder: physical channel order avoids sparse prefixes", () => {
  const slots = [
    { id: 3, app: { appId: VAMP, channels: 1, paramCount: 16, name: "Chord Vamp" }, startChannel: 3 },
    { id: 0, app: { appId: GROOVES, channels: 1, paramCount: 8, name: "Grooves" }, startChannel: 0 },
    { id: 6, app: { appId: SUPER_LFO, channels: 2, paramCount: 9, name: "Super LFO" }, startChannel: 6 },
  ];
  const ordered = [...slots].sort(compareSpawnOrder);
  assert.equal(ordered[0].app.appId, GROOVES);
  assert.equal(ordered[1].app.appId, SUPER_LFO);
  assert.equal(ordered[2].app.appId, VAMP);
});

test("compareSpawnOrder: Chord Vamp spawns after every other app (Zeta)", () => {
  const slots = [
    { id: 11, app: { appId: 106, channels: 1, paramCount: 16, name: "Chord Vamp" }, startChannel: 13 },
    { id: 12, app: { appId: 100, channels: 1, paramCount: 8, name: "Heat Pump" }, startChannel: 14 },
    { id: 13, app: { appId: 107, channels: 1, paramCount: 11, name: "Hold Sam" }, startChannel: 15 },
    { id: 0, app: { appId: GROOVES, channels: 1, paramCount: 16, name: "Grooves" }, startChannel: 0 },
  ];
  const ordered = [...slots].sort(compareSpawnOrder);
  assert.deepEqual(
    ordered.map((s) => s.app.name),
    ["Grooves", "Heat Pump", "Hold Sam", "Chord Vamp"],
  );
});

test("compareSpawnOrder: param count does not override channel order", () => {
  const slots = [
    { id: 3, app: { appId: VAMP, channels: 1, paramCount: 16 }, startChannel: 0 },
    { id: 0, app: { appId: GROOVES, channels: 1, paramCount: 8 }, startChannel: 5 },
    { id: 5, app: { appId: ECHOLOT, channels: 1, paramCount: 8 }, startChannel: 3 },
  ];
  const ordered = [...slots].sort(compareSpawnOrder);
  assert.deepEqual(
    ordered.map((s) => s.app.appId),
    [ECHOLOT, GROOVES, VAMP],
  );
});

test("compareSpawnOrder: wire layout still places vamp at its startChannel", () => {
  // Addition order ≠ channel order; buildSendLayout must keep holes.
  const growing = [
    { id: 0, app: { appId: GROOVES, channels: 1 }, startChannel: 0 },
    { id: 5, app: { appId: ECHOLOT, channels: 1 }, startChannel: 5 },
    { id: 3, app: { appId: VAMP, channels: 1 }, startChannel: 3 },
  ];
  const lay = buildSendLayout(growing);
  assert.deepEqual(lay[0][0], [GROOVES, 1, 0]);
  assert.equal(lay[0][1], undefined);
  assert.equal(lay[0][2], undefined);
  assert.deepEqual(lay[0][3], [VAMP, 1, 3]);
  assert.deepEqual(lay[0][5], [ECHOLOT, 1, 5]);
});

test("needsHoldForLayout: Zeta-scale presets use hold-dense", () => {
  const zetaSlots = Array.from({ length: 14 }, (_, i) => ({
    id: i,
    app: { appId: 100 + i, channels: 1, paramCount: 10, name: `App${i}` },
    startChannel: i,
  }));
  assert.equal(needsHoldForLayout(zetaSlots), true);
  assert.equal(needsHoldForLayout(zetaSlots.slice(0, 5)), false);
  assert.equal(
    needsHoldForLayout([
      { id: 0, app: { appId: 49, name: "Blank" }, startChannel: 0 },
    ]),
    false,
  );
});

test("needsHoldForLayout: Semmy@ch0 + Controls skips hold-dense (Beta)", () => {
  const beta = [
    {
      id: 0,
      app: { appId: 120, channels: 2, paramCount: 9, name: "Semmy" },
      startChannel: 0,
    },
    ...Array.from({ length: 14 }, (_, i) => ({
      id: i + 1,
      app: { appId: 1, channels: 1, paramCount: 11, name: "Control" },
      startChannel: i + 2,
    })),
  ];
  assert.equal(needsHoldForLayout(beta), false);
  // Two heavies → still hold (Zeta / Hold Sam class).
  const withExtraHeavy = [
    ...beta,
    {
      id: 15,
      app: { appId: 101, channels: 1, paramCount: 16, name: "Grooves" },
      startChannel: 1,
    },
  ];
  // 16 apps with Grooves (w≥3) + Semmy → heavyN≥2
  assert.equal(needsHoldForLayout(withExtraHeavy), true);
});

test("needsHoldForLayout: Zeta-scale multi-heavy still needs Hold", () => {
  const zeta = [
    { id: 0, app: { appId: 101, channels: 1, paramCount: 16, name: "Grooves" }, startChannel: 0 },
    { id: 1, app: { appId: 112, channels: 1, paramCount: 14, name: "Bassment" }, startChannel: 1 },
    { id: 2, app: { appId: 113, channels: 1, paramCount: 12, name: "Contura" }, startChannel: 5 },
    { id: 3, app: { appId: 121, channels: 1, paramCount: 12, name: "Umbra" }, startChannel: 6 },
    { id: 4, app: { appId: 120, channels: 2, paramCount: 9, name: "Semmy" }, startChannel: 7 },
    { id: 5, app: { appId: 115, channels: 4, paramCount: 12, name: "Ripppple" }, startChannel: 10 },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: 10 + i,
      app: { appId: 1, channels: 1, paramCount: 8, name: "Control" },
      startChannel: i < 4 ? i + 2 : i + 8,
    })),
  ];
  assert.equal(needsHoldForLayout(zeta), true);
});

test("incrementalSpawnQuietMs: first post-clear spawn uses a longer floor", () => {
  const grooves = {
    id: 0,
    app: { appId: GROOVES, channels: 1, paramCount: 16, name: "Grooves" },
    startChannel: 0,
  };
  assert.equal(incrementalSpawnQuietMs(grooves, 0, 9), 2200);
  assert.equal(incrementalSpawnQuietMs(grooves, 1, 9), 800);
  const light = {
    id: 1,
    app: { appId: BERNOULLI, channels: 1, paramCount: 6 },
    startChannel: 1,
  };
  assert.equal(incrementalSpawnQuietMs(light, 0, 9), 2200);
  assert.equal(incrementalSpawnQuietMs(light, 1, 9), 500);
});

test("incrementalSpawnQuietMs: late 4ch spawn gets extra quiet", () => {
  const manifold = {
    id: 8,
    app: { appId: 43, channels: 4, paramCount: 16, name: "Manifold" },
    startChannel: 11,
  };
  const ripppple = {
    id: 7,
    app: { appId: 46, channels: 4, paramCount: 15, name: "Ripppple" },
    startChannel: 7,
  };
  assert.equal(incrementalSpawnQuietMs(manifold, 8, 10), 8000);
  assert.equal(incrementalSpawnQuietMs(ripppple, 7, 10), 8000);
  assert.equal(incrementalSpawnQuietMs(ripppple, 1, 10), 1200);
});

test("incrementalSpawnQuietMs: dense layouts ramp the quiet per running app", () => {
  const echolot = {
    id: 10,
    app: { appId: ECHOLOT, channels: 1, paramCount: 16, name: "Echolot" },
    startChannel: 14,
  };
  // Early spawns keep the old floors …
  assert.equal(incrementalSpawnQuietMs(echolot, 3, 12), 800);
  // … mid-pack still ramps (index 4 < 6, before the late-packed 8000ms floor).
  assert.equal(incrementalSpawnQuietMs(echolot, 4, 12), 1100);
  const light = {
    id: 11,
    app: { appId: BERNOULLI, channels: 1, paramCount: 6 },
    startChannel: 15,
  };
  // Light 1ch still ramps instead of jumping to the heavy late floor.
  assert.equal(incrementalSpawnQuietMs(light, 11, 12), 3200);
});

test("incrementalSpawnQuietMs: late heavy 1ch gets the multi-ch quiet floor", () => {
  const vamp = {
    id: 11,
    app: { appId: VAMP, channels: 1, paramCount: 16, name: "Chord Vamp" },
    startChannel: 13,
  };
  const echolot = {
    id: 10,
    app: { appId: ECHOLOT, channels: 1, paramCount: 16, name: "Echolot" },
    startChannel: 14,
  };
  // Zeta 14-app hold-incremental: Chord Vamp as 14/14 at 8000ms (deferred last).
  assert.equal(incrementalSpawnQuietMs(vamp, 13, 14), 8000);
  assert.equal(incrementalSpawnQuietMs(echolot, 10, 12), 8000);
  // Early heavy 1ch stays on the short floor (plus first-spawn override).
  assert.equal(incrementalSpawnQuietMs(vamp, 1, 14), 800);
});

test("incrementalSpawnQuietMs: growing after multi-ch uses a long floor (Beta Semmy→Control)", () => {
  const semmy = {
    id: 0,
    app: { appId: 120, channels: 2, paramCount: 9, name: "Semmy" },
    startChannel: 0,
  };
  const control = {
    id: 1,
    app: { appId: 1, channels: 1, paramCount: 11, name: "Control" },
    startChannel: 2,
  };
  assert.equal(incrementalSpawnQuietMs(control, 1, 15, []), 500);
  assert.equal(incrementalSpawnQuietMs(control, 1, 15, [semmy]), 4000);
  assert.equal(incrementalSpawnQuietMs(control, 4, 15, [semmy]), 4300);
});

// ---- wire regression: SetAppParams must serialize ----------------------------

test("SetAppParams with padded grooves vector serializes", () => {
  // Regression for "Value ConfigMsgIn has wrong format": unpadded / unnormalized
  // vectors used to blow up in postcard serialize.
  const groovesRow = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiNote", value: [38] },
    { tag: "MidiNote", value: [42] },
    { tag: "MidiNote", value: [0] },
    { tag: "MidiNote", value: [0] },
    { tag: "MidiNote", value: [0] },
    { tag: "MidiNote", value: [39] },
    { tag: "MidiChannel", value: [7] },
    { tag: "i32", value: 0 }, // Ch Map — 0 = follow base
    { tag: "Enum", value: [5] }, // array form on purpose
    { tag: "i32", value: [21] },
    { tag: "i32", value: 100 },
    { tag: "MidiOut", value: [true, true, true] }, // flat form on purpose
    { tag: "Enum", value: 0 },
    { tag: "i32", value: 50 }, // CV Att (post-Drummer catalog)
    { tag: "Enum", value: 0 }, // Drummer
  ];
  const bytes = serialize("ConfigMsgIn", {
    tag: "SetAppParams",
    value: { layout_id: 0, values: padParams(groovesRow) },
  });
  assert.ok(bytes.length > 0);
  assert.match(summarizeParamWire(padParams(groovesRow)), /15:Enum=0/);
});

test("summarizeParamWire flags legacy Range in Grooves tail", () => {
  const legacyTail = padParams([
    ...Array.from({ length: 14 }, () => ({ tag: "i32", value: 0 })),
    { tag: "Range", value: { tag: "_0_10V" } },
    { tag: "i32", value: 50 },
  ]);
  // Slot 0..13 overwritten; check tags at 14/15 via direct summarize
  assert.match(
    summarizeParamWire([
      { tag: "Enum", value: 0 },
      { tag: "Range", value: { tag: "_0_10V" } },
      { tag: "i32", value: 50 },
    ]),
    /Range:_0_10V/,
  );
  assert.ok(legacyTail);
});

test("SetAppParams rejects stale Grooves schema tags (pre-7-voice layout)", () => {
  // Length stayed 16 while tags moved — overlay used to stamp MidiOut flags
  // into a Range slot and blow up serialize with ConfigMsgIn wrong format.
  const stale = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiChannel", value: [7] },
    { tag: "MidiNote", value: [38] },
    { tag: "MidiChannel", value: [8] },
    { tag: "MidiNote", value: [42] },
    { tag: "MidiChannel", value: [9] },
    { tag: "Enum", value: 3 },
    { tag: "i32", value: 50 },
    { tag: "i32", value: 40 },
    { tag: "Color", value: { tag: "Pink" } },
    { tag: "MidiOut", value: [[true, false, false]] },
    { tag: "Enum", value: 0 },
    { tag: "Range", value: [[true, false, false]] }, // MidiOut flags written into Range
    { tag: "Enum", value: 0 },
    { tag: "i32", value: 100 },
    { tag: "Enum", value: 0 },
  ];
  assert.throws(
    () =>
      serialize("ConfigMsgIn", {
        tag: "SetAppParams",
        value: { layout_id: 0, values: padParams(stale) },
      }),
    /ConfigMsgIn.*wrong format/,
  );
});

test("unpadded values throw in serialize (documents why padParams exists)", () => {
  assert.throws(() =>
    serialize("ConfigMsgIn", {
      tag: "SetAppParams",
      value: { layout_id: 0, values: [{ tag: "i32", value: 5 }] },
    }),
  );
});

// ---- wire regression: SetGlobalConfig must include custom_voct_curves --------

function sampleGlobalConfigWithoutCurves() {
  // Shape historically emitted by Presetpunk buildSetup before V/Oct curves
  // landed in GlobalConfig — missing custom_voct_curves.
  return {
    aux: [
      { tag: "ClockOut", value: { tag: "_1" } },
      { tag: "None" },
      { tag: "None" },
    ],
    clock: {
      clock_src: { tag: "Internal" },
      ext_ppqn: 24,
      reset_src: { tag: "None" },
      internal_bpm: 120,
      swing_amount: 0,
    },
    i2c_mode: { tag: "Leader" },
    led_brightness: 150,
    midi: {
      outs: [
        { send_clock: true, send_transport: true, mode: { tag: "Local" } },
        { send_clock: true, send_transport: true, mode: { tag: "Local" } },
        { send_clock: true, send_transport: true, mode: { tag: "Local" } },
      ],
    },
    quantizer: { key: { tag: "Chromatic" }, tonic: { tag: "C" } },
    takeover_mode: { tag: "Pickup" },
  };
}

test("SetGlobalConfig without custom_voct_curves fails serialize", () => {
  // Regression: Live clock/presettings push → "Value ConfigMsgIn has wrong format"
  assert.throws(
    () =>
      serialize("ConfigMsgIn", {
        tag: "SetGlobalConfig",
        value: sampleGlobalConfigWithoutCurves(),
      }),
    /ConfigMsgIn.*wrong format/,
  );
});

test("ensureWireGlobalConfig pads curves so SetGlobalConfig serializes", () => {
  const wire = ensureWireGlobalConfig(sampleGlobalConfigWithoutCurves());
  assert.equal(wire.custom_voct_curves.length, 4);
  assert.deepEqual(wire.custom_voct_curves[0], { counts_per_oct: 0 });
  const bytes = serialize("ConfigMsgIn", {
    tag: "SetGlobalConfig",
    value: wire,
  });
  assert.ok(bytes.length > 0);
});

test("ensureWireGlobalConfig preserves existing curve counts", () => {
  const src = sampleGlobalConfigWithoutCurves();
  src.custom_voct_curves = [
    { counts_per_oct: 1000 },
    { counts_per_oct: 2000 },
    { counts_per_oct: 3000 },
    { counts_per_oct: 4000 },
  ];
  const wire = ensureWireGlobalConfig(src);
  assert.deepEqual(wire.custom_voct_curves, src.custom_voct_curves);
});

test("ensureWireGlobalConfig rebuilds from editor-shaped / partial global", () => {
  // Regression: showcase JSON stored wire clock under global.clock only;
  // LaunchAgent used to serve a tree without curves → ConfigMsgIn fail.
  const wire = ensureWireGlobalConfig({
    clock: {
      clock_src: { tag: "MidiUsb" },
      ext_ppqn: 24,
      reset_src: { tag: "None" },
      internal_bpm: 124,
      swing_amount: 8,
    },
    midi: [
      { mode: "Local", sendClock: true, sendTransport: true },
      {
        mode: "MidiMerge",
        sendClock: true,
        sendTransport: true,
        sourceUsb: false,
        sourceDin: true,
      },
      {
        mode: "MidiMerge",
        sendClock: true,
        sendTransport: true,
        sourceUsb: false,
        sourceDin: true,
      },
    ],
    scale: "Mixolydian",
    tonic: "DSharp",
    takeover: "Scale",
  });
  assert.equal(wire.clock.clock_src.tag, "MidiUsb");
  assert.equal(wire.clock.internal_bpm, 124);
  assert.equal(wire.clock.swing_amount, 8);
  assert.equal(wire.quantizer.key.tag, "Mixolydian");
  assert.equal(wire.quantizer.tonic.tag, "DSharp");
  assert.equal(wire.takeover_mode.tag, "Scale");
  assert.equal(wire.midi.outs[1].mode.tag, "MidiMerge");
  assert.deepEqual(wire.midi.outs[1].mode.value.sources, [[false, true]]);
  const bytes = serialize("ConfigMsgIn", {
    tag: "SetGlobalConfig",
    value: wire,
  });
  assert.ok(bytes.length > 0);
});
