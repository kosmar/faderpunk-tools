import test from "node:test";
import assert from "node:assert/strict";
import { serialize } from "@atov/fp-config";
import { connectDevice, disconnectDevice } from "../lib/device.js";
import { buildConfigFrame } from "../lib/sysex.js";

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
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      requestMIDIAccess: async () => ({
        inputs: new Map([[input.id, input]]),
        outputs: new Map([[output.id, output]]),
      }),
    },
  });

  let device;
  try {
    device = await connectDevice();
    assert.equal(device.config.version, "1.2.3");
  } finally {
    disconnectDevice(device);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }
});
