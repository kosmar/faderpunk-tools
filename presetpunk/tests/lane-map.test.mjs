// Unit tests for the generic packed lane maps in index.html.
// Run: npm test  (node --test tests/)
//
// index.html has no build step and no module boundary, so the helper block is
// lifted out by its marker comments and evaluated here. Keep the markers in
// sync when moving the block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const html = readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  "utf8",
);
const block = html.match(
  /\/\/ --- packed lane maps \(generic\)[\s\S]*?\/\/ --- end packed lane maps ---/,
);
assert.ok(block, "lane map helper block not found in index.html");

const ctx = vm.createContext({});
vm.runInContext(
  `${block[0]}
   globalThis.api = { packMap, unpackMap, laneValuesFromMap, clampLaneValue,
                      LANE_CH_FIELD, LANE_CC_FIELD };`,
  ctx,
);
const { packMap, unpackMap, laneValuesFromMap, LANE_CH_FIELD, LANE_CC_FIELD } = ctx.api;

/** vm realm arrays are not reference-equal to host Array — copy before compare. */
const arr = (x) => Array.from(x);

const CH7 = { ...LANE_CH_FIELD, count: 7 };
const CH4 = { ...LANE_CH_FIELD, count: 4 };
const CC4 = { ...LANE_CC_FIELD, count: 4 };

// ---- nibble channels (4 bit, offset 1) --------------------------------------

test("packMap: every lane on the base channel packs to 0", () => {
  assert.equal(packMap([5, 5, 5, 5, 5, 5, 5], { ...CH7, follow: 5 }), 0);
  assert.equal(packMap([null, null, null, null], { ...CH4, follow: 3 }), 0);
});

test("packMap/unpackMap: nibble channels round-trip", () => {
  const chs = [1, 2, 3, 4, 16, 9, 10];
  const map = packMap(chs, { ...CH7, follow: 1 });
  assert.notEqual(map, 0);
  assert.deepEqual(arr(unpackMap(map, { ...CH7, follow: 1 })), chs);
});

test("packMap: nibble layout is lane w at bits 4w, stored value ch - 1", () => {
  // Kick 1, Snare 2, rest on base 1 → only lane 1 is non-zero.
  const map = packMap([1, 2, 1, 1, 1, 1, 1], { ...CH7, follow: 1 });
  assert.equal(map, 1 << 4);
  assert.equal(packMap([16, 1, 1, 1], { ...CH4, follow: 1 }), 15);
});

test("unpackMap: a zero map expands to the follow value", () => {
  assert.deepEqual(arr(unpackMap(0, { ...CH4, follow: 7 })), [7, 7, 7, 7]);
});

test("packMap: out-of-range channels clamp into the field", () => {
  assert.deepEqual(
    arr(unpackMap(packMap([0, 99, 4, 4], { ...CH4, follow: 4 }), { ...CH4, follow: 4 })),
    [1, 16, 4, 4],
  );
});

// ---- 7-bit CC numbers (offset 0) --------------------------------------------

test("packMap: CC lanes on the derived base pack to 0", () => {
  const follow = (i) => 20 + i;
  assert.equal(packMap([20, 21, 22, 23], { ...CC4, follow }), 0);
  assert.equal(packMap([null, null, null, null], { ...CC4, follow }), 0);
});

test("packMap/unpackMap: 7-bit CCs round-trip", () => {
  const follow = (i) => 20 + i;
  const ccs = [0, 127, 64, 1];
  const map = packMap(ccs, { ...CC4, follow });
  assert.equal(map, 0 + (127 << 7) + (64 << 14) + (1 << 21));
  assert.deepEqual(arr(unpackMap(map, { ...CC4, follow })), ccs);
});

test("packMap: a single lane off the base survives with the others", () => {
  const follow = (i) => 20 + i;
  const map = packMap([20, 21, 99, 23], { ...CC4, follow });
  assert.deepEqual(arr(unpackMap(map, { ...CC4, follow })), [20, 21, 99, 23]);
});

// ---- UI state ---------------------------------------------------------------

test("laneValuesFromMap: 0 means every lane still follows", () => {
  assert.deepEqual(arr(laneValuesFromMap(0, LANE_CH_FIELD, 4)), [null, null, null, null]);
  assert.deepEqual(arr(laneValuesFromMap(null, LANE_CC_FIELD, 4)), [null, null, null, null]);
});

test("laneValuesFromMap: a packed map becomes explicit lane values", () => {
  const map = packMap([2, 3, 4, 5], { ...CH4, follow: 1 });
  assert.deepEqual(arr(laneValuesFromMap(map, LANE_CH_FIELD, 4)), [2, 3, 4, 5]);
});

// ---- Grooves compatibility --------------------------------------------------

/** The pre-refactor implementation, kept verbatim as the reference. */
function legacyGroovesChMap(chs) {
  const list = Array.isArray(chs) ? chs : [];
  const base = Math.max(1, Math.min(16, Number(list[0]) || 1));
  if (Array.from({ length: 7 }).every((_, i) => (Number(list[i]) || base) === base)) return 0;
  return Array.from({ length: 7 }).reduce((acc, _, i) => {
    const ch = Math.max(1, Math.min(16, Number(list[i]) || base));
    return acc + ((ch - 1) << (4 * i));
  }, 0);
}

test("packMap matches the legacy Grooves Ch Map for every plausible kit", () => {
  const cases = [];
  for (let base = 1; base <= 16; base++) {
    cases.push(Array.from({ length: 7 }, () => base));
    cases.push(Array.from({ length: 7 }, (_, i) => Math.min(16, base + i)));
    cases.push(Array.from({ length: 7 }, (_, i) => (i % 2 ? base : Math.min(16, base + 3))));
  }
  cases.push([3, 3, 3]); // legacy short row: missing voices follow base
  for (const chs of cases) {
    const base = Math.max(1, Math.min(16, Number(chs[0]) || 1));
    assert.equal(
      packMap(chs, { ...CH7, follow: base }),
      legacyGroovesChMap(chs),
      `mismatch for ${JSON.stringify(chs)}`,
    );
  }
});
