import {
  cachedAppState,
  clearCachedAppStates,
  connectDevice,
  disconnectDevice,
  drainConfigQueue,
  receiveBatchMessages,
  sendAndReceive,
  sendAndReceiveExpect,
  sendMessage,
} from "./device.js";

/** Live app swap / row edit — one (or few) slots respawn, shorter settle. */
const LAYOUT_SETTLE_LIVE_MS = 3500;
/** Incremental Full Push: one new app per SetLayout — short settle + cable poll. */
const LAYOUT_SETTLE_INCREMENTAL_MS = 2000;
const SET_PARAMS_RETRIES = 4;
/** Pause after SetAppParams: firmware respawns the app (param_handler exits). */
const SET_PARAMS_GAP_MS = 900;
/** Host wait per attempt. Firmware may spend up to ~8s in FRAM before AppState. */
const SET_PARAMS_TIMEOUT_MS = 15000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sleep without going SysEx-silent for long stretches — macOS/Web MIDI can
 * drop the config port after ~1min of idle during a long Full Push.
 */
async function delayKeepalive(config, ms) {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const left = end - Date.now();
    const slice = Math.min(left, 1200);
    await delay(slice);
    if (Date.now() >= end) break;
    try {
      await probeConfigCable(config);
    } catch {
      // spawn may still be muting replies briefly — ignore until settle
    }
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
 * Apps that stall Embassy spawn when introduced early in an incremental Hold
 * push. Wire layout still uses startChannel; only *addition* order is deferred
 * (see tools/push-playground.mjs — Chord Vamp last).
 */
const SPAWN_DEFER_APP_IDS = new Set([
  35, // vamp / Chord Vamp
]);

/**
 * Incremental spawn order: light apps first, deferred/heavy last.
 * Final positions remain startChannel via buildSendLayout.
 */
export function compareSpawnOrder(a, b) {
  const aDefer = SPAWN_DEFER_APP_IDS.has(Number(a.app?.appId)) ? 1 : 0;
  const bDefer = SPAWN_DEFER_APP_IDS.has(Number(b.app?.appId)) ? 1 : 0;
  if (aDefer !== bDefer) return aDefer - bDefer;
  const aWide = Number(a.app?.channels) > 1 ? 1 : 0;
  const bWide = Number(b.app?.channels) > 1 ? 1 : 0;
  if (aWide !== bWide) return aWide - bWide;
  return compareChannelOrder(a, b);
}

function isHeavySpawnSlot(slot, index, total) {
  const channels = Number(slot.app?.channels) || 1;
  if (channels > 1) return true;
  if (SPAWN_DEFER_APP_IDS.has(Number(slot.app?.appId))) return true;
  // Dense tail: last stretch of a packed layout (pool pressure).
  return index >= Math.max(6, total - 5);
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

/** Coerce editor/JSON quirks into postcard Value shapes. */
export function normalizeValueForWire(v) {
  if (!v || typeof v !== "object" || !("tag" in v)) return v;
  const tag = v.tag;
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
  return v;
}

export function padParams(values) {
  const result = Array.from({ length: 16 }, () => undefined);
  (values || []).forEach((v, i) => {
    if (i < 16) result[i] = normalizeValueForWire(v);
  });
  return result;
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
 * GetVersion works during LAYOUT_USB_MIDI_MUTE; SetAppParams does not (empty
 * AppState). Poll GetAppParams until the slot actually has a param_handler.
 * @param {{ label?: string }} [opts]
 */
async function waitForSlotReady(
  config,
  layoutId,
  log,
  timeoutMs = 12000,
  opts = {},
) {
  const id = Number(layoutId);
  const label = opts.label ? ` ${opts.label}` : "";
  log(`  wait layoutId=${id}${label} ready (not muted / spawned) …`);
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  // #region agent log
  fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'pre-fix',hypothesisId:'A,B,C',location:'setup-io.js:waitForSlotReady:start',message:'slot readiness wait started',data:{layoutId:id,label:opts.label||'',timeoutMs,inputState:config.input?.state,inputConnection:config.input?.connection,outputState:config.output?.state,outputConnection:config.output?.connection,queueLength:config.rx?.queue?.length??-1},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  let lastDetail = "no reply";
  let emptyStreak = 0;
  let warnedScope = false;
  let checkedLayout = false;
  while (Date.now() < deadline) {
    try {
      const cached = cachedAppState(config.rx, id);
      const cachedValues = cached?.value?.[1];
      if (Array.isArray(cachedValues) && cachedValues.length > 0) {
        // #region agent log
        fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'post-fix',hypothesisId:'E,F',location:'setup-io.js:waitForSlotReady:cached',message:'slot readiness satisfied from cached AppState',data:{layoutId:id,paramCount:cachedValues.length,elapsedMs:Date.now()-startedAt},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        log(`  ✓ layoutId=${id} ready (${cachedValues.length} params · cached)`);
        return config;
      }
      drainConfigQueue(config.rx);
      // Host wait must exceed FW GetAppParams timeout under Hold (400ms) and
      // the non-hold 3s path — otherwise we desync SysEx and never recover.
      const response = await sendAndReceiveExpect(
        config,
        { tag: "GetAppParams", value: { layout_id: id } },
        "AppState",
        { timeoutMs: 5000, attempts: 2, matchLayoutId: id },
      );
      const n = Array.isArray(response.value?.[1])
        ? response.value[1].length
        : Array.isArray(response.value?.values)
          ? response.value.values.length
          : 0;
      // #region agent log
      fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'pre-fix',hypothesisId:'A,C',location:'setup-io.js:waitForSlotReady:response',message:'slot readiness response received',data:{layoutId:id,paramCount:n,elapsedMs:Date.now()-startedAt,emptyStreak,queueLength:config.rx?.queue?.length??-1},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (n > 0) {
        log(`  ✓ layoutId=${id} ready (${n} params)`);
        return config;
      }
      emptyStreak++;
      lastDetail = "empty AppState (mute or not spawned)";
      // Once: confirm the layoutId is actually on the device (not a phantom wait).
      if (emptyStreak >= 3 && !checkedLayout) {
        checkedLayout = true;
        try {
          drainConfigQueue(config.rx);
          const lay = await sendAndReceiveExpect(
            config,
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
      if (emptyStreak >= 6 && !warnedScope) {
        warnedScope = true;
        log(
          "  ⚠ still empty — close Scopepunk / other tabs on the config MIDI cable",
        );
      }
      await delay(Math.min(1200, 300 + emptyStreak * 80));
      continue;
    } catch (e) {
      lastDetail = e.message || String(e);
      // #region agent log
      fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'pre-fix',hypothesisId:'A,B,C',location:'setup-io.js:waitForSlotReady:error',message:'slot readiness request failed',data:{layoutId:id,elapsedMs:Date.now()-startedAt,lastDetail,emptyStreak,inputState:config.input?.state,inputConnection:config.input?.connection,outputState:config.output?.state,outputConnection:config.output?.connection,queueLength:config.rx?.queue?.length??-1},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (String(lastDetail).includes("missing from device")) throw e;
      // Resync probe — if Version works, keep polling; if not, surface cable death.
      try {
        await probeConfigCable(config);
        // #region agent log
        fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'pre-fix',hypothesisId:'A,C',location:'setup-io.js:waitForSlotReady:probe-ok',message:'config cable probe recovered',data:{layoutId:id,elapsedMs:Date.now()-startedAt},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      } catch (cableErr) {
        // #region agent log
        fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'pre-fix',hypothesisId:'A,B,D',location:'setup-io.js:waitForSlotReady:probe-failed',message:'config cable probe failed after slot timeout',data:{layoutId:id,elapsedMs:Date.now()-startedAt,error:cableErr.message||String(cableErr),inputState:config.input?.state,inputConnection:config.input?.connection,outputState:config.output?.state,outputConnection:config.output?.connection},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        throw new Error(
          `layoutId=${id} not ready; config cable quiet (${cableErr.message || cableErr}). Close Scopepunk / Configurator, then retry.`,
        );
      }
    }
    await delay(250);
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
  deviceRef.device = await connectDevice();
  log(
    `  reconnected · fw ${deviceRef.device.config.version} · ${deviceRef.device.portSummary}`,
  );
  await assertConfigCableAlive(deviceRef.device.config, log);
  log("  ✓ config cable alive after reconnect");
  return deviceRef.device.config;
}

/**
 * Full Push: clear/reap old tasks, apply final layout once, then wait slots.
 *
 * Repeated growing SetLayout calls outrun firmware 1.11 task reaping and stall
 * reproducibly on the ninth layout generation. A single atomic SetLayout
 * creates only one new generation. The clear/reap phase prevents old and new
 * static app pools from overlapping; readiness polling then follows firmware's
 * channel spawn order before parameters are written.
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
  const ordered = [...activeSlots].sort(compareChannelOrder);
  log(
    `Atomic SetLayout (${n} apps): ${ordered
      .map((s) => `${s.app?.name || s.app?.appId}(ch${Number(s.startChannel) || 0})`)
      .join(" → ")}`,
  );
  let cfg = config;

  // Aborted older Pushes may have left the device held. Release once, then
  // leave it released so Embassy can reap old tasks between SetLayout calls.
  try {
    await sendAndReceiveExpect(
      cfg,
      { tag: "ReleasePerfMute" },
      "Pong",
      { timeoutMs: 1500, attempts: 1 },
    );
    log("  ReleasePerfMute (ensure task reaping is active)");
    await delay(500);
  } catch {
    /* already released / older firmware */
  }

  // SetLayout starts replacements before every old app task has necessarily
  // returned its static Embassy pool slot. With a dense old layout this leaves
  // later apps present in Layout but permanently without a param_handler.
  // Clear first and give exit handlers a quiet reap window; keep probing so
  // Web MIDI does not disappear during the pause.
  cfg = await applySetLayout(
    cfg,
    [],
    log,
    LAYOUT_SETTLE_INCREMENTAL_MS,
    deviceRef,
    "SetLayout (clear old tasks)",
    {
      headStartMs: 1000,
      pollBudgetMs: 4000,
    },
  );
  log("  reap old app tasks 10s …");
  await delayKeepalive(cfg, 10_000);

  clearCachedAppStates(cfg.rx);
  cfg = await applySetLayout(
    cfg,
    appLayout,
    log,
    LAYOUT_SETTLE_INCREMENTAL_MS,
    deviceRef,
    `SetLayout (final ${n} apps)`,
    {
      headStartMs: 1800,
      pollBudgetMs: Math.max(10_000, n * 900),
    },
  );
  // #region agent log
  fetch('http://127.0.0.1:7576/ingest/41b51123-b6e7-4b40-9f7e-a932ea3db83f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0439c1'},body:JSON.stringify({sessionId:'0439c1',runId:'pre-fix',hypothesisId:'A,B,D',location:'setup-io.js:applySetLayoutIncremental:final-settled',message:'final layout settle completed',data:{slotCount:n,ordered:ordered.map(s=>({id:Number(s.id),appId:s.app?.appId,startChannel:Number(s.startChannel)})),inputState:cfg.input?.state,inputConnection:cfg.input?.connection,outputState:cfg.output?.state,outputConnection:cfg.output?.connection,queueLength:cfg.rx?.queue?.length??-1},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  log(`  wait ${n} slots in channel spawn order …`);
  for (const slot of ordered) {
    const label = `${slot.app?.name || slot.app?.appId}(ch${Number(slot.startChannel) || 0})`;
    await waitForSlotReady(cfg, slot.id, log, 90_000, {
      label,
      expectAppId: slot.app?.appId,
    });
    await delay(250);
  }

  const ids = ordered.map((s) => Number(s.id));
  log("  SetAppParams (all) …");
  await applySetAppParams(cfg, paramsById, ids, log);
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
        deviceRef.device = await connectDevice();
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

async function applySetAppParams(config, paramsById, layoutIds, log) {
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
    await waitForSlotReady(config, id, log, 75_000, {
      label: "before params",
    });
    let lastErr = null;
    for (let attempt = 0; attempt < SET_PARAMS_RETRIES; attempt++) {
      try {
        drainConfigQueue(config.rx);
        const response = await sendAndReceiveExpect(
          config,
          {
            tag: "SetAppParams",
            value: {
              layout_id: id,
              values: padParams(values),
            },
          },
          "AppState",
          { onLog: log, timeoutMs: SET_PARAMS_TIMEOUT_MS, matchLayoutId: id },
        );
        const nvals = Array.isArray(response.value[1])
          ? response.value[1].length
          : 0;
        if (nvals === 0) {
          throw new Error(
            `SetAppParams(${id}): empty AppState (slot not running — pool/spawn?)`,
          );
        }
        log(`  ✓ layoutId=${id} (${nvals} params)`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log(
          `  ⚠ SetAppParams(${id}) attempt ${attempt + 1}/${SET_PARAMS_RETRIES}: ${e.message || e}`,
        );
        const wait = String(e.message || e).includes("empty AppState")
          ? 2500
          : 1000 + attempt * 600;
        await delay(wait);
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
    await assertConfigCableAlive(config, log);
    log("  ✓ config cable alive after params");
  } catch (e) {
    log(`  ⚠ ${e.message || e}`);
  }
}

async function getAllApps(config, log) {
  log?.("GetAllApps …");
  const response = await sendAndReceiveExpect(
    config,
    { tag: "GetAllApps" },
    "BatchMsgStart",
    { onLog: log || (() => {}), timeoutMs: 5000, attempts: 12 },
  );
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
  log?.(`  → ${map.size} apps`);
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
    device = await connectDevice();
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
    device = await connectDevice();
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
        value: setup.config,
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
  let device;
  try {
    log("Connecting via Web MIDI …");
    device = await connectDevice();
    log(`Connected · fw ${device.config.version} · ${device.portSummary}`);
    log("SetGlobalConfig …");
    await sendMessage(device.config, {
      tag: "SetGlobalConfig",
      value: globalConfig,
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
  try {
    log("Connecting via Web MIDI …");
    device = await connectDevice();
    log(`Connected · fw ${device.config.version} · ${device.portSummary}`);
    const deviceRef = { device };
    const allApps = await getAllApps(deviceRef.device.config, log);
    const { appLayout, paramsById } = buildAppLayout(setup, allApps, log);
    const config = await applySetLayout(
      deviceRef.device.config,
      appLayout,
      log,
      settleMs,
      deviceRef,
    );
    device = deviceRef.device;
    const ids =
      opts.paramLayoutIds == null
        ? null
        : opts.paramLayoutIds.map(Number).filter((n) => Number.isFinite(n));
    await applySetAppParams(config, paramsById, ids, log);
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
  const padded = padParams(values);
  let device;
  try {
    device = await connectDevice();
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
    let lastErr = null;
    for (let attempt = 0; attempt < SET_PARAMS_RETRIES; attempt++) {
      try {
        drainConfigQueue(config.rx);
        const response = await sendAndReceiveExpect(
          config,
          {
            tag: "SetAppParams",
            value: { layout_id: id, values: padded },
          },
          "AppState",
          { onLog: log, timeoutMs: SET_PARAMS_TIMEOUT_MS, matchLayoutId: id },
        );
        const n = Array.isArray(response.value[1]) ? response.value[1].length : 0;
        if (n === 0) {
          throw new Error(
            `empty AppState — slot ${id} not running (spawn/pool?). Full Push layout first.`,
          );
        }
        log(`  ✓ layoutId=${id} (${n} params)`);
        return { ok: true, layoutId: id, n, version: device.config.version };
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
