// Unit tests for the push/live-push plumbing in lib/setup-io.js.
// Run: npm test  (node --test tests/)
//
// Requires node_modules/@atov/fp-config → ../../vendor/fp-config (symlink,
// mirrors the browser import map).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSendLayout,
  normalizeValueForWire,
  padParams,
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

test("normalizeValueForWire: non-Value inputs pass through", () => {
  assert.equal(normalizeValueForWire(null), null);
  assert.equal(normalizeValueForWire(undefined), undefined);
  const noTag = { value: 3 };
  assert.equal(normalizeValueForWire(noTag), noTag);
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

// ---- wire regression: SetAppParams must serialize ----------------------------

test("SetAppParams with padded grooves vector serializes", () => {
  // Regression for "Value ConfigMsgIn has wrong format": unpadded / unnormalized
  // vectors used to blow up in postcard serialize.
  const groovesRow = [
    { tag: "MidiNote", value: [36] },
    { tag: "MidiChannel", value: [7] },
    { tag: "MidiNote", value: [38] },
    { tag: "MidiChannel", value: [8] },
    { tag: "MidiNote", value: [42] },
    { tag: "MidiChannel", value: [9] },
    { tag: "Enum", value: [5] }, // array form on purpose
    { tag: "i32", value: [21] },
    { tag: "i32", value: 100 },
    { tag: "Color", value: { tag: "Pink" } },
    { tag: "MidiOut", value: [true, true, true] }, // flat form on purpose
    { tag: "Enum", value: 0 },
    { tag: "Range", value: { tag: "_0_10V" } },
    { tag: "Enum", value: 0 },
    { tag: "i32", value: 50 },
  ];
  const bytes = serialize("ConfigMsgIn", {
    tag: "SetAppParams",
    value: { layout_id: 0, values: padParams(groovesRow) },
  });
  assert.ok(bytes.length > 0);
});

test("unpadded values throw in serialize (documents why padParams exists)", () => {
  assert.throws(() =>
    serialize("ConfigMsgIn", {
      tag: "SetAppParams",
      value: { layout_id: 0, values: [{ tag: "i32", value: 5 }] },
    }),
  );
});
