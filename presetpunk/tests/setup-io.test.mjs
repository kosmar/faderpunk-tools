// Unit tests for the push/live-push plumbing in lib/setup-io.js.
// Run: npm test  (node --test tests/)
//
// Requires node_modules/@atov/fp-config → ../../vendor/fp-config (symlink,
// mirrors the browser import map).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSendLayout,
  compareSpawnOrder,
  ensureWireGlobalConfig,
  incrementalSpawnQuietMs,
  normalizeValueForWire,
  padParams,
  paramsWireMatch,
  partitionBySpawnWeight,
  spawnWeight,
  summarizeParamWire,
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
  assert.equal(out.length, 16);
  assert.deepEqual(out[0], { tag: "i32", value: 1 });
  assert.equal(out[1], undefined);
  assert.deepEqual(out[2], { tag: "bool", value: true });
});

test("padParams: always 16 entries, holes undefined, values normalized", () => {
  const out = padParams([
    { tag: "i32", value: [21] },
    { tag: "MidiOut", value: [true, true, true] },
  ]);
  assert.equal(out.length, 16);
  assert.deepEqual(out[0], { tag: "i32", value: 21 });
  assert.deepEqual(out[1], { tag: "MidiOut", value: [[true, true, true]] });
  assert.equal(out[2], undefined);
  assert.equal(out[15], undefined);
});

test("padParams: empty / null input yields 16 undefined", () => {
  assert.equal(padParams([]).length, 16);
  assert.equal(padParams(null).length, 16);
  assert.ok(padParams(null).every((v) => v === undefined));
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
  assert.equal(ordered[1].app.appId, VAMP);
  assert.equal(ordered[2].app.appId, SUPER_LFO);
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
    [VAMP, ECHOLOT, GROOVES],
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
