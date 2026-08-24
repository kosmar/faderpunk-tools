import { test } from "node:test";
import assert from "node:assert/strict";
import {
  packDitDahPhrase,
  unpackDitDahPhrase,
  DIT_DAH_DEFAULT_PACK0,
  DIT_DAH_PHRASE_MAX,
  DIT_DAH_PHRASE_PACKS,
} from "../lib/dit-dah-phrase.js";

test("SOS matches firmware DEFAULT_PHRASE_0", () => {
  const packs = packDitDahPhrase("SOS");
  assert.equal(packs[0], DIT_DAH_DEFAULT_PACK0);
  assert.equal(packs.length, DIT_DAH_PHRASE_PACKS);
  assert.ok(packs.slice(1).every((n) => n === 0));
  assert.equal(unpackDitDahPhrase(packs), "SOS");
});

test("lowercase folds to ITU letters", () => {
  assert.equal(unpackDitDahPhrase(packDitDahPhrase("sos")), "SOS");
});

test("spaces survive (word gap)", () => {
  assert.equal(unpackDitDahPhrase(packDitDahPhrase("CQ CQ")), "CQ CQ");
});

test("truncates at the 9-pack byte budget", () => {
  const long = "A".repeat(50);
  const packs = packDitDahPhrase(long);
  assert.equal(DIT_DAH_PHRASE_MAX, DIT_DAH_PHRASE_PACKS * 4);
  assert.equal(unpackDitDahPhrase(packs).length, DIT_DAH_PHRASE_MAX);
});

test("round-trip via schema-shaped i32 values", () => {
  const packed = packDitDahPhrase("HELLO 73");
  const schema = packed.map((value) => ({ tag: "i32", value }));
  assert.equal(unpackDitDahPhrase(schema), "HELLO 73");
});
