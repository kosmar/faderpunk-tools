import test from "node:test";
import assert from "node:assert/strict";
import { serialize } from "@atov/fp-config";
import {
  connectDevice,
  disconnectDevice,
  findPerfInput,
  isUsbWedgeError,
  receiveBatchMessages,
  sendAndReceiveExpect,
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

const CONNECT_PROBE_ROUNDS = 3;

function countingOutput(base = {}) {
  let sends = 0;
  const output = {
    ...base,
    async open() {},
    send() {
      sends += 1;
    },
    getSendCount: () => sends,
  };
  return output;
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
  const hadNavigator = "navigator" in globalThis;
  const originalNavigator = globalThis.navigator;
  const mock = {
    requestMIDIAccess: async () => ({
      inputs: new Map(inputs.map((port) => [port.id, port])),
      outputs: new Map(outputs.map((port) => [port.id, port])),
    }),
  };
  globalThis.navigator = mock;
  return () => {
    if (hadNavigator) {
      globalThis.navigator = originalNavigator;
    } else {
      delete globalThis.navigator;
    }
  };
}

test("connectDevice: split RX/TX — Version on Faderpunk in, GetVersion on Config out only", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const versionFrame = buildConfigFrame(
    serialize("ConfigMsgOut", {
      tag: "Version",
      value: { major: 2, minor: 0, patch: 1 },
    }),
  );

  let configSends = 0;
  const configOut = {
    id: "config-out",
    name: "Faderpunk Config",
    manufacturer: "Faderpunk",
    async open() {},
    send() {
      configSends += 1;
      setTimeout(() => {
        perfIn.onmidimessage?.({ data: versionFrame });
      }, 50);
    },
  };
  const perfOut = countingOutput({
    id: "perf-out",
    name: "Faderpunk",
    manufacturer: "Faderpunk",
  });

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut, perfOut]);

  let device;
  try {
    device = await connectDevice();
    assert.equal(device.config.version, "2.0.1");
    assert.equal(device.config.input.name, "Faderpunk");
    assert.equal(device.config.output.name, "Faderpunk Config");
    assert.equal(configSends, 1, "one GetVersion on Config out");
    assert.equal(perfOut.getSendCount(), 0, "no sends on Faderpunk perf out");
    assert.ok(
      typeof configIn.onmidimessage === "function",
      "Config input handler kept after connect",
    );
    assert.ok(
      typeof perfIn.onmidimessage === "function",
      "Perf input handler kept after connect",
    );
  } finally {
    disconnectDevice(device);
    restoreNavigator();
  }
});

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

test("connectDevice: silent split ports throws isUsbWedgeError with CONNECT_PROBE_ROUNDS sends", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const configOut = countingOutput({
    id: "config-out",
    name: "Faderpunk Config",
    manufacturer: "Faderpunk",
  });
  const perfOut = countingOutput({
    id: "perf-out",
    name: "Faderpunk",
    manufacturer: "Faderpunk",
  });

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut, perfOut]);
  const started = Date.now();

  try {
    await assert.rejects(connectDevice(), (err) => {
      assert.equal(isUsbWedgeError(err), true);
      assert.match(String(err.message), /GetVersion failed/);
      assert.match(String(err.message), /Faderpunk Config/);
      assert.match(String(err.message), /connection:/);
      return true;
    });
    assert.equal(
      configOut.getSendCount(),
      CONNECT_PROBE_ROUNDS,
      "GetVersion retries on Config out only",
    );
    assert.equal(perfOut.getSendCount(), 0, "no sends on Faderpunk perf out");
    assert.ok(
      Date.now() - started < 15000,
      "should finish under ~15s (retries + panic listen), not full cartesian",
    );
  } finally {
    restoreNavigator();
  }
});

test("connectDevice: panic beacon after failed connect includes firmware panic site", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config 2");
  const perfIn = silentInput("perf-in", "Faderpunk Performance");
  const configOut = countingOutput({
    id: "config-out",
    name: "Faderpunk Config 2",
    manufacturer: "Faderpunk",
  });

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

test("findPerfInput prefers non-Config name when Version used Faderpunk in", () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const access = {
    inputs: new Map([
      [configIn.id, configIn],
      [perfIn.id, perfIn],
    ]),
  };
  // After connect, config.input is often the Version winner (“Faderpunk”).
  assert.equal(findPerfInput(access, perfIn), perfIn);
  assert.equal(findPerfInput(access, configIn), perfIn);
});

const minimalAppConfig = {
  tag: "AppConfig",
  value: [
    0,
    1n,
    [0n, "TestApp", "", { tag: "White" }, { tag: "Fader" }, []],
  ],
};

test("GetAllApps fan-in: BatchMsgStart on Config, AppConfig on Config port", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const versionFrame = buildConfigFrame(
    serialize("ConfigMsgOut", {
      tag: "Version",
      value: { major: 1, minor: 12, patch: 0 },
    }),
  );
  const batchStartFrame = buildConfigFrame(
    serialize("ConfigMsgOut", { tag: "BatchMsgStart", value: 1n }),
  );
  const appConfigFrame = buildConfigFrame(
    serialize("ConfigMsgOut", minimalAppConfig),
  );
  const batchEndFrame = buildConfigFrame(
    serialize("ConfigMsgOut", { tag: "BatchMsgEnd" }),
  );

  let connectPhase = true;
  const configOut = {
    id: "config-out",
    name: "Faderpunk Config",
    manufacturer: "Faderpunk",
    async open() {},
    send() {
      if (connectPhase) {
        connectPhase = false;
        setTimeout(() => {
          perfIn.onmidimessage?.({ data: versionFrame });
        }, 10);
        return;
      }
      setTimeout(() => {
        configIn.onmidimessage?.({ data: batchStartFrame });
        setTimeout(() => {
          configIn.onmidimessage?.({ data: appConfigFrame });
          setTimeout(() => {
            configIn.onmidimessage?.({ data: batchEndFrame });
          }, 10);
        }, 10);
      }, 10);
    },
  };

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut]);

  let device;
  try {
    device = await connectDevice();
    assert.equal(device.config.version, "1.12.0");

    const batchStart = await sendAndReceiveExpect(
      device.config,
      { tag: "GetAllApps" },
      "BatchMsgStart",
      { timeoutMs: 2000 },
    );
    assert.equal(batchStart.tag, "BatchMsgStart");
    assert.equal(Number(batchStart.value), 1);

    const apps = await receiveBatchMessages(device.config, 1);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].tag, "AppConfig");
    assert.equal(apps[0].value[2][1], "TestApp");
  } finally {
    disconnectDevice(device);
    restoreNavigator();
  }
});

test("duplicate identical SysEx on both inputs is counted once", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const versionFrame = buildConfigFrame(
    serialize("ConfigMsgOut", {
      tag: "Version",
      value: { major: 1, minor: 0, patch: 0 },
    }),
  );
  const batchStartFrame = buildConfigFrame(
    serialize("ConfigMsgOut", { tag: "BatchMsgStart", value: 1n }),
  );
  const appConfigFrame = buildConfigFrame(
    serialize("ConfigMsgOut", minimalAppConfig),
  );
  const batchEndFrame = buildConfigFrame(
    serialize("ConfigMsgOut", { tag: "BatchMsgEnd" }),
  );

  let connectPhase = true;
  const configOut = {
    id: "config-out",
    name: "Faderpunk Config",
    manufacturer: "Faderpunk",
    async open() {},
    send() {
      if (connectPhase) {
        connectPhase = false;
        setTimeout(() => {
          perfIn.onmidimessage?.({ data: versionFrame });
        }, 10);
        return;
      }
      setTimeout(() => {
        configIn.onmidimessage?.({ data: batchStartFrame });
        perfIn.onmidimessage?.({ data: batchStartFrame });
        setTimeout(() => {
          configIn.onmidimessage?.({ data: appConfigFrame });
          perfIn.onmidimessage?.({ data: appConfigFrame });
          setTimeout(() => {
            configIn.onmidimessage?.({ data: batchEndFrame });
          }, 10);
        }, 10);
      }, 10);
    },
  };

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut]);

  let device;
  try {
    device = await connectDevice();

    const batchStart = await sendAndReceiveExpect(
      device.config,
      { tag: "GetAllApps" },
      "BatchMsgStart",
      { timeoutMs: 2000 },
    );
    assert.equal(Number(batchStart.value), 1);

    const apps = await receiveBatchMessages(device.config, 1);
    assert.equal(apps.length, 1, "mirrored frame counted once");
  } finally {
    disconnectDevice(device);
    restoreNavigator();
  }
});

test("disconnectDevice clears onmidimessage on all inputs", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const versionFrame = buildConfigFrame(
    serialize("ConfigMsgOut", {
      tag: "Version",
      value: { major: 1, minor: 0, patch: 0 },
    }),
  );
  const configOut = {
    id: "config-out",
    name: "Faderpunk Config",
    manufacturer: "Faderpunk",
    async open() {},
    send() {
      setTimeout(() => {
        perfIn.onmidimessage?.({ data: versionFrame });
      }, 10);
    },
  };

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut]);

  let device;
  try {
    device = await connectDevice();
    assert.ok(typeof configIn.onmidimessage === "function");
    assert.ok(typeof perfIn.onmidimessage === "function");
    disconnectDevice(device);
    assert.equal(configIn.onmidimessage, null);
    assert.equal(perfIn.onmidimessage, null);
  } finally {
    restoreNavigator();
  }
});

test("receiveBatchMessages keeps partial batch when FW aborts without BatchMsgEnd", async () => {
  const configIn = silentInput("config-in", "Faderpunk Config");
  const perfIn = silentInput("perf-in", "Faderpunk");
  const versionFrame = buildConfigFrame(
    serialize("ConfigMsgOut", {
      tag: "Version",
      value: { major: 1, minor: 0, patch: 0 },
    }),
  );
  const batchStartFrame = buildConfigFrame(
    serialize("ConfigMsgOut", { tag: "BatchMsgStart", value: 2n }),
  );
  const appConfigFrame = buildConfigFrame(
    serialize("ConfigMsgOut", minimalAppConfig),
  );

  let connectPhase = true;
  const configOut = {
    id: "config-out",
    name: "Faderpunk Config",
    manufacturer: "Faderpunk",
    async open() {},
    send() {
      if (connectPhase) {
        connectPhase = false;
        setTimeout(() => {
          perfIn.onmidimessage?.({ data: versionFrame });
        }, 10);
        return;
      }
      // BatchMsgStart(2) + one AppConfig, then silence (no #2, no BatchMsgEnd).
      setTimeout(() => {
        configIn.onmidimessage?.({ data: batchStartFrame });
        setTimeout(() => {
          configIn.onmidimessage?.({ data: appConfigFrame });
        }, 10);
      }, 10);
    },
  };

  const restoreNavigator = mockNavigator([configIn, perfIn], [configOut]);

  let device;
  try {
    device = await connectDevice();
    const batchStart = await sendAndReceiveExpect(
      device.config,
      { tag: "GetAllApps" },
      "BatchMsgStart",
      { timeoutMs: 2000 },
    );
    assert.equal(Number(batchStart.value), 2);
    const apps = await receiveBatchMessages(device.config, 2, {
      sliceTimeoutMs: 150,
      deadlineMs: 400,
      endTimeoutMs: 50,
    });
    assert.equal(apps.length, 1, "partial batch returned");
    assert.equal(apps[0].tag, "AppConfig");
  } finally {
    disconnectDevice(device);
    restoreNavigator();
  }
});
