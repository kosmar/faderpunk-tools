import { deserialize, serialize } from "@atov/fp-config";
import { buildConfigFrame, parseConfigFrame, SYSEX_EOX, SYSEX_START } from "./sysex.js";
import {
  createPanicBeaconCollector,
  formatPanicSite,
} from "./panic-beacon.js";

const RECEIVE_TIMEOUT_MS = 2000;
const BATCH_SLICE_TIMEOUT_MS = 5000;
const SYSEX_DEDUPE_MS = 100;
// The device can answer slowly while app tasks are spawning or immediately
// after USB reconnect. 300 ms caused valid config ports to be rejected.
const PROBE_TIMEOUT_MS = 1200;
/** After a wedged Full Push, GetVersion often needs a few retries. */
const CONNECT_PROBE_ROUNDS = 3;
const CONNECT_PROBE_GAP_MS = 700;
const PANIC_BEACON_LISTEN_MS = 2500;
const PANIC_BEACON_POLL_MS = 100;

/** Thrown when Faderpunk ports are listed but GetVersion never answers. */
export const USB_WEDGE_ERROR =
  "Faderpunk MIDI ports present but GetVersion failed (device busy or USB wedged). Wait / replug; close other tabs using the device.";

export function isUsbWedgeError(err) {
  const msg = String(err?.message ?? err ?? "");
  return msg.includes(USB_WEDGE_ERROR);
}

async function loadPanicFiles() {
  try {
    const response = await fetch(new URL("../panic-files.json", import.meta.url));
    const json = await response.json();
    return json?.files ?? {};
  } catch {
    return {};
  }
}

async function listenForPanicBeacon(access, configInput) {
  const input = findPerfInput(access, configInput);
  if (!input) return null;

  const collector = createPanicBeaconCollector();
  const previous = input.onmidimessage;
  try {
    await Promise.race([
      input.open(),
      new Promise((r) => setTimeout(r, PANIC_BEACON_LISTEN_MS)),
    ]);
    input.onmidimessage = (event) => collector.feed(event.data);
    const deadline = Date.now() + PANIC_BEACON_LISTEN_MS;
    while (Date.now() < deadline && collector.result() === null) {
      await new Promise((r) => setTimeout(r, PANIC_BEACON_POLL_MS));
    }
  } finally {
    input.onmidimessage = previous ?? null;
  }
  return collector.result();
}

function createSharedRx() {
  return {
    queue: [],
    waiter: null,
    appStates: new Map(),
    lastDedupePayload: null,
    lastDedupeTime: 0,
    lastSourceInput: null,
  };
}

function payloadsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isDuplicatePayload(rx, payload) {
  const now = Date.now();
  if (
    rx.lastDedupePayload &&
    now - rx.lastDedupeTime < SYSEX_DEDUPE_MS &&
    payloadsEqual(rx.lastDedupePayload, payload)
  ) {
    return true;
  }
  rx.lastDedupePayload = payload;
  rx.lastDedupeTime = now;
  return false;
}

function deliverMessage(rx, input, msg) {
  rx.lastSourceInput = input;
  if (msg?.tag === "AppState") {
    const layoutId = Number(msg.value?.[0]);
    const values = msg.value?.[1];
    if (Number.isFinite(layoutId) && Array.isArray(values) && values.length > 0) {
      rx.appStates.set(layoutId, msg);
    }
  }
  if (rx.waiter) {
    const { resolve, timer } = rx.waiter;
    clearTimeout(timer);
    rx.waiter = null;
    resolve(msg);
  } else {
    rx.queue.push(msg);
  }
}

function attachInputToSharedRx(input, rx) {
  const local = { sysexBuffer: [], collecting: false };

  input.onmidimessage = (event) => {
    if (!event.data || event.data.length === 0) return;
    const data = event.data;
    const first = data[0];

    if (first !== SYSEX_START) {
      if (first < 0xf0 || first === 0xf8 || first === 0xfa || first === 0xfb || first === 0xfc || first === 0xff) {
        return;
      }
    }

    for (const byte of data) {
      if (byte === SYSEX_START) {
        local.sysexBuffer = [byte];
        local.collecting = true;
        continue;
      }
      if (!local.collecting) continue;
      local.sysexBuffer.push(byte);
      if (byte === SYSEX_EOX) {
        local.collecting = false;
        const payload = parseConfigFrame(new Uint8Array(local.sysexBuffer));
        local.sysexBuffer = [];
        if (!payload) continue;
        if (isDuplicatePayload(rx, payload)) continue;
        let msg;
        try {
          msg = deserialize("ConfigMsgOut", payload).value;
        } catch (err) {
          console.error("Failed to deserialize config message:", err);
          continue;
        }
        deliverMessage(rx, input, msg);
      }
    }
  };
}

function receiveFromRx(rx, timeoutMs) {
  const queued = rx.queue.shift();
  if (queued) return Promise.resolve(queued);
  if (rx.waiter) {
    return Promise.reject(new Error("Concurrent receive on the same MIDI device"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rx.waiter = null;
      reject(new Error("Timed out waiting for device response"));
    }, timeoutMs);
    rx.waiter = { resolve, reject, timer };
  });
}

function sendFrame(output, msg) {
  output.send(Array.from(buildConfigFrame(serialize("ConfigMsgIn", msg))));
}

function configProbeOutputs(outputs) {
  const namedConfig = outputs.filter((port) => /config/i.test(port.name ?? ""));
  if (namedConfig.length) return namedConfig;
  const fallback = outputs.filter((port) => /config|2/i.test(port.name ?? ""));
  if (fallback.length) return fallback;
  return outputs;
}

function detachInputHandlers(handlers) {
  for (const { input, rx } of handlers) {
    input.onmidimessage = null;
    if (rx.waiter) {
      clearTimeout(rx.waiter.timer);
      rx.waiter = null;
    }
  }
}

/** Wait for Version on shared rx. Arm this before TX so a fast reply is not missed. */
async function waitForVersion(sharedRx, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const msg = await receiveFromRx(
        sharedRx,
        Math.max(200, deadline - Date.now()),
      );
      if (msg?.tag === "Version") {
        const { major, minor, patch } = msg.value;
        return {
          input: sharedRx.lastSourceInput,
          rx: sharedRx,
          version: `${major}.${minor}.${patch}`,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function portCandidates(ports) {
  const candidates = Array.from(ports).filter((port) =>
    /faderpunk/i.test(`${port.manufacturer ?? ""} ${port.name ?? ""}`),
  );
  return candidates.sort((a, b) => {
    const rank = (port) => (/config|2/i.test(port.name ?? "") ? 0 : 1);
    return rank(a) - rank(b);
  });
}

/** True if Web MIDI still lists any Faderpunk ports (config or perf). */
export function faderpunkPortsListed(access) {
  if (!access) return false;
  return (
    portCandidates(access.inputs.values()).length > 0 &&
    portCandidates(access.outputs.values()).length > 0
  );
}

/** Faderpunk input that is not the config port — where the perf MIDI (and the panic beacon) arrives. */
export function findPerfInput(access, configInput) {
  if (!access) return null;
  for (const port of portCandidates(access.inputs.values())) {
    if (port === configInput) continue;
    if (configInput?.id != null && port.id === configInput.id) continue;
    return port;
  }
  return null;
}

/** Connect to Faderpunk config SysEx port (Web MIDI). */
export async function connectDevice() {
  if (!navigator.requestMIDIAccess) {
    throw new Error("Web MIDI is not supported in this browser");
  }
  const access = await navigator.requestMIDIAccess({ sysex: true });
  const inputs = portCandidates(access.inputs.values());
  const outputs = portCandidates(access.outputs.values());

  const sawPorts = inputs.length > 0 && outputs.length > 0;
  const inNames = inputs.map((i) => i.name ?? i.id).join(", ");
  const outNames = outputs.map((o) => o.name ?? o.id).join(", ");
  const connectionSummary = `in[${inNames}] · out[${outNames}]`;

  const probeOutputs = configProbeOutputs(outputs);
  const probeOutput = probeOutputs[0] ?? null;

  const sharedRx = createSharedRx();
  const inputHandlers = [];
  for (const input of inputs) {
    attachInputToSharedRx(input, sharedRx);
    await input.open();
    inputHandlers.push({ input, rx: sharedRx });
  }

  let config = null;
  if (probeOutput && inputHandlers.length) {
    for (let round = 0; round < CONNECT_PROBE_ROUNDS && !config; round++) {
      if (round > 0) {
        await new Promise((r) => setTimeout(r, CONNECT_PROBE_GAP_MS * round));
      }
      await probeOutput.open();
      // Waiters must be armed before TX — Version can arrive on a different
      // input than the Config-named one (fp-cli: RX Faderpunk / TX Config).
      drainConfigQueue(sharedRx);
      const waitPromise = waitForVersion(sharedRx, PROBE_TIMEOUT_MS);
      sendFrame(probeOutput, { tag: "GetVersion" });
      const result = await waitPromise;
      if (result) {
        config = {
          input: result.input,
          inputs,
          output: probeOutput,
          version: result.version,
          rx: sharedRx,
        };
      }
    }
  }

  if (!config) {
    detachInputHandlers(inputHandlers);
    if (!sawPorts) {
      throw new Error(
        "No Faderpunk config MIDI port found. Plug in USB, allow MIDI/SysEx, close other tabs using the device.",
      );
    }
    let message = `${USB_WEDGE_ERROR} (connection: ${connectionSummary})`;
    const site = await listenForPanicBeacon(access, inputs[0] ?? null);
    if (site) {
      const files = await loadPanicFiles();
      const siteText = formatPanicSite(site, files);
      if (siteText) {
        message = `${USB_WEDGE_ERROR} (connection: ${connectionSummary}) — firmware panic at ${siteText}`;
      }
    }
    throw new Error(message);
  }

  return {
    access,
    config,
    portSummary: connectionSummary,
  };
}

export function disconnectDevice(device) {
  if (!device?.config) return;
  const inputs =
    device.config.inputs ??
    (device.config.input ? [device.config.input] : []);
  for (const input of inputs) {
    if (input) input.onmidimessage = null;
  }
  if (device.config.rx?.waiter) {
    clearTimeout(device.config.rx.waiter.timer);
    device.config.rx.waiter = null;
  }
}

/** Drop unmatched config replies so the next request/response pair stays aligned. */
export function drainConfigQueue(rx) {
  if (rx?.queue) {
    rx.queue.length = 0;
  }
}

export function clearCachedAppStates(rx) {
  rx?.appStates?.clear();
}

/** Drop one layout slot from passive AppState cache (stale after SetAppParams timeout). */
export function clearCachedAppState(rx, layoutId) {
  rx?.appStates?.delete(Number(layoutId));
}

export function cachedAppState(rx, layoutId) {
  return rx?.appStates?.get(Number(layoutId)) ?? null;
}

export async function sendAndReceive(config, msg) {
  sendFrame(config.output, msg);
  return receiveFromRx(config.rx, RECEIVE_TIMEOUT_MS);
}

/**
 * Like sendAndReceive, but keep reading until `expectedTag` (or timeout).
 * Skips stray Layout/AppState from Diagnostics soft-poll or late acks.
 * When `matchLayoutId` is set and expecting AppState, also skip AppStates
 * for other layout slots (stale reply from previous Set/Get).
 */
export async function sendAndReceiveExpect(config, msg, expectedTag, opts = {}) {
  const log = opts.onLog || (() => {});
  const attempts = opts.attempts ?? 8;
  const timeoutMs = opts.timeoutMs ?? RECEIVE_TIMEOUT_MS;
  const matchLayoutId =
    opts.matchLayoutId == null ? null : Number(opts.matchLayoutId);
  drainConfigQueue(config.rx);
  sendFrame(config.output, msg);
  // Total wait window. Per-slice receive uses timeoutMs; silence must not abort
  // early — SetAppParams can spend >15s in FRAM/respawn before AppState.
  const deadline =
    Date.now() +
    (opts.deadlineMs ?? timeoutMs * Math.max(1, Math.ceil(attempts / 2)));
  let lastTag = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(200, deadline - Date.now());
    let response;
    try {
      response = await receiveFromRx(config.rx, Math.min(timeoutMs, remaining));
    } catch (e) {
      const timedOut = /timed out/i.test(String(e.message || e));
      if (timedOut && Date.now() < deadline) {
        drainConfigQueue(config.rx);
        sendFrame(config.output, msg);
        continue;
      }
      if (lastTag) {
        throw new Error(
          `Expected ${expectedTag}, last stray was ${lastTag} (${e.message || e})`,
        );
      }
      throw e;
    }
    if (response.tag === expectedTag) {
      if (
        matchLayoutId != null &&
        expectedTag === "AppState" &&
        Number(response.value?.[0]) !== matchLayoutId
      ) {
        log(
          `  ↷ skip AppState layoutId=${response.value?.[0]} (want ${matchLayoutId})`,
        );
        continue;
      }
      return response;
    }
    lastTag = response.tag;
    log(`  ↷ skip stray ${response.tag} (want ${expectedTag})`);
  }
  throw new Error(
    `Expected ${expectedTag}, got ${lastTag ?? "timeout"} — close Diagnostics/Configurator on the config MIDI cable`,
  );
}

export async function sendMessage(config, msg) {
  sendFrame(config.output, msg);
}

export async function receiveBatchMessages(config, count, opts = {}) {
  const results = [];
  const n = Number(count);
  const sliceMs = opts.sliceTimeoutMs ?? BATCH_SLICE_TIMEOUT_MS;
  const deadline =
    Date.now() +
    (opts.deadlineMs ?? RECEIVE_TIMEOUT_MS * Math.max(4, n + 2));
  while (results.length < n && Date.now() < deadline) {
    const remaining = Math.max(300, deadline - Date.now());
    let msg;
    try {
      msg = await receiveFromRx(
        config.rx,
        Math.min(sliceMs, remaining),
      );
    } catch (e) {
      // FW may abort mid-batch (AppConfig EncodingError / BufferTooSmall) and
      // never send BatchMsgEnd — keep what arrived so Push can continue.
      if (/timed out/i.test(String(e.message || e)) && results.length > 0) {
        return results;
      }
      throw e;
    }
    if (msg.tag === "BatchMsgEnd") {
      // Early end — return what we have (caller may fill gaps).
      return results;
    }
    // GetAllApps → AppConfig; GetAllAppParams → AppState. Accept both.
    // Skip stray Layout / Version / GlobalConfig from other tabs.
    if (msg.tag === "AppConfig" || msg.tag === "AppState") {
      results.push(msg);
      continue;
    }
    continue;
  }
  if (results.length < n) {
    if (results.length > 0) return results;
    throw new Error(
      `Batch incomplete: got ${results.length}/${n} items (timeout or cable noise)`,
    );
  }
  const endDeadline = Date.now() + (opts.endTimeoutMs ?? RECEIVE_TIMEOUT_MS);
  while (Date.now() < endDeadline) {
    try {
      const endMessage = await receiveFromRx(
        config.rx,
        Math.max(200, endDeadline - Date.now()),
      );
      if (endMessage.tag === "BatchMsgEnd") return results;
    } catch (e) {
      if (/timed out/i.test(String(e.message || e))) break;
      throw e;
    }
  }
  // Full item count without BatchMsgEnd is still usable.
  return results;
}
