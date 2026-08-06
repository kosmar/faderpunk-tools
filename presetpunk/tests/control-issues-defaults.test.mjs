import test from "node:test";
import assert from "node:assert/strict";
import {
  healCollapsedCcWindow,
  controlIssuesButtonBlinkEligible,
  healControlIssuesSchemaValues,
} from "../lib/control-issues-defaults.js";

test("mid-default 64/64 collapses and kills button blink eligibility", () => {
  // Firmware: scale_to_window with lo===hi returns lo → never > out_lo.
  const outLo = 64;
  const windowed = 64;
  assert.equal(controlIssuesButtonBlinkEligible(windowed, outLo), false);
});

test("full 0–127 window allows blink when signal above floor", () => {
  assert.equal(controlIssuesButtonBlinkEligible(1, 0), true);
  assert.equal(controlIssuesButtonBlinkEligible(0, 0), false);
});

test("healCollapsedCcWindow expands classic 64/64 mid defaults", () => {
  assert.deepEqual(healCollapsedCcWindow(64, 64), {
    min: 0,
    max: 127,
    healed: true,
  });
});

test("healCollapsedCcWindow leaves intentional windows alone", () => {
  assert.deepEqual(healCollapsedCcWindow(0, 127), {
    min: 0,
    max: 127,
    healed: false,
  });
  assert.deepEqual(healCollapsedCcWindow(10, 10), {
    min: 10,
    max: 10,
    healed: false,
  });
});

test("healControlIssuesSchemaValues rewrites Output Min/Max 64/64 in schema", () => {
  const params = [
    { tag: "i32", value: { name: "Steps", min: 0, max: 128 } },
    { tag: "i32", value: { name: "Output Min", min: 0, max: 127 } },
    { tag: "i32", value: { name: "Output Max", min: 0, max: 127 } },
  ];
  const schema = [
    { tag: "i32", value: 0 },
    { tag: "i32", value: 64 },
    { tag: "i32", value: 64 },
  ];
  assert.equal(healControlIssuesSchemaValues(params, schema), true);
  assert.deepEqual(schema[1], { tag: "i32", value: 0 });
  assert.deepEqual(schema[2], { tag: "i32", value: 127 });
  // Blink eligible again for any signal above floor.
  assert.equal(controlIssuesButtonBlinkEligible(1, schema[1].value), true);
});
