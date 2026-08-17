import { test } from "node:test";
import assert from "node:assert/strict";
import {
  packEcholotMidiMap,
  unpackEcholotMidiMap,
  echolotMidiMapPacked,
  ECHOLOT_MIDI_MAP_MAX,
} from "../lib/echolot-midi-map.js";

test("pack/unpack round-trip", () => {
  const map = packEcholotMidiMap(1, 74, 60, 72);
  assert.equal(map, 1 | (74 << 7) | (60 << 14) | (72 << 21));
  assert.deepEqual(unpackEcholotMidiMap(map), {
    pingCc: 1,
    pongCc: 74,
    pingNote: 60,
    pongNote: 72,
  });
});

test("unpack: 0 → null (uninitialized)", () => {
  assert.equal(unpackEcholotMidiMap(0), null);
});

test("max packed value fits contract", () => {
  const map = packEcholotMidiMap(127, 127, 127, 127);
  assert.equal(map, ECHOLOT_MIDI_MAP_MAX);
});

test("echolotMidiMapPacked: single copies pong slots", () => {
  const map = echolotMidiMapPacked(
    { pingCc: 10, pongCc: 99, pingNote: 48, pongNote: 50, cc: 10, note: 48 },
    false,
  );
  assert.deepEqual(unpackEcholotMidiMap(map), {
    pingCc: 10,
    pongCc: 10,
    pingNote: 48,
    pongNote: 48,
  });
});
