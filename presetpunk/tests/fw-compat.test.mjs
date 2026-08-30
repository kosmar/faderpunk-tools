import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_FIRMWARE_LABEL,
  assertFirmwareSupported,
  isFirmwareTooOld,
  isFirmwareTooOldError,
  parseFwVersion,
} from "../lib/fw-compat.js";

test("1.11.0 is too old; 1.12.0 and betas are not", () => {
  assert.equal(isFirmwareTooOld("1.11.0"), true);
  assert.equal(isFirmwareTooOld("1.10.1"), true);
  assert.equal(isFirmwareTooOld("1.12.0"), false);
  assert.equal(isFirmwareTooOld("1.12.0-beta.0"), false);
  assert.equal(isFirmwareTooOld("1.12.0-beta.1"), false);
  assert.equal(isFirmwareTooOld("1.13.0"), false);
});

test("unparseable version is too old", () => {
  assert.equal(isFirmwareTooOld(""), true);
  assert.equal(isFirmwareTooOld("n/a"), true);
  assert.equal(parseFwVersion("1.12.0-beta.1")?.minor, 12);
});

test("assertFirmwareSupported throws a tagged error", () => {
  assert.throws(
    () => assertFirmwareSupported("1.11.0"),
    (err) => {
      assert.equal(isFirmwareTooOldError(err), true);
      assert.match(err.message, /1\.11\.0/);
      assert.equal(err.need, MIN_FIRMWARE_LABEL);
      return true;
    },
  );
  assert.doesNotThrow(() => assertFirmwareSupported("1.12.0"));
});
