import {
  cachedAppState,
  clearCachedAppState,
  clearCachedAppStates,
  connectDevice,
  disconnectDevice,
  drainConfigQueue,
  findPerfInput,
  receiveBatchMessages,
  sendAndReceive,
  sendAndReceiveExpect,
  sendMessage,
  waitForOptionalTag,
} from "./device.js";
import {
  createPanicBeaconCollector,
  formatPanicSite,
} from "./panic-beacon.js";
import { assertFirmwareSupported } from "./fw-compat.js";

async function connectSupportedDevice() {
  const device = await connectDevice();
  try {
    assertFirmwareSupported(device.config.version);
  } catch (err) {
    disconnectDevice(device);
    throw err;
  }
  return device;
}

/** Live app swap / row edit — one (or few) slots respawn, shorter settle. */
const LAYOUT_SETTLE_LIVE_MS = 3500;
/** Incremental Full Push: one new app per SetLayout — short settle + cable poll. */
const LAYOUT_SETTLE_INCREMENTAL_MS = 2000;
/** Quiet teardown budget: 16 exits × 120ms + task reap + layout persistence. */
const LAYOUT_CLEAR_QUIET_MS = 4000;
/** First spawn after clear: SetLayout ACK precedes Core-1 param_handler. */
const LAYOUT_FIRST_SPAWN_QUIET_MS = 2200;
/** Quiet before retry when SetAppParams times out / empty (still spawning). */
const SET_PARAMS_SPAWN_RETRY_MS = 2500;
const SET_PARAMS_RETRIES = 4;
/** Pause after SetAppParams: firmware respawns the app (param_handler exits). */
const SET_PARAMS_GAP_MS = 900;
/**
 * Host wait for SetAppParams AppState. Grooves (16 params + FRAM + respawn)
 * can exceed 15s — shorter waits abort a still-working apply and stack retries.
 */
const SET_PARAMS_TIMEOUT_MS = 45000;
/** Single receive slice inside the SetAppParams wait window. */
const SET_PARAMS_RECEIVE_SLICE_MS = 8000;
/** Fast path: race AppState ACK before GetAppParams verify (FW 1.12 may omit ACK). */
const SET_PARAMS_ACK_RACE_MS = 10000;
/** Quiet before first GetAppParams verify after missing ACK. */
const SET_PARAMS_VERIFY_QUIET_MS = 600;
/** Second verify attempt when device is still applying params. */
const SET_PARAMS_VERIFY_RETRY_QUIET_MS = 2000;
/** Beacon repeats every second — two windows are enough to catch one burst. */
const PANIC_BEACON_LISTEN_MS = 2500;
const PANIC_BEACON_POLL_MS = 100;

export const APP_MAX_PARAMS = 17;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Compact wire summary for push logs (tag[+shape]) — catches Range/Drummer drift. */
export function summarizeParamWire(values) {
  if (!Array.isArray(values)) return "(none)";
  return values
    .map((v, i) => {
      if (v == null) return `${i}:_`;
      const tag = v.tag || "?";
      if (tag === "Enum" || tag === "i32" || tag === "f32" || tag === "bool") {
        const n = Array.isArray(v.value) ? v.value[0] : v.value;
        return `${i}:${tag}=${n}`;
      }
      if (tag === "Range" || tag === "Color" || tag === "Curve" || tag === "Waveform") {
        const t = v.value?.tag ?? v.value;
        return `${i}:${tag}:${t}`;
      }
      if (tag === "MidiOut") {
        const flags = Array.isArray(v.value?.[0]) ? v.value[0] : v.value;
        return `${i}:MidiOut[${Array.isArray(flags) ? flags.map(Number).join("") : "?"}]`;
      }
      if (
        (tag === "MidiNote" || tag === "MidiChannel" || tag === "MidiCc") &&
        Array.isArray(v.value)
      ) {
        return `${i}:${tag}=${v.value[0]}`;
      }
      return `${i}:${tag}`;
    })
    .join(" ");
}

/**
 * Sleep without going SysEx-silent for long stretches — macOS/Web MIDI can
 * drop the config port after ~1min of idle during a long Full Push.
 * @param {{ probe?: boolean, label?: string, onLog?: (s: string) => void }} [opts]
 *        probe=false → pure quiet (post-gate FRAM); default probes GetVersion.
 * @returns {Promise<{ quietMs: number, probesOk: number, probesFail: number }>}
 */
async function delayKeepalive(config, ms, opts = {}) {
  const probe = opts.probe !== false;
  const log = opts.onLog || (() => {});
  const probeEveryMs = Math.max(800, Number(opts.probeEveryMs) || 1200);
  let quietMs = 0;
  let probesOk = 0;
  let probesFail = 0;
  let warned = false;
  if (ms <= 0) return { quietMs, probesOk, probesFail };
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const left = end - Date.now();
    const slice = Math.min(left, probe ? probeEveryMs : 2000);
    await delay(slice);
    if (Date.now() >= end) break;
    if (!probe) continue;
    try {
      await probeConfigCable(config);
      probesOk++;
      quietMs = 0;
    } catch {
      probesFail++;
      quietMs += slice;
      // spawn may mute briefly — only warn on sustained silence
      if (!warned && quietMs >= 5000) {
        warned = true;
        log(
          `  ⚠ config quiet ${Math.round(quietMs / 1000)}s during ${opts.label || "wait"} — continuing …`,
        );
      }
    }
  }
  return { quietMs, probesOk, probesFail };
}

/**
 * After long quiet waits: prove the cable, or one reconnect before slot polls.
 */
async function ensureCableAfterSpawn(config, deviceRef, log, label) {
  const where = label || "after spawn wait";
  let cfg = config;
  try {
    await assertConfigCableAlive(cfg, log);
    log(`  ✓ config cable alive ${where}`);
    return cfg;
  } catch (e) {
    log(`  ⚠ ${e.message || e}`);
  }
  // Disconnect-while-wedged hangs connectDevice (Delta@Ripppple). Wait for the
  // USB stack to recover, then probe again — same window that used to work
  // after an aborted push. A late spawn in a dense layout can stay silent well
  // past 8s, so escalate before declaring the device dead.
  for (const recoverMs of [8000, 12000]) {
    log(`  wait ${recoverMs}ms for USB recover (no disconnect) …`);
    await delay(recoverMs);
    try {
      await assertConfigCableAlive(cfg, log);
      log(`  ✓ config cable alive ${where} after recover`);
      return cfg;
    } catch (e) {
      log(`  ⚠ ${e.message || e}`);
    }
  }
  if (!deviceRef) throw new Error(`config cable quiet ${where}`);
  await reportPanicBeacon(deviceRef, log);
  // Reconnect while Ripppple still holds USB MIDI just hangs GetVersion
  // (Delta: ports present, device dead). Leave the port; caller replugs.
  throw new Error(
    `config cable still quiet ${where} after recover — USB wedged, replug`,
  );
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

/**
 * Last resort when the config cable is gone: the firmware re-sends its panic
 * site as CC on the performance port once per second, so a short listen tells
 * us where it died instead of guessing.
 */
async function reportPanicBeacon(deviceRef, log) {
  try {
    const access = deviceRef?.device?.access;
    const configInput = deviceRef?.device?.config?.input;
    if (!access || !configInput) return;
    const input = findPerfInput(access, configInput);
    if (!input) return;

    const collector = createPanicBeaconCollector();
    const previous = input.onmidimessage;
    try {
      // A port whose device vanished can leave open() pending forever; this is
      // diagnostics running in front of an error, so it must not stall it.
      await Promise.race([input.open(), delay(PANIC_BEACON_LISTEN_MS)]);
      input.onmidimessage = (event) => collector.feed(event.data);
      log(`  listening for panic beacon on ${input.name ?? input.id} …`);
      const deadline = Date.now() + PANIC_BEACON_LISTEN_MS;
      while (Date.now() < deadline && collector.result() === null) {
        await delay(PANIC_BEACON_POLL_MS);
      }
    } finally {
      input.onmidimessage = previous ?? null;
    }

    const site = collector.result();
    if (!site) {
      log(
        "  · no panic beacon — the device died without reaching the panic handler (or USB is fully gone)",
      );
      return;
    }
    const files = await loadPanicFiles();
    log(`  ⚠ firmware panic at ${formatPanicSite(site, files)}`);
  } catch {
    /* diagnostics only */
  }
}

/**
 * Mild settle scaling by layout size (not per-app).
 */
function settleMsForLayout(appCount, baseMs, { capMs = null } = {}) {
  let ms = Math.max(baseMs, Number(appCount) * 550);
  if (capMs != null) ms = Math.min(ms, capMs);
  return ms;
}

/** Stable log / params order: channel ascending. Firmware places by channel. */
function compareChannelOrder(a, b) {
  return (Number(a.startChannel) || 0) - (Number(b.startChannel) || 0);
}

/**
 * Spawn cost heuristic (no per-app special cases).
 * Higher weight → later in incremental Full Push settle/pause sizing.
 */
export function spawnWeight(slot) {
  if (!slot?.app) return 0;
  const channels = Math.max(1, Number(slot.app.channels) || 1);
  const params = Number(slot.app.paramCount) || 0;
  let w = 1;
  if (params >= 14) w += 2;
  else if (params >= 11) w += 1;
  if (channels > 1) w += 2; // still "heavy" for settle/pause sizing
  return w;
}

/** Minimum weight for "heavy" settle/pause (large params or multi-ch). */
const HEAVY_SPAWN_WEIGHT = 3;

/**
 * Split active slots into light / heavy by spawnWeight.
 * Empty (no app) rows are omitted — wire holes come from startChannel on placed slots.
 */
export function partitionBySpawnWeight(appLayout, heavyMin = HEAVY_SPAWN_WEIGHT) {
  const light = [];
  const heavy = [];
  for (const slot of appLayout) {
    if (!slot?.app) continue;
    if (spawnWeight(slot) >= heavyMin) heavy.push(slot);
    else light.push(slot);
  }
  heavy.sort((a, b) => spawnWeight(a) - spawnWeight(b) || compareChannelOrder(a, b));
  light.sort(compareChannelOrder);
  return { light, heavy };
}

/**
 * Non-hold atomic spawn is faster but still outruns a short GetVersion settle.
 */
function estimateAtomicSpawnMs(appCount) {
  const n = Math.max(0, Number(appCount) || 0);
  if (n === 0) return 0;
  let ms = 500;
  for (let running = 1; running <= n; running++) {
    if (running >= 10) ms += 800;
    else if (running >= 6) ms += 500;
    else ms += 250;
  }
  return ms + 800 + 1500;
}

/**
 * Apps that wedge USB when spawned mid-hold-incremental if params were already
 * applied to earlier slots. Spawn last; wire layout still uses startChannel.
 * Playground: push-playground.mjs “Vamp last”. IDs vary by firmware catalog
 * (35 playground, 106 current GetAllApps).
 */
export const SPAWN_DEFER_APP_IDS = new Set([35, 106]);

function spawnSortTier(slot) {
  if (!slot?.app) return 0;
  const id = Number(slot.app.appId);
  if (SPAWN_DEFER_APP_IDS.has(id) || slot.app.name === "Chord Vamp") return 3;
  const channels = Math.max(1, Number(slot.app.channels) || 1);
  if (channels >= 2 && channels < 4) return 1;
  if (channels >= 4) return 2;
  return 0;
}

/**
 * Incremental Full Push order:
 * all 1ch (Grooves…Umbra, Turing, Controls) → 2–3ch (Semmy) → ≥4ch (Ripppple) → Chord Vamp.
 * Within each tier, physical channel order avoids sparse prefixes.
 */
export function compareSpawnOrder(a, b) {
  const ta = spawnSortTier(a);
  const tb = spawnSortTier(b);
  if (ta !== tb) return ta - tb;
  return compareChannelOrder(a, b);
}

function isHeavySpawnSlot(slot, index, total) {
  if (Number(slot.app?.channels) > 1) return true;
  if (spawnWeight(slot) >= HEAVY_SPAWN_WEIGHT) return true;
  return index >= Math.max(6, total - 5);
}

/** Extra quiet per already-running app once a layout gets dense. */
const DENSE_SPAWN_RAMP_FROM_INDEX = 4;
const DENSE_SPAWN_RAMP_STEP_MS = 300;
/** Ceiling for any single spawn pause — late 4ch under density. */
const SPAWN_QUIET_CAP_MS = 8000;
/** 4ch into an already-dense layout needs more air. */
const SPAWN_QUIET_4CH_MS = 12000;

/**
 * Quiet pause after each incremental SetLayout before SetAppParams.
 * Index 0 (post-clear) needs a longer floor — 800ms left heavy 1ch apps
 * (e.g. Grooves) timing out on SetAppParams with no AppState reply.
 * `alreadyRunning` = slots already in the growing layout (SetLayout respawns
 * them); a prior multi-ch app (Semmy@ch0) needs a long floor on every later
 * step or Control#2 wedges USB.
 */
export function incrementalSpawnQuietMs(slot, index, total, alreadyRunning = []) {
  const channels = Number(slot?.app?.channels) || 1;
  const heavy = isHeavySpawnSlot(slot, index, total);
  const weightHeavy = spawnWeight(slot) >= HEAVY_SPAWN_WEIGHT;
  // Late packed spawn under Hold: 11 running handlers + a heavy 1ch (Chord Vamp
  // as 12/14 at 3200ms) killed the config cable before GetAppParams — same
  // class as late 4ch (Ripppple). Ramp is not enough once the spawn itself
  // stalls USB; use the multi-ch 8000ms floor.
  const latePacked = index >= 6 && (channels > 1 || weightHeavy);
  let base = latePacked
    ? 8000
    : channels > 1
      ? 1200
      : heavy || index >= 8
        ? 800
        : 500;
  const priorMulti = (alreadyRunning || []).some(
    (s) => Number(s?.app?.channels) > 1,
  );
  const prior4ch = (alreadyRunning || []).some(
    (s) => Number(s?.app?.channels) >= 4,
  );
  // Growing after a multi-ch app respawns it on every SetLayout — 500ms after
  // Semmy left Control(ch2) with a dead config cable (Beta).
  if (index > 0 && priorMulti) {
    base = Math.max(base, 4000);
  }
  // Ripppple@8 under Hold: 4ch after Semmy still needs the dense floor even when
  // index is not latePacked the same way as a trailing heavy 1ch.
  if (index > 0 && prior4ch) {
    base = Math.max(base, SPAWN_QUIET_CAP_MS);
  }
  if (channels >= 4 && (alreadyRunning || []).length > 0) {
    base = Math.max(base, SPAWN_QUIET_4CH_MS);
  }
  if (index === 0) return Math.max(base, LAYOUT_FIRST_SPAWN_QUIET_MS);
  // Every app already running keeps its handlers up while the next one spawns,
  // so spawn latency grows with the layout. A flat 800ms left Echolot as the
  // 11th app with no air and killed the config cable before GetAppParams.
  const ramp =
    index >= DENSE_SPAWN_RAMP_FROM_INDEX
      ? (index - DENSE_SPAWN_RAMP_FROM_INDEX + 1) * DENSE_SPAWN_RAMP_STEP_MS
      : 0;
  const cap = channels >= 4 ? SPAWN_QUIET_4CH_MS : SPAWN_QUIET_CAP_MS;
  return Math.min(cap, base + ramp);
}

/** Place apps at final startChannel (holes OK). Falls back to packed order. */
export function buildSendLayout(appLayout) {
  const sendLayout = [Array.from({ length: 16 }, () => undefined)];
  const placed = appLayout.filter((s) => s.app);
  const useStart =
    placed.length > 0 &&
    placed.every((s) => Number.isFinite(Number(s.startChannel)));
  if (useStart) {
    for (const slot of placed) {
      const ch = Number(slot.startChannel);
      if (ch < 0 || ch >= 16) continue;
      sendLayout[0][ch] = [
        slot.app.appId,
        slot.app.channels,
        slot.id,
      ];
    }
    return sendLayout;
  }
  let currentChan = 0;
  for (const appSlot of appLayout) {
    if (currentChan >= 16) break;
    if (appSlot.app) {
      sendLayout[0][currentChan] = [
        appSlot.app.appId,
        appSlot.app.channels,
        appSlot.id,
      ];
      currentChan += Number(appSlot.app.channels);
    } else {
      currentChan++;
    }
  }
  return sendLayout;
}

function asU8(n) {
  const v = typeof n === "bigint" ? Number(n) : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** JSON-safe clone (postcard may yield BigInt). */
function toPlainJson(value) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
}

/** Default uncalibrated V/Oct curves — required by GlobalConfig wire shape. */
export const DEFAULT_CUSTOM_VOCT_CURVES = Object.freeze([
  Object.freeze({ counts_per_oct: 0 }),
  Object.freeze({ counts_per_oct: 0 }),
  Object.freeze({ counts_per_oct: 0 }),
  Object.freeze({ counts_per_oct: 0 }),
]);

const CLOCK_SRC_TAGS = new Set([
  "None",
  "Atom",
  "Meteor",
  "Cube",
  "Internal",
  "MidiIn",
  "MidiUsb",
]);
const RESET_SRC_TAGS = new Set(["None", "Atom", "Meteor", "Cube"]);
const CLOCK_DIV_TAGS = new Set([
  "_1",
  "_2",
  "_4",
  "_6",
  "_8",
  "_12",
  "_24",
  "_96",
  "_192",
  "_384",
]);
const AUX_MODE_TAGS = new Set(["None", "ClockOut", "ResetOut"]);
const MIDI_OUT_MODE_TAGS = new Set(["None", "Local", "MidiThru", "MidiMerge"]);
const I2C_MODE_TAGS = new Set(["Calibration", "Leader", "Follower"]);
const TAKEOVER_TAGS = new Set(["Pickup", "Jump", "Scale"]);
const KEY_TAGS = new Set([
  "Chromatic",
  "Ionian",
  "Dorian",
  "Phrygian",
  "Lydian",
  "Mixolydian",
  "Aeolian",
  "Locrian",
  "BluesMaj",
  "BluesMin",
  "PentatonicMaj",
  "PentatonicMin",
  "Folk",
  "Japanese",
  "Gamelan",
  "HungarianMin",
  "Off",
]);
const NOTE_TAGS = new Set([
  "C",
  "CSharp",
  "D",
  "DSharp",
  "E",
  "F",
  "FSharp",
  "G",
  "GSharp",
  "A",
  "ASharp",
  "B",
]);

function tagOr(v, allowed, fallback) {
  const tag = typeof v === "string" ? v : v?.tag;
  return allowed.has(tag) ? tag : fallback;
}

function normalizeWireAux(aux) {
  const src = Array.isArray(aux) ? aux : [];
  const defaults = [
    { tag: "ClockOut", value: { tag: "_1" } },
    { tag: "None" },
    { tag: "None" },
  ];
  return [0, 1, 2].map((i) => {
    const a = src[i];
    // Editor shape: { mode, div }
    if (a && typeof a === "object" && "mode" in a) {
      const mode = tagOr(a.mode, AUX_MODE_TAGS, defaults[i].tag);
      if (mode === "ClockOut") {
        return {
          tag: "ClockOut",
          value: { tag: tagOr(a.div, CLOCK_DIV_TAGS, "_1") },
        };
      }
      return { tag: mode };
    }
    const mode = tagOr(a, AUX_MODE_TAGS, defaults[i].tag);
    if (mode === "ClockOut") {
      return {
        tag: "ClockOut",
        value: {
          tag: tagOr(a?.value ?? a?.div, CLOCK_DIV_TAGS, "_1"),
        },
      };
    }
    return { tag: mode };
  });
}

function normalizeWireMidiOut(out, index) {
  const o = out && typeof out === "object" ? out : {};
  const send_clock =
    typeof o.send_clock === "boolean"
      ? o.send_clock
      : typeof o.sendClock === "boolean"
        ? o.sendClock
        : true;
  const send_transport =
    typeof o.send_transport === "boolean"
      ? o.send_transport
      : typeof o.sendTransport === "boolean"
        ? o.sendTransport
        : true;
  const modeTag = tagOr(
    o.mode?.tag ?? o.mode,
    MIDI_OUT_MODE_TAGS,
    "Local",
  );
  if (modeTag === "MidiThru" || modeTag === "MidiMerge") {
    const sources = o.mode?.value?.sources?.[0];
    const sourceUsb =
      index === 0
        ? false
        : Array.isArray(sources)
          ? !!sources[0]
          : typeof o.sourceUsb === "boolean"
            ? o.sourceUsb
            : false;
    const sourceDin =
      index === 0
        ? true
        : Array.isArray(sources)
          ? !!sources[1]
          : typeof o.sourceDin === "boolean"
            ? o.sourceDin
            : true;
    return {
      send_clock,
      send_transport,
      mode: {
        tag: modeTag,
        value: { sources: [[sourceUsb, sourceDin]] },
      },
    };
  }
  return { send_clock, send_transport, mode: { tag: modeTag } };
}

function normalizeWireCurves(curves) {
  const src = Array.isArray(curves) ? curves : [];
  return [0, 1, 2, 3].map((i) => {
    const n = Number(src[i]?.counts_per_oct);
    return {
      counts_per_oct: Number.isFinite(n)
        ? Math.max(0, Math.min(65535, Math.round(n)))
        : 0,
    };
  });
}

/**
 * Coerce partial / editor / stale GlobalConfig into a postcard-valid wire
 * shape. Missing `custom_voct_curves` (or other required fields) → serialize
 * throws "Value ConfigMsgIn has wrong format" on SetGlobalConfig.
 * @param {object} config
 * @returns {object}
 */
export function ensureWireGlobalConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid global config");
  }
  // Accept editor-shaped globals accidentally passed as wire config
  // (e.g. { clockSrc, bpm, … } or showcase `{ clock: { clock_src } }` only).
  const clockIn =
    config.clock && typeof config.clock === "object" ? config.clock : {};
  const clockSrc = tagOr(
    clockIn.clock_src ?? config.clockSrc,
    CLOCK_SRC_TAGS,
    "Internal",
  );
  const resetSrc = tagOr(
    clockIn.reset_src ?? config.resetSrc,
    RESET_SRC_TAGS,
    "None",
  );
  let bpm = Number(clockIn.internal_bpm ?? config.bpm);
  if (!Number.isFinite(bpm)) bpm = 120;
  bpm = Math.max(1, Math.min(300, bpm));
  let swing = Number(clockIn.swing_amount ?? config.swing);
  if (!Number.isFinite(swing)) swing = 0;
  swing = Math.max(-35, Math.min(35, Math.round(swing)));
  let extPpqn = Number(clockIn.ext_ppqn);
  if (!Number.isFinite(extPpqn) || extPpqn < 1) extPpqn = 24;
  extPpqn = Math.max(1, Math.min(96, Math.round(extPpqn)));

  let led = Number(config.led_brightness);
  if (!Number.isFinite(led)) led = 150;
  led = Math.max(100, Math.min(255, Math.round(led)));

  const quantIn =
    config.quantizer && typeof config.quantizer === "object"
      ? config.quantizer
      : {};
  const midiIn =
    config.midi && typeof config.midi === "object" ? config.midi : {};
  const midiOuts = Array.isArray(midiIn.outs)
    ? midiIn.outs
    : Array.isArray(config.midi)
      ? config.midi
      : [];

  return {
    aux: normalizeWireAux(config.aux),
    clock: {
      clock_src: { tag: clockSrc },
      ext_ppqn: extPpqn,
      reset_src: { tag: resetSrc },
      internal_bpm: bpm,
      swing_amount: swing,
    },
    i2c_mode: {
      tag: tagOr(config.i2c_mode ?? config.i2cMode, I2C_MODE_TAGS, "Leader"),
    },
    led_brightness: led,
    midi: {
      outs: [0, 1, 2].map((i) => normalizeWireMidiOut(midiOuts[i], i)),
    },
    quantizer: {
      key: {
        tag: tagOr(
          quantIn.key ?? config.scale,
          KEY_TAGS,
          "Chromatic",
        ),
      },
      tonic: {
        tag: tagOr(quantIn.tonic ?? config.tonic, NOTE_TAGS, "C"),
      },
    },
    takeover_mode: {
      tag: tagOr(
        config.takeover_mode ?? config.takeover,
        TAKEOVER_TAGS,
        "Pickup",
      ),
    },
    custom_voct_curves: normalizeWireCurves(
      config.custom_voct_curves ?? config.customVoctCurves,
    ),
  };
}

/** Coerce editor/JSON quirks into postcard Value shapes. */
export function normalizeValueForWire(v) {
  if (!v || typeof v !== "object" || !("tag" in v)) return v;
  const tag = v.tag;
  // Param::None / stale catalog placeholders are not wire Values.
  if (tag === "None") return undefined;
  // i32/f32/Enum/bool are scalars — never single-element arrays
  if (
    (tag === "i32" || tag === "f32" || tag === "Enum" || tag === "bool") &&
    Array.isArray(v.value)
  ) {
    return { tag, value: v.value[0] };
  }
  // MidiOut must be [[usb,out1,out2]] not [usb,out1,out2]
  if (tag === "MidiOut" && Array.isArray(v.value) && v.value.length === 3 && typeof v.value[0] === "boolean") {
    return { tag, value: [v.value] };
  }
  // MidiNote / MidiChannel / MidiCc: heal NaN from unset note-column overlays
  if (
    (tag === "MidiNote" || tag === "MidiChannel" || tag === "MidiCc") &&
    Array.isArray(v.value) &&
    v.value.length === 1
  ) {
    const n = Number(v.value[0]);
    if (!Number.isFinite(n)) {
      const fallback = tag === "MidiChannel" ? 1 : tag === "MidiNote" ? 48 : 0;
      return { tag, value: [fallback] };
    }
  }
  return v;
}

export function padParams(values) {
  const result = Array.from({ length: APP_MAX_PARAMS }, () => undefined);
  (values || []).forEach((v, i) => {
    if (i < APP_MAX_PARAMS) result[i] = normalizeValueForWire(v);
  });
  return result;
}

/**
 * Sparse SetAppParams wire: only slots that differ from device (or are missing
 * on device). Undefined host slots stay omitted — matches Scopepunk Unique MIDI.
 */
export function buildSparseParams(hostValues, deviceValues) {
  const host = padParams(hostValues);
  const device = padParams(deviceValues);
  const sparse = Array.from({ length: APP_MAX_PARAMS }, () => undefined);
  for (let i = 0; i < APP_MAX_PARAMS; i++) {
    const h = host[i];
    if (h === undefined) continue;
    const d = device[i];
    if (d === undefined || !wireValueMatch(h, d)) {
      sparse[i] = h;
    }
  }
  return sparse;
}

function sparseHasDefinedSlots(sparse) {
  return sparse.some((v) => v !== undefined);
}

function overlayParamWire(base, sparse) {
  const out = padParams(base);
  for (let i = 0; i < APP_MAX_PARAMS; i++) {
    if (sparse[i] !== undefined) out[i] = sparse[i];
  }
  return out;
}

/**
 * One-slot sparse that differs from `hostPadded` so FW `changed=true` and
 * `param_handler` restarts `run()` (MidiOutput is frozen at first query).
 * Caller must restore with the real host vector.
 */
export function forceRestartTouch(hostPadded) {
  const sparse = Array.from({ length: APP_MAX_PARAMS }, () => undefined);
  for (let i = 0; i < APP_MAX_PARAMS; i++) {
    const h = hostPadded[i];
    if (!h || h.tag !== "bool") continue;
    const cur = !!scalarWireValue(h);
    sparse[i] = { tag: "bool", value: !cur };
    return sparse;
  }
  for (let i = 0; i < APP_MAX_PARAMS; i++) {
    const h = hostPadded[i];
    if (!h || h.tag !== "Enum") continue;
    const n = Number(scalarWireValue(h));
    const cur = Number.isFinite(n) ? n : 0;
    sparse[i] = { tag: "Enum", value: cur === 0 ? 1 : 0 };
    return sparse;
  }
  for (let i = 0; i < APP_MAX_PARAMS; i++) {
    const h = hostPadded[i];
    if (!h || h.tag !== "Color") continue;
    const cur = taggedWireValue(h);
    sparse[i] = { tag: "Color", value: { tag: cur === "Red" ? "Blue" : "Red" } };
    return sparse;
  }
  return null;
}

function scalarWireValue(v) {
  if (v == null) return undefined;
  const val = v.value;
  if (Array.isArray(val) && val.length === 1) return val[0];
  return val;
}

function taggedWireValue(v) {
  if (v == null) return undefined;
  const inner = v.value;
  if (inner && typeof inner === "object" && "tag" in inner) return inner.tag;
  return inner?.tag ?? inner;
}

function midiOutWireFlags(v) {
  if (!v || v.tag !== "MidiOut") return null;
  const raw = v.value;
  const flags = Array.isArray(raw?.[0]) ? raw[0] : raw;
  if (!Array.isArray(flags)) return null;
  return flags.map(Boolean);
}

function wireValueMatch(sent, got) {
  if (sent == null && got == null) return true;
  if (sent == null || got == null) return false;
  if (sent.tag !== got.tag) return false;
  switch (sent.tag) {
    case "MidiNote":
    case "MidiChannel":
    case "MidiCc":
      return Number(scalarWireValue(sent)) === Number(scalarWireValue(got));
    case "Enum":
    case "i32":
    case "bool":
    case "MidiNrpn":
      return scalarWireValue(sent) === scalarWireValue(got);
    case "f32": {
      const a = Number(scalarWireValue(sent));
      const b = Number(scalarWireValue(got));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
      return Math.abs(a - b) < 1e-5;
    }
    case "Range":
    case "Color":
    case "Curve":
    case "Waveform":
      return taggedWireValue(sent) === taggedWireValue(got);
    case "MidiOut": {
      const sf = midiOutWireFlags(sent);
      const gf = midiOutWireFlags(got);
      if (!sf || !gf || sf.length !== gf.length) return false;
      return sf.every((b, i) => b === gf[i]);
    }
    default:
      return JSON.stringify(sent) === JSON.stringify(got);
  }
}

/**
 * Compare host SetAppParams wire vector to device GetAppParams reply.
 * Compares up to min length; ignores trailing undefined holes on `sent`.
 */
export function paramsWireMatch(sent, got) {
  if (!Array.isArray(sent) || !Array.isArray(got)) return false;
  let sentLen = sent.length;
  while (sentLen > 0 && sent[sentLen - 1] === undefined) sentLen--;
  if (sentLen === 0) return false;
  const n = Math.min(sentLen, got.length);
  for (let i = 0; i < n; i++) {
    const s = sent[i];
    if (s === undefined) continue;
    if (!wireValueMatch(s, got[i])) return false;
  }
  return true;
}

async function fetchAppParamsValues(cfg, layoutId, log) {
  clearCachedAppState(cfg.rx, layoutId);
  drainConfigQueue(cfg.rx);
  const response = await sendAndReceiveExpect(
    cfg,
    { tag: "GetAppParams", value: { layout_id: layoutId } },
    "AppState",
    { onLog: log, timeoutMs: 3500, attempts: 2, matchLayoutId: layoutId },
  );
  const values = response.value?.[1] ?? response.value?.values;
  return Array.isArray(values) && values.length > 0 ? values : null;
}

async function verifySetAppParamsViaGet(cfg, layoutId, padded, log) {
  const got = await fetchAppParamsValues(cfg, layoutId, log);
  if (!got) return { ok: false, reason: "empty AppState from GetAppParams" };
  log(`  · device wire: ${summarizeParamWire(got)}`);
  if (paramsWireMatch(padded, got)) {
    return { ok: true, nvals: got.length };
  }
  return { ok: false, reason: "values mismatch" };
}

/**
 * SetAppParams with AppState ACK race, then GetAppParams verify when ACK is missing.
 * FW 1.12.0 may apply params without returning AppState.
 */
async function setAppParamsWithAckOrVerify(cfg, layoutId, sparse, hostPadded, log) {
  drainConfigQueue(cfg.rx);
  try {
    const response = await sendAndReceiveExpect(
      cfg,
      {
        tag: "SetAppParams",
        value: { layout_id: layoutId, values: sparse },
      },
      "AppState",
      {
        onLog: log,
        timeoutMs: SET_PARAMS_RECEIVE_SLICE_MS,
        deadlineMs: SET_PARAMS_ACK_RACE_MS,
        attempts: 1,
        matchLayoutId: layoutId,
      },
    );
    const ackVals = response.value[1];
    const nvals = Array.isArray(ackVals) ? ackVals.length : 0;
    if (nvals === 0) {
      throw new Error(`SetAppParams(${layoutId}): empty AppState`);
    }
    log(`  · ack wire: ${summarizeParamWire(ackVals)}`);
    if (!paramsWireMatch(hostPadded, ackVals)) {
      throw new Error(`SetAppParams(${layoutId}): ACK values mismatch`);
    }
    log(`  ✓ layoutId=${layoutId} (${nvals} params)`);
    return { cfg, nvals, via: "ack" };
  } catch (ackErr) {
    log(
      `  ↷ SetAppParams(${layoutId}): no AppState ACK (${ackErr.message || ackErr}) — verifying via GetAppParams …`,
    );
  }

  // Cable still alive? Distinguishes FW drop vs wedged USB.
  try {
    await probeConfigCable(cfg);
    log("  · config cable alive after Set (GetVersion ok)");
  } catch (e) {
    log(`  · config cable quiet after Set (${e.message || e})`);
  }

  await delay(SET_PARAMS_VERIFY_QUIET_MS);
  let verify = await verifySetAppParamsViaGet(cfg, layoutId, hostPadded, log);
  if (verify.ok) {
    log(`  ✓ layoutId=${layoutId} (verified via GetAppParams, no AppState ACK)`);
    return { cfg, nvals: verify.nvals, via: "verify" };
  }

  log(
    `  ↷ verify failed (${verify.reason}) — retry GetAppParams after ${SET_PARAMS_VERIFY_RETRY_QUIET_MS}ms …`,
  );
  await delay(SET_PARAMS_VERIFY_RETRY_QUIET_MS);
  verify = await verifySetAppParamsViaGet(cfg, layoutId, hostPadded, log);
  if (verify.ok) {
    log(`  ✓ layoutId=${layoutId} (verified via GetAppParams, no AppState ACK)`);
    return { cfg, nvals: verify.nvals, via: "verify" };
  }

  throw new Error(
    `SetAppParams(${layoutId}): no AppState ACK and GetAppParams mismatch (${verify.reason})`,
  );
}

/**
 * Cheap cable check — if this times out, SetLayout likely killed USB MIDI
 * or another tab holds the config port.
 */
async function assertConfigCableAlive(config, log) {
  drainConfigQueue(config.rx);
  try {
    const response = await sendAndReceiveExpect(
      config,
      { tag: "GetVersion" },
      "Version",
      { onLog: log, timeoutMs: 2500, attempts: 4 },
    );
    if (response.tag !== "Version") {
      throw new Error(`expected Version, got ${response.tag}`);
    }
  } catch (e) {
    throw new Error(
      `Config MIDI quiet after layout settle (${e.message || e}).\n` +
        `Close Scopepunk / Configurator tabs, replug USB if the device vanished.`,
    );
  }
}

/** Single short GetVersion — for settle polling (no log spam). */
async function probeConfigCable(config) {
  drainConfigQueue(config.rx);
  const response = await sendAndReceiveExpect(
    config,
    { tag: "GetVersion" },
    "Version",
    { timeoutMs: 600, attempts: 2 },
  );
  if (response.tag !== "Version") {
    throw new Error(`expected Version, got ${response.tag}`);
  }
}

/**
 * ReleasePerfMute without resend-on-timeout (avoids stacking Core1 RELEASE_SPAWN).
 * Accepts a late Pong if the device answered after the slice deadline.
 */
async function releasePerfMute(cfg, log, label = "") {
  try {
    await sendAndReceiveExpect(
      cfg,
      { tag: "ReleasePerfMute" },
      "Pong",
      {
        timeoutMs: 4000,
        attempts: 1,
        deadlineMs: 10000,
        resendOnTimeout: false,
        onLog: log,
      },
    );
    log(`  ReleasePerfMute${label}`);
    return true;
  } catch (e) {
    const late = await waitForOptionalTag(cfg, "Pong", 2500, { onLog: log });
    if (late) {
      log(`  ReleasePerfMute${label} (late ACK)`);
      return true;
    }
    log(`  ⚠ ReleasePerfMute${label}: ${e.message || e}`);
    return false;
  }
}

/**
 * HoldPerfMute without resend-on-timeout (pairs with releasePerfMute).
 * Accepts a late Pong if the device answered after the slice deadline.
 */
async function holdPerfMute(cfg, log, label = "") {
  try {
    await sendAndReceiveExpect(
      cfg,
      { tag: "HoldPerfMute" },
      "Pong",
      {
        timeoutMs: 4000,
        attempts: 1,
        deadlineMs: 10000,
        resendOnTimeout: false,
        onLog: log,
      },
    );
    log(`  HoldPerfMute${label}`);
    return true;
  } catch (e) {
    const late = await waitForOptionalTag(cfg, "Pong", 2500, { onLog: log });
    if (late) {
      log(`  HoldPerfMute${label} (late ACK)`);
      return true;
    }
    log(`  ⚠ HoldPerfMute${label}: ${e.message || e}`);
    return false;
  }
}

/**
 * GetVersion works during LAYOUT_USB_MIDI_MUTE; SetAppParams does not (empty
 * AppState). Poll GetAppParams until the slot actually has a param_handler.
 *
 * Under Hold, FW answers empty AppState in ~400ms while apps are still gated;
 * without Hold, a missing param_handler blocks the config loop up to 3s and
 * can wedge USB on dense layouts during readiness polls.
 *
 * @param {{ label?: string, expectAppId?: number, deviceRef?: { device: object }, underHold?: boolean }} [opts]
 */
async function waitForSlotReady(
  config,
  layoutId,
  log,
  timeoutMs = 12000,
  opts = {},
) {
  let cfg = config;
  const id = Number(layoutId);
  const label = opts.label ? ` ${opts.label}` : "";
  const deviceRef = opts.deviceRef || null;
  const underHold = !!opts.underHold;
  log(`  wait layoutId=${id}${label} ready (hold=${underHold}) …`);
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no reply";
  let emptyStreak = 0;
  let warnedScope = false;
  let checkedLayout = false;
  let quietStreak = 0;
  let reconnects = 0;
  const maxReconnects = 2;
  // Prefer cache / short polls under Hold (400ms FW path); avoid stacking
  // multi-second GetAppParams waits while later channels are still spawning.
  const getTimeoutMs = underHold ? 1500 : 3500;
  while (Date.now() < deadline) {
    try {
      const cached = cachedAppState(cfg.rx, id);
      const cachedValues = cached?.value?.[1];
      if (Array.isArray(cachedValues) && cachedValues.length > 0) {
        log(`  ✓ layoutId=${id} ready (${cachedValues.length} params · cached)`);
        return cfg;
      }
      // Brief passive window: spawn often pushes AppState without a poll.
      await delay(underHold ? 200 : 350);
      {
        const again = cachedAppState(cfg.rx, id);
        const vals = again?.value?.[1];
        if (Array.isArray(vals) && vals.length > 0) {
          log(`  ✓ layoutId=${id} ready (${vals.length} params · cached)`);
          return cfg;
        }
      }
      drainConfigQueue(cfg.rx);
      // Host wait must exceed FW GetAppParams timeout under Hold (400ms) and
      // the non-hold 3s path — otherwise we desync SysEx and never recover.
      const response = await sendAndReceiveExpect(
        cfg,
        { tag: "GetAppParams", value: { layout_id: id } },
        "AppState",
        { timeoutMs: getTimeoutMs, attempts: 2, matchLayoutId: id },
      );
      quietStreak = 0;
      const n = Array.isArray(response.value?.[1])
        ? response.value[1].length
        : Array.isArray(response.value?.values)
          ? response.value.values.length
          : 0;
      if (n > 0) {
        log(`  ✓ layoutId=${id} ready (${n} params)`);
        try {
          const vals = response.value?.[1] ?? response.value?.values;
          log(`  · device wire: ${summarizeParamWire(vals)}`);
        } catch {
          /* ignore */
        }
        return cfg;
      }
      emptyStreak++;
      lastDetail = "empty AppState (mute or not spawned)";
      // Once: confirm the layoutId is actually on the device (not a phantom wait).
      const layoutCheckAfter = underHold ? 8 : 3;
      if (emptyStreak >= layoutCheckAfter && !checkedLayout) {
        checkedLayout = true;
        try {
          drainConfigQueue(cfg.rx);
          const lay = await sendAndReceiveExpect(
            cfg,
            { tag: "GetLayout" },
            "Layout",
            { timeoutMs: 3000, attempts: 2 },
          );
          const check = verifyLayoutSlot(lay.value, id, opts.expectAppId ?? null);
          if (!check.ok) {
            throw new Error(
              `layoutId=${id} missing from device after SetLayout (${check.reason})`,
            );
          }
          log(
            `  · layout ok (ch${check.found.ch} app=${check.found.appId}) — still spawning …`,
          );
        } catch (le) {
          if (String(le.message || le).includes("missing from device")) throw le;
          log(`  ⚠ GetLayout check: ${le.message || le}`);
        }
      }
      // Scopepunk soft-poll / GetAllAppParams often injects empty AppStates
      // mid-spawn — back off so our next GetAppParams can land.
      const warnAfter = underHold ? 16 : 6;
      if (emptyStreak >= warnAfter && !warnedScope) {
        warnedScope = true;
        log(
          "  ⚠ still empty — close Scopepunk / other tabs on the config MIDI cable",
        );
      }
      await delay(
        Math.min(underHold ? 2200 : 1600, (underHold ? 600 : 400) + emptyStreak * 100),
      );
      continue;
    } catch (e) {
      lastDetail = e.message || String(e);
      if (String(lastDetail).includes("missing from device")) throw e;
      // Resync probe — if Version works, keep polling; if not, reconnect or fail.
      try {
        await probeConfigCable(cfg);
        quietStreak = 0;
      } catch (cableErr) {
        quietStreak++;
        lastDetail = `config cable quiet (${cableErr.message || cableErr})`;
        if (!deviceRef || reconnects >= maxReconnects) {
          throw new Error(
            `layoutId=${id} not ready; ${lastDetail}. Close Scopepunk / Configurator, then retry.`,
          );
        }
        // One quiet probe is often mid-spawn / post-unmute noise — back off
        // longer without Hold (GetAppParams 3s path can wedge USB if we spam).
        if (quietStreak < 2) {
          log(`  ⚠ cable quiet (layoutId=${id}) — backoff …`);
          await delay(underHold ? 800 : 2500);
          continue;
        }
        reconnects += 1;
        quietStreak = 0;
        log(
          `  ⚠ cable quiet while waiting layoutId=${id} — reconnect ${reconnects}/${maxReconnects} …`,
        );
        disconnectDevice(deviceRef.device);
        await delay(1000);
        try {
          deviceRef.device = await connectSupportedDevice();
          cfg = deviceRef.device.config;
          log(
            `  reconnected · fw ${cfg.version} · ${deviceRef.device.portSummary}`,
          );
        } catch (re) {
          throw new Error(
            `layoutId=${id} not ready; USB lost (${re.message || re})`,
          );
        }
      }
    }
    await delay(300);
  }
  throw new Error(
    `layoutId=${id}${label} not ready after SetLayout (${lastDetail}). ` +
      `Close Scopepunk / other config-MIDI tabs; if a prior Push aborted, LEDs may stay muted — retry Push (auto-releases Hold).`,
  );
}

/**
 * SetLayout + settle + cable check. Poll GetVersion until spawn storm settles
 * (fixed sleep alone races dense layouts). On cable death, one reconnect retry.
 * @param {string} [label] optional log label e.g. "SetLayout (3/13)"
 */
async function applySetLayout(
  config,
  appLayout,
  log,
  settleMs,
  deviceRef,
  label,
  settleOpts = {},
) {
  const active = appLayout.filter((s) => s.app).length;
  log(`${label || `SetLayout (${active} apps)`} …`);
  const sendLayout = buildSendLayout(appLayout);

  const layoutAck = await sendAndReceiveExpect(
    config,
    { tag: "SetLayout", value: sendLayout },
    "Layout",
    { onLog: log },
  );
  if (layoutAck.tag !== "Layout") {
    throw new Error(`SetLayout failed: ${layoutAck.tag}`);
  }

  const quietMs = Math.max(0, Number(settleOpts.quietMs) || 0);
  if (quietMs > 0) {
    // Configurator-style AddApp path: do not stack GetVersion requests while
    // the firmware is spawning apps. SetAppParams is the next cable check.
    log(`  quiet settle ${quietMs}ms (no cable polling) …`);
    await delay(quietMs);
    return config;
  }

  const headStart = settleOpts.headStartMs ?? 800;
  const pollBudget =
    settleOpts.pollBudgetMs ??
    Math.max(2500, settleMsForLayout(active, settleMs, settleOpts));
  // Head-start must not consume the poll window (that caused false "cable quiet").
  const totalMs = headStart + pollBudget;
  log(
    `  settle ${totalMs}ms (head ${headStart}ms + poll ${pollBudget}ms) …`,
  );
  let alive = false;
  let lastErr = null;
  // Keepalive during long heads (atomic 13-app spawn ~30s) so Web MIDI
  // does not drop the config port mid-wait.
  await delayKeepalive(config, headStart);
  const deadline = Date.now() + pollBudget;
  while (Date.now() < deadline) {
    try {
      await probeConfigCable(config);
      alive = true;
      break;
    } catch (e) {
      lastErr = e;
      await delay(350);
    }
  }
  if (alive) {
    log("  ✓ config cable alive");
    return config;
  }
  log(`  ⚠ ${lastErr?.message || lastErr || "cable quiet after settle"}`);
  if (!deviceRef) throw lastErr || new Error("config cable quiet after settle");
  log("  retry: reconnect Web MIDI …");
  disconnectDevice(deviceRef.device);
  await delay(800);
  deviceRef.device = await connectSupportedDevice();
  log(
    `  reconnected · fw ${deviceRef.device.config.version} · ${deviceRef.device.portSummary}`,
  );
  await assertConfigCableAlive(deviceRef.device.config, log);
  log("  ✓ config cable alive after reconnect");
  return deviceRef.device.config;
}

/**
 * One multi-ch app at ch0 + only light 1ch neighbours (e.g. Semmy + Controls).
 * Incremental left-to-right is stable without Hold; multi-heavy layouts still Hold.
 */
function layoutSkipsHoldDenseSpawn(appLayout) {
  const active = (appLayout || []).filter((s) => s?.app);
  if (active.length < 8) return false;
  const multi = active.filter((s) => Number(s.app?.channels) > 1);
  if (multi.length !== 1 || Number(multi[0].startChannel) !== 0) return false;
  if (partitionBySpawnWeight(appLayout).heavy.length > 1) return false;
  return active.every(
    (s) =>
      spawnWeight(s) < HEAVY_SPAWN_WEIGHT || Number(s.app?.channels) > 1,
  );
}

export function needsHoldForLayout(appLayout) {
  const activeSlots = (appLayout || []).filter((s) => s?.app);
  const n = activeSlots.length;
  if (n === 0) return false;
  const blankOnly = activeSlots.every(
    (s) => Number(s.app?.appId) === 49 || s.app?.name === "Blank",
  );
  if (blankOnly) return false;
  if (layoutSkipsHoldDenseSpawn(appLayout)) return false;
  const heavyN = partitionBySpawnWeight(appLayout).heavy.length;
  const multiCh = activeSlots.some((s) => Number(s.app?.channels) > 1);
  return n >= 8 || heavyN >= 2 || multiCh;
}

/**
 * Grow layout one app at a time under Hold. No SetAppParams here — caller
 * applies params after a single Release in the finally path.
 */
async function applyHoldIncrementalSpawn(cfg, ordered, log, deviceRef) {
  const n = ordered.length;
  log(`  push engine: hold-incremental (spawn only · ${n} apps)`);
  const growing = [];
  for (let i = 0; i < ordered.length; i++) {
    const slot = ordered[i];
    growing.push(slot);
    const name = slot.app?.name || slot.app?.appId;
    const ch = Number(slot.startChannel) || 0;
    const channels = Number(slot.app?.channels) || 1;

    // Second multi-ch under continuous Hold wedges USB; Release+re-Hold resets
    // before Ripppple/Semmy#2.
    const priorMultiCh = growing
      .slice(0, -1)
      .some((s) => Number(s.app?.channels) > 1);
    if (channels > 1 && priorMultiCh) {
      log(`  Hold refresh before second multi-ch (${name}) …`);
      const released = await releasePerfMute(cfg, log, " (before 2nd multi)");
      if (!released) {
        throw new Error("ReleasePerfMute failed before second multi-ch spawn");
      }
      await delay(2000);
      try {
        await probeConfigCable(cfg);
      } catch (e) {
        log(`  ⚠ cable probe after Release (2nd multi): ${e.message || e}`);
      }
      const reheld = await holdPerfMute(cfg, log, " (before 2nd multi)");
      if (!reheld) {
        throw new Error("HoldPerfMute failed before second multi-ch spawn");
      }
      await delay(300);
    }

    let pauseMs = incrementalSpawnQuietMs(
      slot,
      i,
      n,
      growing.slice(0, -1),
    );
    const quietCap = channels >= 4 ? SPAWN_QUIET_4CH_MS : SPAWN_QUIET_CAP_MS;
    pauseMs = Math.min(quietCap, Math.max(pauseMs, 2500));
    cfg = await applySetLayout(
      cfg,
      growing,
      log,
      LAYOUT_SETTLE_INCREMENTAL_MS,
      deviceRef,
      `SetLayout (${i + 1}/${n}) ${name}(ch${ch})`,
      { quietMs: pauseMs },
    );
    cfg = await ensureCableAfterSpawn(
      cfg,
      deviceRef,
      log,
      `after spawn ${name}(ch${ch})`,
    );
  }
  return cfg;
}

/**
 * Full Push — light layouts: Configurator AddApp loop (clear → grow → params).
 * Dense layouts (needsHold): Hold + incremental spawn (no mid-Hold params),
 * then Release + SetAppParams. Atomic Hold SetLayout wedged Zeta; mid-Hold
 * params wedged Hold Sam — spawn-only under Hold is the middle path.
 */
async function applySetLayoutIncremental(
  config,
  appLayout,
  paramsById,
  log,
  deviceRef,
) {
  const activeSlots = appLayout.filter((s) => s.app);
  const n = activeSlots.length;
  if (n === 0) {
    log("SetLayout (0 apps) …");
    return config;
  }
  // Grow physically left-to-right; sparse high-channel prefixes wedge FW 1.11.
  const ordered = [...activeSlots].sort(compareSpawnOrder);
  log(
    `Incremental SetLayout (${n} apps): ${ordered
      .map((s) => {
        const name = s.app?.name || "?";
        const ch = Number(s.startChannel) || 0;
        const id = s.app?.appId;
        return `${name}(ch${ch}#${id})`;
      })
      .join(" → ")}`,
  );
  let cfg = config;
  const heavyN = partitionBySpawnWeight(appLayout).heavy.length;
  const blankOnly = activeSlots.every(
    (s) => Number(s.app?.appId) === 49 || s.app?.name === "Blank",
  );
  const needsHold = needsHoldForLayout(appLayout);
  let held = false;
  let aborted = false;
  /** True if we took the Hold path — post-release SetAppParams after Release. */
  let postReleaseParams = false;

  try {
    await sendAndReceiveExpect(
      cfg,
      { tag: "ReleasePerfMute" },
      "Pong",
      { timeoutMs: 1500, attempts: 1 },
    );
    log("  ReleasePerfMute (unstick)");
    await delay(300);
  } catch {
    /* already released / older firmware */
  }

  if (blankOnly) {
    log("  Hold skipped (Blank-only layout · spawn A/B)");
  }

  if (needsHold) {
    try {
      await sendAndReceiveExpect(
        cfg,
        { tag: "HoldPerfMute" },
        "Pong",
        { timeoutMs: 2000, attempts: 2 },
      );
      held = true;
      postReleaseParams = true;
      log(`  HoldPerfMute (${n} apps · ${heavyN} heavy)`);
      await delay(300);
    } catch {
      log("  ⚠ HoldPerfMute unavailable — continuing without hold");
    }
  }

  // SetLayout ACK precedes Core 1 processing.
  try {
    cfg = await applySetLayout(
      cfg,
      [],
      log,
      LAYOUT_SETTLE_INCREMENTAL_MS,
      deviceRef,
      "SetLayout (clear old apps)",
      { quietMs: LAYOUT_CLEAR_QUIET_MS },
    );

    try {
      await probeConfigCable(cfg);
      log("  ✓ config cable alive after clear");
    } catch (e) {
      throw new Error(
        `USB dead after clear (before any spawn): ${e.message || e}`,
      );
    }

    clearCachedAppStates(cfg.rx);

    if (held) {
      cfg = await applyHoldIncrementalSpawn(cfg, ordered, log, deviceRef);
    } else {
      log("  push engine: incremental");
      const growing = [];
      for (let i = 0; i < ordered.length; i++) {
        const slot = ordered[i];
        growing.push(slot);
        const name = slot.app?.name || slot.app?.appId;
        const ch = Number(slot.startChannel) || 0;
        const pauseMs = incrementalSpawnQuietMs(
          slot,
          i,
          n,
          growing.slice(0, -1),
        );

        cfg = await applySetLayout(
          cfg,
          growing,
          log,
          LAYOUT_SETTLE_INCREMENTAL_MS,
          deviceRef,
          `SetLayout (${i + 1}/${n}) ${name}(ch${ch})`,
          {
            quietMs: pauseMs,
          },
        );

        try {
          cfg = await ensureCableAfterSpawn(
            cfg,
            deviceRef,
            log,
            `after spawn ${name}(ch${ch})`,
          );
        } catch (e) {
          throw new Error(
            `USB dead after SetLayout ${name}(ch${ch}) (before GetAppParams): ${e.message || e}`,
          );
        }

        const id = Number(slot.id);
        const expectAppId = Number(slot.app?.appId);
        try {
          cfg = await applySetAppParams(cfg, paramsById, [id], log, {
            deviceRef,
            underHold: false,
            skipReadyWait: false,
            expectAppId: Number.isFinite(expectAppId) ? expectAppId : undefined,
            maxAttempts: 1,
          });
        } catch (firstErr) {
          let err = firstErr;
          const message = String(err.message || err);
          log(`  ⚠ SetAppParams(${id}): ${message}`);
          if (!deviceRef) throw err;
          log(
            `  retry: quiet ${SET_PARAMS_SPAWN_RETRY_MS}ms + wait ready + SetAppParams …`,
          );
          await delay(SET_PARAMS_SPAWN_RETRY_MS);
          clearCachedAppState(cfg.rx, id);
          try {
            cfg = await waitForSlotReady(cfg, id, log, 45_000, {
              label: "after params fail",
              deviceRef,
              underHold: false,
              expectAppId: Number.isFinite(expectAppId) ? expectAppId : undefined,
            });
            cfg = await applySetAppParams(cfg, paramsById, [id], log, {
              deviceRef,
              underHold: false,
              skipReadyWait: true,
              maxAttempts: 1,
            });
            continue;
          } catch (retryErr) {
            err = retryErr;
          }
          log("  retry: reconnect + wait ready + SetAppParams …");
          disconnectDevice(deviceRef.device);
          await delay(1000);
          deviceRef.device = await connectSupportedDevice();
          cfg = deviceRef.device.config;
          log(`  reconnected · fw ${cfg.version} · ${deviceRef.device.portSummary}`);
          await delay(SET_PARAMS_SPAWN_RETRY_MS);
          clearCachedAppState(cfg.rx, id);
          cfg = await waitForSlotReady(cfg, id, log, 45_000, {
            label: "after reconnect",
            deviceRef,
            underHold: false,
            expectAppId: Number.isFinite(expectAppId) ? expectAppId : undefined,
          });
          cfg = await applySetAppParams(cfg, paramsById, [id], log, {
            deviceRef,
            underHold: false,
            skipReadyWait: true,
            maxAttempts: 1,
          });
        }
      }
    }
  } catch (e) {
    aborted = true;
    throw e;
  } finally {
    if (aborted) {
      if (held) {
        // Cable may be gone — one short unmute try; no SetAppParams hammering.
        try {
          await sendAndReceiveExpect(
            deviceRef?.device?.config ?? cfg,
            { tag: "ReleasePerfMute" },
            "Pong",
            { timeoutMs: 1500, attempts: 1 },
          );
          log("  ReleasePerfMute (after abort)");
        } catch {
          log("  ⚠ push aborted with Hold still set — replug USB, then Push again");
        }
      }
    } else if (postReleaseParams && deviceRef?.device?.config) {
      cfg = deviceRef.device.config;
      let skipPostReleaseParams = false;
      if (held) {
        let released = await releasePerfMute(cfg, log);
        if (released) {
          log("  quiet settle 5000ms after Release …");
          await delay(5000);
        } else {
          await delay(2000);
          try {
            await probeConfigCable(cfg);
          } catch (e) {
            log(`  ⚠ cable probe after Release fail: ${e.message || e}`);
          }
          released = await releasePerfMute(cfg, log, " (retry)");
          if (!released) {
            log(
              "  ⚠ Hold may still be set — skipping SetAppParams (replug USB, then Push again)",
            );
            skipPostReleaseParams = true;
          } else {
            log("  quiet settle 5000ms after Release …");
            await delay(5000);
          }
        }
      }
      // ParamStore can already match after Hold Set, but MidiOutput is frozen
      // at query(). Identical Set is a no-op on stock 1.12.0 (`changed=false`).
      // forceRestart: touch a slot then restore so run() re-queries after Release.
      const ids = ordered
        .map((s) => Number(s.id))
        .filter((id) => Number.isFinite(id));
      if (!skipPostReleaseParams && ids.length > 0) {
        log("SetAppParams (post-release) …");
        clearCachedAppStates(cfg.rx);
        // GetAppParams can stay empty while handlers wake after Release; Set still applies.
        cfg = await applySetAppParams(cfg, paramsById, ids, log, {
          deviceRef,
          underHold: false,
          maxAttempts: 2,
          forceRestart: true,
          skipReadyWait: true,
        });
      }
    }
  }

  return cfg;
}

/** Poll GetAppParams until every layoutId has a live param_handler. */
async function waitForAllSlotsReady(
  config,
  layoutIds,
  log,
  timeoutMs,
  deviceRef,
) {
  const pending = new Set(layoutIds.map(Number));
  const deadline = Date.now() + timeoutMs;
  log(`  wait ${pending.size} slots ready (up to ${timeoutMs}ms) …`);
  let cfg = config;
  let lastProgress = Date.now();
  let reconnects = 0;
  const maxReconnects = 2;
  while (pending.size > 0 && Date.now() < deadline) {
    let progressed = false;
    for (const id of [...pending]) {
      try {
        drainConfigQueue(cfg.rx);
        const response = await sendAndReceiveExpect(
          cfg,
          { tag: "GetAppParams", value: { layout_id: id } },
          "AppState",
          { timeoutMs: 1200, attempts: 1 },
        );
        const values = response.value?.[1] ?? response.value?.values;
        if (Array.isArray(values) && values.length > 0) {
          pending.delete(id);
          progressed = true;
          lastProgress = Date.now();
          log(`  ✓ layoutId=${id} ready (${values.length} params)`);
        }
      } catch {
        /* still spawning / quiet */
      }
      await delay(40);
    }
    if (pending.size === 0) break;
    // Some slots came up, then nothing for a while → likely TaskPool
    // exhausted (remaining layoutIds were never spawned). Fail fast
    // instead of hammering GetAppParams until the config cable dies.
    const stalledMs = Date.now() - lastProgress;
    const ready = layoutIds.length - pending.size;
    if (ready > 0 && stalledMs > 8_000) {
      throw new Error(
        `slots stalled: ${ready}/${layoutIds.length} ready, still missing ${[...pending].join(",")} — often Embassy pool_size exhausted`,
      );
    }
    try {
      await probeConfigCable(cfg);
    } catch (e) {
      if (!deviceRef) throw e;
      reconnects += 1;
      if (reconnects > maxReconnects) {
        throw new Error(
          `config cable quiet while waiting slots (missing ${[...pending].join(",")}); gave up after ${maxReconnects} reconnects`,
        );
      }
      log("  ⚠ cable quiet while waiting slots — reconnect …");
      disconnectDevice(deviceRef.device);
      await delay(800);
      try {
        deviceRef.device = await connectSupportedDevice();
        cfg = deviceRef.device.config;
        log(
          `  reconnected · fw ${deviceRef.device.config.version} · ${deviceRef.device.portSummary}`,
        );
      } catch (re) {
        throw new Error(
          `USB lost waiting slots ${[...pending].join(",")} (${re.message || re})`,
        );
      }
    }
    await delay(400);
  }
  if (pending.size > 0) {
    throw new Error(
      `slots not ready: ${[...pending].join(",")} after ${timeoutMs}ms`,
    );
  }
  return cfg;
}

function buildAppLayout(setup, allApps, log) {
  const appLayout = [];
  const paramsById = new Map();
  for (const slot of setup.layout) {
    const { appId, layoutId, params, startChannel } = slot;
    if (!appId) {
      appLayout.push({ id: layoutId, app: null, startChannel });
      continue;
    }
    const app = allApps.get(appId);
    if (!app || !params) {
      log(`  ⚠ skip layoutId ${layoutId}: unknown app ${appId} or no params`);
      appLayout.push({ id: layoutId, app: null, startChannel });
      continue;
    }
    appLayout.push({ id: layoutId, app, startChannel });
    paramsById.set(layoutId, params);
  }
  return { appLayout, paramsById };
}

async function applySetAppParams(config, paramsById, layoutIds, log, opts = {}) {
  let cfg = config;
  const deviceRef = opts.deviceRef || null;
  const underHold = !!opts.underHold;
  const skipReadyWait = !!opts.skipReadyWait;
  const forceRestart = !!opts.forceRestart;
  const maxAttempts = Math.max(
    1,
    Number(opts.maxAttempts) || SET_PARAMS_RETRIES,
  );
  const ids =
    layoutIds == null
      ? [...paramsById.keys()].map(Number)
      : layoutIds.map(Number);

  async function setOne(id) {
    const values = paramsById.get(id) ?? paramsById.get(String(id));
    if (!values) {
      log(`  ⚠ skip layoutId=${id}: no params in setup`);
      return;
    }
    // SetLayout ACK and GetVersion only prove transport health. Dense layouts
    // continue spawning AppStates for many seconds (often IDs 9→14). Do not
    // spend SetAppParams retries while the requested slot does not exist yet.
    if (!skipReadyWait) {
      cfg = await waitForSlotReady(cfg, id, log, 75_000, {
        label: "before params",
        deviceRef,
        underHold,
        expectAppId: opts.expectAppId,
      });
    }
    const hostPadded = padParams(values);
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt === 0) {
          log(`  · host wire: ${summarizeParamWire(hostPadded)}`);
        }
        const deviceValues = (await fetchAppParamsValues(cfg, id, log)) ?? [];
        let sparse = buildSparseParams(values, deviceValues);
        if (!sparseHasDefinedSlots(sparse)) {
          if (!forceRestart) {
            log(`  ✓ layoutId=${id} (already matches device)`);
            lastErr = null;
            break;
          }
          const touch = forceRestartTouch(hostPadded);
          if (!touch) {
            log(`  ✓ layoutId=${id} (already matches device, no touch slot)`);
            lastErr = null;
            break;
          }
          log(`  · force restart (touch then restore)`);
          log(`  · touch wire: ${summarizeParamWire(touch)}`);
          const expectedTouch = overlayParamWire(hostPadded, touch);
          await setAppParamsWithAckOrVerify(cfg, id, touch, expectedTouch, log);
          await delay(SET_PARAMS_GAP_MS);
          sparse = buildSparseParams(values, expectedTouch);
          if (!sparseHasDefinedSlots(sparse)) {
            log(`  ✓ layoutId=${id} (touch had no restore)`);
            lastErr = null;
            break;
          }
        }
        if (attempt === 0 || forceRestart) {
          log(`  · sparse wire: ${summarizeParamWire(sparse)}`);
        }

        const result = await setAppParamsWithAckOrVerify(cfg, id, sparse, hostPadded, log);
        cfg = result.cfg;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log(
          `  ⚠ SetAppParams(${id}) attempt ${attempt + 1}/${maxAttempts}: ${e.message || e}`,
        );
        if (attempt + 1 < maxAttempts) {
          const wait = String(e.message || e).includes("empty AppState")
            ? 2500
            : 1000 + attempt * 600;
          await delay(wait);
        }
      }
    }
    if (lastErr) {
      throw new Error(
        `SetAppParams(layoutId=${id}): ${lastErr.message || lastErr}\n` +
          `Close Scopepunk / other Configurator tabs (shared SysEx cable), then retry Push.`,
      );
    }
    await delay(SET_PARAMS_GAP_MS);
  }

  log(`SetAppParams (${ids.length}) …`);
  for (const id of ids) {
    await setOne(id);
  }
  try {
    await assertConfigCableAlive(cfg, log);
    log("  ✓ config cable alive after params");
  } catch (e) {
    log(`  ⚠ ${e.message || e}`);
  }
  return cfg;
}

async function getAllApps(config, log) {
  log?.("GetAllApps …");
  const response = await sendAndReceiveExpect(
    config,
    { tag: "GetAllApps" },
    "BatchMsgStart",
    { onLog: log || (() => {}), timeoutMs: 5000, attempts: 12 },
  );
  const expected = Number(response.value);
  const apps = await receiveBatchMessages(config, response.value);
  const map = new Map();
  for (const item of apps) {
    if (item.tag !== "AppConfig") continue;
    const [appId, channels, meta] = item.value;
    const id = Number(appId);
    map.set(id, {
      appId: id,
      channels: Number(channels),
      paramCount: meta[0],
      name: meta[1],
      description: meta[2],
      color: meta[3],
      icon: meta[4],
      params: meta[5],
    });
  }
  if (map.size < expected) {
    log?.(
      `  ⚠ batch short ${map.size}/${expected} (FW dropped AppConfig — often oversized meta)`,
    );
  } else {
    log?.(`  → ${map.size} apps`);
  }
  return map;
}

function transformLayout(layoutMsg, allApps) {
  const layout = [];
  let lastUsed = -1;
  let nextEmptyId = 16;
  layoutMsg.value[0].forEach((slot, idx) => {
    if (idx <= lastUsed) return;
    if (!slot) {
      lastUsed++;
      layout.push({ id: nextEmptyId++, app: null, startChannel: idx });
      return;
    }
    const [appId, channels, layoutId] = slot;
    const id = Number(appId);
    const app = allApps.get(id) ?? allApps.get(appId);
    if (!app) {
      lastUsed++;
      layout.push({ id: nextEmptyId++, app: null, startChannel: idx });
      return;
    }
    lastUsed = idx + Number(channels) - 1;
    layout.push({ id: Number(layoutId), app, startChannel: idx });
  });
  return layout;
}

function toLayoutFile(appLayout, paramsById, globalConfig, description) {
  return {
    version: 1,
    description,
    layout: appLayout.map(({ id, app, startChannel }) => {
      const lid = Number(id);
      const params =
        paramsById.get(lid) ??
        paramsById.get(id) ??
        paramsById.get(String(lid)) ??
        null;
      const hasParams = Array.isArray(params) && params.length > 0;
      // Keep appId even when params failed — dropping it made Pull throw
      // "Layout ohne Apps" whenever GetAllAppParams raced with Scopepunk.
      return {
        layoutId: lid,
        appId: app?.appId == null ? null : Number(app.appId),
        startChannel: Number(startChannel),
        params: hasParams ? params : null,
      };
    }),
    config: globalConfig,
  };
}

/**
 * Pull layout + params + global config from the device over SysEx.
 * @param {{ onLog?: (line: string) => void }} [opts]
 * @returns {Promise<{ setup: object, version: string, portSummary: string, ms: number }>}
 */
export async function pullSetupFromDevice(opts = {}) {
  const log = opts.onLog || (() => {});
  const t0 = Date.now();
  let device;
  try {
    log("Connecting via Web MIDI …");
    device = await connectSupportedDevice();
    log(`Connected · fw ${device.config.version} · ${device.portSummary}`);
    const { config } = device;

    const allApps = await getAllApps(config, log);

    log("GetLayout …");
    drainConfigQueue(config.rx);
    const layoutResponse = await sendAndReceiveExpect(
      config,
      { tag: "GetLayout" },
      "Layout",
      { onLog: log, timeoutMs: 4000, attempts: 12 },
    );
    const appLayout = transformLayout(layoutResponse, allApps);
    const appSlots = appLayout.filter((s) => s.app);
    log(`  → ${appSlots.length} app slot(s)`);

    log("GetAllAppParams …");
    const paramsById = new Map();
    try {
      const paramsResponse = await sendAndReceiveExpect(
        config,
        { tag: "GetAllAppParams" },
        "BatchMsgStart",
        { onLog: log, timeoutMs: 5000, attempts: 16 },
      );
      const paramMsgs = await receiveBatchMessages(config, paramsResponse.value);
      for (const item of paramMsgs) {
        if (item.tag !== "AppState") continue;
        const [layoutId, values] = item.value;
        const lid = Number(layoutId);
        // FW returns empty AppState during spawn — don't treat that as "CH1 defaults".
        if (Array.isArray(values) && values.length > 0) {
          paramsById.set(lid, values);
        }
      }
      log(`  → ${paramsById.size} param set(s) from batch`);
    } catch (e) {
      log(`  ⚠ batch failed (${e.message || e}) — per-slot GetAppParams …`);
    }

    // Scopepunk-style fallback: per-slot GetAppParams when the batch was empty
    // or incomplete (spawn window / timeout / stray Layout from other tabs).
    const fillMissingParams = async (label) => {
      for (const slot of appSlots) {
        const lid = Number(slot.id);
        if (paramsById.has(lid)) continue;
        log(`  ↻ GetAppParams layoutId=${lid}${label} …`);
        try {
          const st = await sendAndReceiveExpect(
            config,
            { tag: "GetAppParams", value: { layout_id: lid } },
            "AppState",
            { matchLayoutId: lid, onLog: log, timeoutMs: 5000, attempts: 10 },
          );
          const [id, values] = st.value;
          if (Number(id) === lid && Array.isArray(values) && values.length > 0) {
            paramsById.set(lid, values);
          }
        } catch (e) {
          log(`  ⚠ layoutId=${lid}: ${e.message || e}`);
        }
      }
    };

    await fillMissingParams(paramsById.size ? " (batch miss)" : "");
    if (paramsById.size < appSlots.length) {
      log("  ↻ retry missing params once …");
      await delay(400);
      drainConfigQueue(config.rx);
      await fillMissingParams(" (retry)");
    }
    log(`  → ${paramsById.size}/${appSlots.length} param set(s) total`);
    if (appSlots.length === 0) {
      throw new Error("Device layout is empty — nothing to pull");
    }
    if (paramsById.size === 0) {
      log(
        "  ⚠ no params read (cable busy?) — keeping app map; channels may default until re-pull",
      );
    }

    log("GetGlobalConfig …");
    const gcResponse = await sendAndReceiveExpect(
      config,
      { tag: "GetGlobalConfig" },
      "GlobalConfig",
      { onLog: log, timeoutMs: 4000, attempts: 12 },
    );

    const setup = toPlainJson(
      toLayoutFile(
        appLayout,
        paramsById,
        gcResponse.value,
        `Pulled ${new Date().toISOString()}`,
      ),
    );

    const ms = Date.now() - t0;
    log(`Pull done · ${(ms / 1000).toFixed(1)}s`);
    return { setup, version: device.config.version, portSummary: device.portSummary, ms };
  } finally {
    disconnectDevice(device);
  }
}

/**
 * Push a LayoutFile (version 1) to the device — same sequence as Configurator RecallSetup.
 * @param {object} setup
 * @param {{ onLog?: (line: string) => void }} [opts]
 */
export async function pushSetupToDevice(setup, opts = {}) {
  const log = opts.onLog || (() => {});
  const t0 = Date.now();
  if (!setup?.layout || !Array.isArray(setup.layout)) {
    throw new Error("Invalid setup: missing layout[]");
  }

  let device;
  try {
    log("Connecting via Web MIDI …");
    device = await connectSupportedDevice();
    log(`Connected · fw ${device.config.version} · ${device.portSummary}`);
    const deviceRef = { device };

    const allApps = await getAllApps(deviceRef.device.config, log);
    const { appLayout, paramsById } = buildAppLayout(setup, allApps, log);
    let config = await applySetLayoutIncremental(
      deviceRef.device.config,
      appLayout,
      paramsById,
      log,
      deviceRef,
    );
    device = deviceRef.device;

    if (setup.config) {
      log("SetGlobalConfig …");
      // Firmware does not ack SetGlobalConfig — fire-and-forget + brief settle.
      await sendMessage(config, {
        tag: "SetGlobalConfig",
        value: ensureWireGlobalConfig(setup.config),
      });
      await delay(200);
    }

    const ms = Date.now() - t0;
    log(`Push done · ${(ms / 1000).toFixed(1)}s`);
    return { ok: true, version: device.config.version, portSummary: device.portSummary, ms };
  } finally {
    disconnectDevice(device);
  }
}

/**
 * Live Presettings push: SetGlobalConfig only (clock, quantizer, AUX, MIDI outs).
 * Firmware does not ack — fire-and-forget + brief settle.
 * @param {object} globalConfig
 * @param {{ onLog?: (line: string) => void }} [opts]
 */
export async function pushGlobalConfigToDevice(globalConfig, opts = {}) {
  const log = opts.onLog || (() => {});
  const t0 = Date.now();
  if (!globalConfig || typeof globalConfig !== "object") {
    throw new Error("Invalid global config");
  }
  const wireConfig = ensureWireGlobalConfig(globalConfig);
  let device;
  try {
    log("Connecting via Web MIDI …");
    device = await connectSupportedDevice();
    log(`Connected · fw ${device.config.version} · ${device.portSummary}`);
    log("SetGlobalConfig …");
    await sendMessage(device.config, {
      tag: "SetGlobalConfig",
      value: wireConfig,
    });
    await delay(200);
    const ms = Date.now() - t0;
    log(`Global config live · ${(ms / 1000).toFixed(1)}s`);
    return { ok: true, ms, version: device.config.version };
  } finally {
    if (device) disconnectDevice(device);
  }
}

/**
 * Live structural push: SetLayout + SetAppParams for selected (or all) slots.
 * Used when swapping an app / adding / reordering — not a param-only tweak.
 *
 * Dense layouts use HoldPerfMute so FW parks heavy jack/MIDI init until
 * Release — otherwise the config cable wedges mid-spawn.
 *
 * @param {object} setup
 * @param {{
 *   onLog?: (line: string) => void,
 *   paramLayoutIds?: number[] | null,
 *   settleMs?: number,
 * }} [opts]
 */
export async function pushLiveStructureToDevice(setup, opts = {}) {
  const log = opts.onLog || (() => {});
  const settleMs = opts.settleMs ?? LAYOUT_SETTLE_LIVE_MS;
  const t0 = Date.now();
  if (!setup?.layout || !Array.isArray(setup.layout)) {
    throw new Error("Invalid setup: missing layout[]");
  }

  let device;
  let held = false;
  let postReleaseParams = false;
  let config;
  try {
    log("Connecting via Web MIDI …");
    device = await connectSupportedDevice();
    log(`Connected · fw ${device.config.version} · ${device.portSummary}`);
    const deviceRef = { device };
    const allApps = await getAllApps(deviceRef.device.config, log);
    const { appLayout, paramsById } = buildAppLayout(setup, allApps, log);
    const n = appLayout.filter((s) => s.app).length;
    const heavyN = partitionBySpawnWeight(appLayout).heavy.length;
    const needsHold = needsHoldForLayout(appLayout);

    config = deviceRef.device.config;
    if (needsHold) {
      await releasePerfMute(config, log, " (unstick)");
      await delay(300);
      try {
        await sendAndReceiveExpect(
          config,
          { tag: "HoldPerfMute" },
          "Pong",
          { timeoutMs: 2000, attempts: 2 },
        );
        held = true;
        postReleaseParams = true;
        log(`  HoldPerfMute (live dense · ${n} apps · ${heavyN} heavy)`);
        await delay(300);
      } catch {
        log("  ⚠ HoldPerfMute unavailable — continuing without hold");
      }
    }

    const ids =
      opts.paramLayoutIds == null
        ? null
        : opts.paramLayoutIds.map(Number).filter((n) => Number.isFinite(n));

    try {
      if (held) {
        const ordered = [...appLayout.filter((s) => s.app)].sort(compareSpawnOrder);
        config = await applySetLayout(
          config,
          [],
          log,
          LAYOUT_SETTLE_INCREMENTAL_MS,
          deviceRef,
          "SetLayout (clear old apps)",
          { quietMs: LAYOUT_CLEAR_QUIET_MS },
        );

        try {
          await probeConfigCable(config);
          log("  ✓ config cable alive after clear");
        } catch (e) {
          throw new Error(
            `USB dead after clear (before any spawn): ${e.message || e}`,
          );
        }

        clearCachedAppStates(config.rx);

        config = await applyHoldIncrementalSpawn(
          config,
          ordered,
          log,
          deviceRef,
        );
        device = deviceRef.device;
      } else {
        const spawnBudgetMs =
          n >= 8 ? estimateAtomicSpawnMs(n) : 0;
        const framMs = n >= 8 ? Math.max(2000, n * 400) : 0;
        const layoutStartedAt = Date.now();
        // Dense non-Hold: quiet only — GetVersion poll + reconnect mid-spawn
        // wedges the same way hold-dense did (Beta Semmy+Controls).
        config = await applySetLayout(
          config,
          appLayout,
          log,
          settleMs,
          deviceRef,
          undefined,
          spawnBudgetMs > 0 ? { quietMs: spawnBudgetMs } : {},
        );
        device = deviceRef.device;
        const staggerLeft = Math.max(0, spawnBudgetMs - (Date.now() - layoutStartedAt));
        if (staggerLeft > 0) {
          log(
            `  wait spawn stagger ${staggerLeft}ms (budget ${spawnBudgetMs}ms, no SysEx) …`,
          );
          await delayKeepalive(config, staggerLeft, {
            probe: false,
            label: "spawn stagger",
            onLog: log,
          });
        }
        if (framMs > 0) {
          log(`  wait post-gate FRAM ${framMs}ms (no SysEx) …`);
          await delayKeepalive(config, framMs, { probe: false });
        }
        config = await ensureCableAfterSpawn(config, deviceRef, log);
        config = await applySetAppParams(config, paramsById, ids, log, {
          deviceRef,
          underHold: false,
        });
      }
    } finally {
      if (postReleaseParams) {
        let skipPostReleaseParams = false;
        if (held) {
          let released = await releasePerfMute(config, log);
          if (released) {
            log("  quiet settle 5000ms after Release …");
            await delay(5000);
          } else {
            await delay(2000);
            try {
              await probeConfigCable(config);
            } catch (e) {
              log(`  ⚠ cable probe after Release fail: ${e.message || e}`);
            }
            released = await releasePerfMute(config, log, " (retry)");
            if (!released) {
              log(
                "  ⚠ Hold may still be set — skipping SetAppParams (replug USB, then Push again)",
              );
              skipPostReleaseParams = true;
            } else {
              log("  quiet settle 5000ms after Release …");
              await delay(5000);
            }
          }
        }
        if (!skipPostReleaseParams) {
          try {
            log("SetAppParams (post-release) …");
            clearCachedAppStates(config.rx);
            // GetAppParams can stay empty while handlers wake after Release; Set still applies.
            config = await applySetAppParams(config, paramsById, ids, log, {
              deviceRef,
              underHold: false,
              maxAttempts: 2,
              forceRestart: true,
              skipReadyWait: true,
            });
          } catch (e) {
            throw new Error(`post-release SetAppParams: ${e.message || e}`);
          }
        }
      }
    }

    const ms = Date.now() - t0;
    log(`Live structure done · ${(ms / 1000).toFixed(1)}s`);
    return { ok: true, ms, version: device.config.version };
  } finally {
    if (device) disconnectDevice(device);
  }
}

/**
 * Pure check: does the device Layout message place `layoutId` with `expectAppId`?
 * `layoutValue` is the Layout msg value: [ InnerLayout ] where InnerLayout is a
 * 16-slot array of undefined | [appId, channels, layoutId].
 * Returns { ok, reason, found } — `found` is { appId, channels, ch } when the
 * layoutId exists anywhere on the device.
 */
export function verifyLayoutSlot(layoutValue, layoutId, expectAppId) {
  const inner = Array.isArray(layoutValue?.[0]) ? layoutValue[0] : [];
  const id = Number(layoutId);
  for (let ch = 0; ch < inner.length; ch++) {
    const s = inner[ch];
    if (!s) continue;
    const [appId, channels, lid] = s;
    if (Number(lid) !== id) continue;
    if (expectAppId != null && Number(appId) !== Number(expectAppId)) {
      return {
        ok: false,
        reason: `layoutId=${id} is app ${appId} on device, editor expects ${expectAppId}`,
        found: { appId: Number(appId), channels: Number(channels), ch },
      };
    }
    return { ok: true, reason: null, found: { appId: Number(appId), channels: Number(channels), ch } };
  }
  return { ok: false, reason: `layoutId=${id} not in device layout`, found: null };
}

/**
 * Push params for a single layout_id only (no SetLayout).
 * Use after the device layout already matches the editor (one full Push first).
 * Pass `opts.expectAppId` to verify the device slot before writing — params
 * sent to a stale layoutId land in the wrong app (cross-app corruption).
 */
export async function pushAppParamsToDevice(layoutId, values, opts = {}) {
  const log = opts.onLog || (() => {});
  const id = Number(layoutId);
  if (!Number.isFinite(id) || id < 0 || id > 15) {
    throw new Error(`Invalid layoutId ${layoutId}`);
  }
  const hostPadded = padParams(values);
  let device;
  try {
    device = await connectSupportedDevice();
    const { config } = device;
    drainConfigQueue(config.rx);
    if (opts.expectAppId != null) {
      const layoutMsg = await sendAndReceiveExpect(
        config,
        { tag: "GetLayout" },
        "Layout",
        { onLog: log, timeoutMs: 4000, attempts: 6 },
      );
      const check = verifyLayoutSlot(layoutMsg.value, id, opts.expectAppId);
      if (!check.ok) {
        throw new Error(
          `Device layout out of sync (${check.reason}) — run a full Push before live edits.`,
        );
      }
    }
    log(`Live SetAppParams(layoutId=${id}) …`);
    log(`  · host wire: ${summarizeParamWire(hostPadded)}`);
    const deviceValues = (await fetchAppParamsValues(config, id, log)) ?? [];
    const sparse = buildSparseParams(values, deviceValues);
    if (!sparseHasDefinedSlots(sparse)) {
      log(`  ✓ layoutId=${id} (already matches device)`);
      return { ok: true, layoutId: id, n: deviceValues.length, version: device.config.version };
    }
    log(`  · sparse wire: ${summarizeParamWire(sparse)}`);
    let lastErr = null;
    for (let attempt = 0; attempt < SET_PARAMS_RETRIES; attempt++) {
      try {
        const { nvals } = await setAppParamsWithAckOrVerify(
          config,
          id,
          sparse,
          hostPadded,
          log,
        );
        return { ok: true, layoutId: id, n: nvals, version: device.config.version };
      } catch (e) {
        lastErr = e;
        log(
          `  ⚠ live SetAppParams(${id}) attempt ${attempt + 1}/${SET_PARAMS_RETRIES}: ${e.message || e}`,
        );
        await delay(400 + attempt * 300);
      }
    }
    throw lastErr || new Error(`SetAppParams(${id}) failed`);
  } finally {
    if (device) disconnectDevice(device);
  }
}
