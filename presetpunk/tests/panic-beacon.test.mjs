import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPanicBeaconCollector,
  formatPanicSite,
  PANIC_BEACON_STATUS,
  PANIC_CC_MARKER,
  PANIC_CC_LINE_LO,
  PANIC_CC_LINE_HI,
  PANIC_CC_HASH_LO,
  PANIC_CC_HASH_MID,
  PANIC_CC_HASH_HI,
} from "../lib/panic-beacon.js";

const LINE = 1234;
const HASH = 0x1817ed;

function beaconFrames(line, hash) {
  return [
    [PANIC_BEACON_STATUS, PANIC_CC_MARKER, 127],
    [PANIC_BEACON_STATUS, PANIC_CC_LINE_LO, line & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_LINE_HI, (line >> 7) & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_HASH_LO, hash & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_HASH_MID, (hash >> 7) & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_HASH_HI, (hash >> 14) & 0x7f],
  ].map((f) => new Uint8Array(f));
}

test("result: null until the marker CC was seen", () => {
  const collector = createPanicBeaconCollector();
  assert.equal(collector.result(), null);
  for (const frame of beaconFrames(LINE, HASH).slice(1)) collector.feed(frame);
  assert.equal(collector.result(), null);
});

test("full frame set → line and hash", () => {
  const collector = createPanicBeaconCollector();
  for (const frame of beaconFrames(LINE, HASH)) collector.feed(frame);
  assert.deepEqual(collector.result(), { line: LINE, hash: HASH });
});

test("plain arrays feed like Uint8Array", () => {
  const collector = createPanicBeaconCollector();
  for (const frame of beaconFrames(LINE, HASH)) collector.feed(Array.from(frame));
  assert.deepEqual(collector.result(), { line: LINE, hash: HASH });
});

test("foreign messages are ignored", () => {
  const collector = createPanicBeaconCollector();
  collector.feed([0xb0, PANIC_CC_MARKER, 127]); // CC on channel 1
  collector.feed([0x9f, PANIC_CC_MARKER, 127]); // Note-On on channel 16
  collector.feed([PANIC_BEACON_STATUS, 7, 100]); // unrelated CC
  assert.equal(collector.result(), null);

  for (const frame of beaconFrames(LINE, HASH)) collector.feed(frame);
  collector.feed([PANIC_BEACON_STATUS, 74, 0]);
  collector.feed([0xbf, PANIC_CC_LINE_LO - 20, 99]);
  assert.deepEqual(collector.result(), { line: LINE, hash: HASH });
});

test("formatPanicSite: hit in table → path:line", () => {
  const files = { "1817ed": "faderpunk/src/apps/echolot.rs" };
  assert.equal(
    formatPanicSite({ line: LINE, hash: HASH }, files),
    "faderpunk/src/apps/echolot.rs:1234",
  );
});

test("formatPanicSite: miss → hex hash fallback", () => {
  assert.equal(
    formatPanicSite({ line: LINE, hash: HASH }, {}),
    "unknown source (hash 0x1817ed) line 1234",
  );
  assert.equal(
    formatPanicSite({ line: 7, hash: 0x000abc }, undefined),
    "unknown source (hash 0x000abc) line 7",
  );
});

test("formatPanicSite: null site → null", () => {
  assert.equal(formatPanicSite(null, { "1817ed": "x.rs" }), null);
});
