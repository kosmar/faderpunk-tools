import test from "node:test";
import assert from "node:assert/strict";
import { serialize } from "@atov/fp-config";
import {
  connectDevice,
  disconnectDevice,
  isUsbWedgeError,
  USB_WEDGE_ERROR,
} from "../lib/device.js";
import { buildConfigFrame } from "../lib/sysex.js";
import {
  PANIC_BEACON_STATUS,
  PANIC_CC_MARKER,
  PANIC_CC_LINE_LO,
  PANIC_CC_LINE_HI,
  PANIC_CC_HASH_LO,
  PANIC_CC_HASH_MID,
  PANIC_CC_HASH_HI,
} from "../lib/panic-beacon.js";

function silentOutput() {
  let getVersionSends = 0;
  const output = {
    async open() {},
    send() {
      getVersionSends += 1;
    },
  };
  return { output, getCount: () => getVersionSends };
}

function silentInput(id, name) {
  return {
    id,
    name,
    manufacturer: "Faderpunk",
    onmidimessage: null,
    async open() {},
  };
}

function mockNavigator(inputs, outputs) {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      requestMIDIAccess: async () => ({
        inputs: new Map(inputs.map((port) => [port.id, port])),
        outputs: new Map(outputs.map((port) => [port.id, port])),
      }),
    },
  });
  return () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  };
}

test("connectDevice accepts a valid Version reply delayed beyond 300 ms", async () => {
  const input = {
    id: "config-in",
    name: "Faderpunk Config 2",
    manufacturer: "Faderpunk",
    onmidimessage: null,
    async open() {},
  };
  const versionFrame = buildConfigFrame(
    serialize("ConfigMsgOut", {
      tag: "Version",
      value: { major: 1, minor: 2, patch: 3 },
    }),
  );
  const output = {
    id: "config-out",
    name: "Faderpunk Config 2",
    manufacturer: "Faderpunk",
    async open() {},
    send() {
      setTimeout(() => {
        input.onmidimessage?.({ data: versionFrame });
      }, 450);
    },
  };
  const restoreNavigator = mockNavigator([input], [output]);

  let device;
  try {
    device = await connectDevice();
    assert.equal(device.config.version, "1.2.3");
  } finally {
    disconnectDevice(device);
    restoreNavigator();
  }
});

test("connectDevice: silent MIDI throws isUsbWedgeError with 6 GetVersion probes for 2×2 ports", async () => {
  const inA = silentInput("in-a", "Faderpunk Config 2");
  const inB = silentInput("in-b", "Faderpunk Config 1");
  const outA = silentInput("out-a", "Faderpunk Config 2");
  const outB = silentInput("out-b", "Faderpunk Config 1");
  const { output: silentOutA, getCount: countA } = silentOutput();
  const { output: silentOutB, getCount: countB } = silentOutput();
  Object.assign(outA, silentOutA);
  Object.assign(outB, silentOutB);

  const restoreNavigator = mockNavigator([inA, inB], [outA, outB]);
  const started = Date.now();

  try {
    await assert.rejects(connectDevice(), (err) => {
      assert.equal(isUsbWedgeError(err), true);
      assert.match(String(err.message), /GetVersion failed/);
      return true;
    });
    assert.equal(countA() + countB(), 6, "round 0: 4 pairs + rounds 1–2: top pair only");
    assert.ok(
      Date.now() - started < 12000,
      "should finish under ~12s, not 16s+ full cartesian",
    );
  } finally {
    restoreNavigator();
  }
});

test("connectDevice: panic beacon after failed connect includes firmware panic site", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config 2");
  const perfIn = silentInput("perf-in", "Faderpunk Performance");
  const configOut = silentInput("config-out", "Faderpunk Config 2");
  const { output: silentOut } = silentOutput();
  Object.assign(configOut, silentOut);

  const line = 42;
  const hash = 0x000abc;
  const beaconFrames = [
    [PANIC_BEACON_STATUS, PANIC_CC_MARKER, 127],
    [PANIC_BEACON_STATUS, PANIC_CC_LINE_LO, line & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_LINE_HI, (line >> 7) & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_HASH_LO, hash & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_HASH_MID, (hash >> 7) & 0x7f],
    [PANIC_BEACON_STATUS, PANIC_CC_HASH_HI, (hash >> 14) & 0x7f],
  ].map((f) => new Uint8Array(f));

  perfIn.open = async function openPerf() {
    setTimeout(() => {
      for (const frame of beaconFrames) {
        perfIn.onmidimessage?.({ data: frame });
      }
    }, 50);
  };

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut]);

  try {
    await assert.rejects(connectDevice(), (err) => {
      assert.equal(isUsbWedgeError(err), true);
      assert.match(String(err.message), /firmware panic at/);
      assert.match(String(err.message), /line 42/);
      return true;
    });
  } finally {
    restoreNavigator();
  }
});

test("isUsbWedgeError matches USB_WEDGE_ERROR and panic suffix", () => {
  assert.equal(isUsbWedgeError(new Error(USB_WEDGE_ERROR)), true);
  assert.equal(
    isUsbWedgeError(
      new Error(`${USB_WEDGE_ERROR} — firmware panic at foo.rs:1`),
    ),
    true,
  );
  assert.equal(isUsbWedgeError(new Error("No Faderpunk config MIDI port found")), false);
});
