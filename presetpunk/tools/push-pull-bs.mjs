#!/usr/bin/env node
/**
 * Push Break Science (bank) → device, then pull & compare key params.
 * Uses sendmidi/receivemidi (no Web MIDI). Applies grooves Enum fix:
 * only first Enum = genre; Jack/CV Dest preserved from schema.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serialize, deserialize } from "../vendor/fp-config/index.js";
import { buildConfigFrame, parseConfigFrame } from "../lib/sysex.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RX_PORT = "Faderpunk";
const TX_PORT = "Faderpunk Config";

const APP_ID = {
  control: 1,
  bernoulli: 27,
  heat_pump: 29,
  grooves: 30,
  fibonacci_gate: 31,
  super_lfo: 32,
  echolot: 33,
  lfo_plus: 22,
};
const APP_CH = {
  control: 1,
  bernoulli: 2,
  heat_pump: 1,
  grooves: 1,
  fibonacci_gate: 1,
  super_lfo: 2,
  echolot: 1,
  lfo_plus: 2,
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(...a) {
  console.log(`[${ts()}]`, ...a);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rxQueue = [];
let rxBuf = "";
const rx = spawn("receivemidi", ["dev", RX_PORT]);
rx.stdout.on("data", (chunk) => {
  rxBuf += chunk.toString();
  let idx;
  while ((idx = rxBuf.indexOf("\n")) >= 0) {
    const line = rxBuf.slice(0, idx).trim();
    rxBuf = rxBuf.slice(idx + 1);
    const m = line.match(/system-exclusive\s+(?:hex\s+)?([0-9A-Fa-f ]+?)(?:\s+dec)?$/);
    if (!m) continue;
    const bytes = m[1].trim().split(/\s+/).map((h) => parseInt(h, 16));
    const payload = parseConfigFrame(new Uint8Array([0xf0, ...bytes, 0xf7]));
    if (!payload) continue;
    try {
      rxQueue.push(deserialize("ConfigMsgOut", payload).value);
    } catch {
      /* ignore */
    }
  }
});
rx.stderr.on("data", () => {});
function drainRx() {
  rxQueue.length = 0;
}
function send(msg) {
  const frame = buildConfigFrame(serialize("ConfigMsgIn", msg));
  const inner = Array.from(frame.slice(1, -1)).map((b) => b.toString(16).padStart(2, "0"));
  execFileSync("sendmidi", ["dev", TX_PORT, "hex", "syx", ...inner]);
}
async function recv(tag, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    while (rxQueue.length) {
      const msg = rxQueue.shift();
      if (msg.tag === tag) return msg;
    }
    await sleep(20);
  }
  throw new Error(`timeout ${tag}`);
}
async function request(msg, tag, timeoutMs = 4000) {
  drainRx();
  send(msg);
  return recv(tag, timeoutMs);
}

function makeLayout(placed) {
  const arr = Array.from({ length: 16 }, () => undefined);
  for (const { ch, appId, channels, id } of placed) arr[ch] = [appId, channels, id];
  return [arr];
}

async function hold() {
  await request({ tag: "HoldPerfMute" }, "Pong", 3000);
}
async function release() {
  await request({ tag: "ReleasePerfMute" }, "Pong", 5000);
}

async function waitSlotReady(id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    drainRx();
    send({ tag: "GetAppParams", value: { layout_id: id } });
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      while (rxQueue.length) {
        const msg = rxQueue.shift();
        if (msg.tag === "AppState" && Number(msg.value[0]) === id) {
          const n = Array.isArray(msg.value[1]) ? msg.value[1].length : 0;
          if (n > 0) return msg.value[1];
        }
      }
      await sleep(25);
    }
    await sleep(200);
  }
  throw new Error(`slot ${id} not ready`);
}

function color(tag) {
  return { tag: "Color", value: { tag } };
}
function ch(n) {
  return { tag: "MidiChannel", value: [Math.max(1, Math.min(16, Number(n) || 1))] };
}
function cc(n) {
  return { tag: "MidiCc", value: [Math.max(0, Math.min(127, Number(n) || 0))] };
}
function note(n) {
  return { tag: "MidiNote", value: [Math.max(0, Math.min(127, Number(n) || 0))] };
}
function enumVal(n) {
  return { tag: "Enum", value: Number(n) || 0 };
}
function i32(n) {
  return { tag: "i32", value: Number(n) };
}
function bool(v) {
  return { tag: "bool", value: !!v };
}
function range(tag = "_0_10V") {
  return { tag: "Range", value: { tag } };
}
function out(flags = [true, true, false]) {
  return { tag: "MidiOut", value: [flags] };
}
function nrpn(v = false) {
  return { tag: "MidiNrpn", value: !!v };
}
function midiIn(flags = [true, true]) {
  return { tag: "MidiIn", value: [flags] };
}
function curve(tag = "Linear") {
  return { tag: "Curve", value: { tag } };
}

/** Build push vector: prefer schemaValues, overlay denormalized row fields (fixed). */
function paramsForRow(row) {
  const c = Number(row.ch) || 1;
  const n = Number(row.cc) || 0;
  const col = row.color || "Orange";
  const cvR = row.cvRange || "_0_10V";
  const flags = [true, true, false];

  // If full schema present, clone + overlay custom fields
  if (Array.isArray(row.schemaValues) && row.schemaValues.length > 0) {
    const sv = structuredClone(row.schemaValues);
    if (row.app === "grooves") {
      const chs = row.chs || [c, c + 1, c + 2];
      const notes = row.ccs || [36, 38, 42];
      if (sv[0]?.tag === "MidiNote") sv[0] = note(notes[0]);
      if (sv[1]?.tag === "MidiChannel") sv[1] = ch(chs[0]);
      if (sv[2]?.tag === "MidiNote") sv[2] = note(notes[1]);
      if (sv[3]?.tag === "MidiChannel") sv[3] = ch(chs[1]);
      if (sv[4]?.tag === "MidiNote") sv[4] = note(notes[2]);
      if (sv[5]?.tag === "MidiChannel") sv[5] = ch(chs[2]);
      // Genre / Swing / Jack / Dest / GATE / Att: trust schemaValues (UI source).
      if (sv[9]?.tag === "Color") sv[9] = color(col);
    }
    if (row.app === "echolot") {
      const chs = row.chs || [c, c, Math.min(16, c + 1)];
      if (sv[0]?.tag === "Enum") sv[0] = enumVal(row.echoIo ?? sv[0].value);
      if (sv[1]?.tag === "Enum") sv[1] = enumVal(row.echoDelayMode ?? sv[1].value);
      if (sv[2]?.tag === "i32") sv[2] = i32(row.echoMaxMs ?? sv[2].value);
      if (sv[3]?.tag === "Enum") sv[3] = enumVal(row.echoInterval ?? sv[3].value);
      if (sv[4]?.tag === "Enum") sv[4] = enumVal(row.echoRouting ?? sv[4].value);
      if (sv[5]?.tag === "Enum") sv[5] = enumVal(row.echoSignal ?? sv[5].value);
      if (sv[7]?.tag === "Color") sv[7] = color(col);
      if (sv[9]?.tag === "MidiChannel") sv[9] = ch(chs[0]);
      if (sv[11]?.tag === "MidiChannel") sv[11] = ch(chs[1]);
      if (sv[12]?.tag === "MidiChannel") sv[12] = ch(chs[2]);
      if (sv[13]?.tag === "MidiCc") sv[13] = cc(n);
      if (sv[14]?.tag === "MidiNote") sv[14] = note(row.note ?? 36);
    }
    if (row.app === "fibonacci_gate") {
      if (sv[0]?.tag === "MidiChannel") sv[0] = ch(c);
      if (sv[1]?.tag === "MidiNote") sv[1] = note(row.note ?? n);
      if (sv[2]?.tag === "MidiCc") sv[2] = cc(n);
      if (sv[4]?.tag === "Enum" && row.gateSpeed != null) sv[4] = enumVal(row.gateSpeed);
      if (sv[5]?.tag === "Color") sv[5] = color(col);
      if (sv[11]?.tag === "Enum" && row.gateMode != null) sv[11] = enumVal(row.gateMode);
    }
    if (row.app === "lfo_plus" || row.app === "super_lfo") {
      if (sv[0]?.tag === "Enum" && row.lfoSpeed != null) sv[0] = enumVal(row.lfoSpeed);
      if (sv[2]?.tag === "MidiChannel") sv[2] = ch(c);
      if (sv[3]?.tag === "MidiCc") sv[3] = cc(n);
      if (sv[4]?.tag === "Color") sv[4] = color(col);
    }
    if (row.app === "super_lfo") {
      if (sv[8]?.tag === "Enum" && row.mixMode != null) sv[8] = enumVal(row.mixMode);
      if (sv[9]?.tag === "Enum" && row.oscB != null) sv[9] = enumVal(row.oscB);
      if (sv[10]?.tag === "i32" && row.mixBalance != null) sv[10] = i32(row.mixBalance);
      if (sv[11]?.tag === "i32" && row.rateModDepth != null) sv[11] = i32(row.rateModDepth);
      if (sv[12]?.tag === "Enum" && row.cvDest != null) sv[12] = enumVal(row.cvDest);
    }
    if (row.app === "control") {
      if (sv[2]?.tag === "MidiChannel") sv[2] = ch(c);
      if (sv[3]?.tag === "MidiCc") sv[3] = cc(n);
      if (sv[6]?.tag === "Color") sv[6] = color(col);
    }
    if (row.app === "heat_pump") {
      if (sv[0]?.tag === "Color") sv[0] = color(col);
      if (sv[2]?.tag === "MidiChannel") sv[2] = ch(c);
      if (sv[3]?.tag === "MidiCc") sv[3] = cc(n);
    }
    if (row.app === "bernoulli") {
      if (sv[0]?.tag === "MidiChannel") sv[0] = ch(c);
      if (sv[4]?.tag === "Color") sv[4] = color(col);
    }
    return sv;
  }

  // Defaults when schemaValues empty (common for LFO+/Heat/Super/Control in bank)
  switch (row.app) {
    case "grooves": {
      const chs = row.chs || [7, 8, 9];
      const notes = row.ccs || [36, 38, 42];
      const groove = row.groove != null ? row.groove : 3;
      const swing = row.swingMax != null ? row.swingMax : 50;
      return [
        note(notes[0]), ch(chs[0]), note(notes[1]), ch(chs[1]), note(notes[2]), ch(chs[2]),
        enumVal(groove), i32(swing), i32(40), color(col), out(flags),
        enumVal(0), range(cvR), enumVal(0), i32(100),
      ];
    }
    case "lfo_plus":
      return [
        enumVal(row.lfoSpeed ?? 0), range(cvR), ch(c), cc(n),
        color(col), nrpn(false), out(flags), bool(true),
      ];
    case "super_lfo":
      return [
        enumVal(row.lfoSpeed ?? 0), range(cvR), ch(c), cc(n),
        color(col), nrpn(false), out(flags), bool(true),
        enumVal(row.mixMode ?? 0), enumVal(row.oscB ?? 0),
        i32(row.mixBalance ?? 50), i32(row.rateModDepth ?? 50),
        enumVal(row.cvDest ?? 0),
      ];
    case "heat_pump":
      return [
        color(col), range(cvR), ch(c), cc(n), nrpn(false), out(flags),
        enumVal(0), enumVal(0), i32(100),
      ];
    case "control":
      return [
        curve("Linear"), range(cvR), ch(c), cc(n),
        bool(false), bool(false), color(col), bool(false),
        enumVal(0), ch(c), cc(n), nrpn(false), out(flags),
      ];
    case "bernoulli":
      return [ch(c), note(n), note(n), i32(40), color(col), out(flags)];
    case "fibonacci_gate":
      return [
        ch(c), note(row.note ?? n), cc(n), i32(40),
        enumVal(row.gateSpeed ?? 8), color(col), out(flags),
        enumVal(0), range(cvR), enumVal(0), i32(100), enumVal(row.gateMode ?? 0),
      ];
    case "echolot": {
      const chs = row.chs || [c, c, Math.min(16, c + 1)];
      return [
        enumVal(row.echoIo ?? 0), enumVal(row.echoDelayMode ?? 0),
        i32(row.echoMaxMs ?? 500), enumVal(row.echoInterval ?? 0),
        enumVal(row.echoRouting ?? 0), enumVal(row.echoSignal ?? 0),
        range(cvR), color(col), midiIn([true, true]),
        ch(chs[0]), out(flags), ch(chs[1]), ch(chs[2]),
        cc(n), note(row.note ?? 36),
      ];
    }
    default:
      throw new Error(`no defaults for ${row.app}`);
  }
}

function summarize(vals) {
  const enums = vals.filter((v) => v?.tag === "Enum").map((v) => v.value);
  const i32s = vals
    .filter((v) => v?.tag === "i32")
    .map((v) => (Array.isArray(v.value) ? v.value[0] : v.value));
  const chs = vals
    .filter((v) => v?.tag === "MidiChannel")
    .map((v) => (Array.isArray(v.value) ? v.value[0] : v.value));
  const ccs = vals
    .filter((v) => v?.tag === "MidiCc")
    .map((v) => (Array.isArray(v.value) ? v.value[0] : v.value));
  const col = vals.find((v) => v?.tag === "Color")?.value?.tag;
  return { enums, i32s, chs, ccs, col, n: vals.length };
}

function padParams(values) {
  const result = Array.from({ length: 16 }, () => undefined);
  (values || []).forEach((v, i) => {
    if (i >= 16 || !v) return;
    let next = v;
    if (
      (v.tag === "i32" || v.tag === "f32" || v.tag === "Enum" || v.tag === "bool") &&
      Array.isArray(v.value)
    ) {
      next = { tag: v.tag, value: v.value[0] };
    } else if (
      v.tag === "MidiOut" &&
      Array.isArray(v.value) &&
      v.value.length === 3 &&
      typeof v.value[0] === "boolean"
    ) {
      next = { tag: "MidiOut", value: [v.value] };
    }
    result[i] = next;
  });
  return result;
}

async function setAppParams(id, values) {
  drainRx();
  send({ tag: "SetAppParams", value: { layout_id: id, values: padParams(values) } });
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    while (rxQueue.length) {
      const msg = rxQueue.shift();
      if (msg.tag === "AppState" && Number(msg.value[0]) === id) {
        const got = Array.isArray(msg.value[1]) ? msg.value[1] : [];
        if (got.length) return got;
      }
    }
    await sleep(25);
  }
  throw new Error(`SetAppParams(${id}) no AppState`);
}

async function main() {
  const bank = JSON.parse(readFileSync(join(ROOT, "out/preset-bank.json"), "utf8"));
  const preset = bank.presets.find((p) => p.name === "Break Science");
  if (!preset) throw new Error("Break Science not in bank");

  const v = await request({ tag: "GetVersion" }, "Version", 3000);
  log(`fw ${v.value.major}.${v.value.minor}.${v.value.patch}`);

  // Build placed slots: startChannel accumulates
  let start = 0;
  const placed = [];
  const wantById = new Map();
  for (let i = 0; i < preset.rows.length; i++) {
    const row = preset.rows[i];
    const appId = APP_ID[row.app];
    const channels = APP_CH[row.app];
    if (appId == null) throw new Error(`unknown app ${row.app}`);
    const id = i;
    placed.push({ ch: start, appId, channels, id, app: row.app });
    const params = paramsForRow(row);
    wantById.set(id, { app: row.app, params, sum: summarize(params) });
    start += channels;
  }

  log("PUSH: HoldPerfMute …");
  await hold();
  try {
    log("PUSH: clear layout …");
    await request({ tag: "SetLayout", value: makeLayout([]) }, "Layout", 4000);
    await sleep(1500);

    const growing = [];
    for (const slot of placed) {
      growing.push(slot);
      log(`PUSH: layout +${slot.app}@ch${slot.ch} id=${slot.id} …`);
      await request({ tag: "SetLayout", value: makeLayout(growing) }, "Layout", 4000);
      await sleep(500);
      await waitSlotReady(slot.id);
      const want = wantById.get(slot.id);
      log(`PUSH: SetAppParams id=${slot.id} (${want.sum.n}) enums=${JSON.stringify(want.sum.enums)} …`);
      const got = await setAppParams(slot.id, want.params);
      const gsum = summarize(got);
      const ok =
        JSON.stringify(gsum.enums) === JSON.stringify(want.sum.enums) &&
        JSON.stringify(gsum.i32s) === JSON.stringify(want.sum.i32s);
      log(`  → ack enums=${JSON.stringify(gsum.enums)} i32s=${JSON.stringify(gsum.i32s)} ${ok ? "✓" : "≠"}`);
      await sleep(200);
    }
  } finally {
    await release().catch(() => {});
  }

  log("PULL: GetLayout + GetAppParams …");
  await sleep(400);
  const lay = await request({ tag: "GetLayout" }, "Layout", 4000);
  const slots = lay.value[0] || [];
  let diffs = 0;
  for (let ch = 0; ch < slots.length; ch++) {
    const s = slots[ch];
    if (!s) continue;
    const [appId, channels, id] = s;
    const want = wantById.get(Number(id));
    const vals = await waitSlotReady(Number(id));
    const gsum = summarize(vals);
    if (!want) {
      log(`PULL ch${ch} app=${appId} id=${id} (unexpected) ${JSON.stringify(gsum)}`);
      continue;
    }
    const match =
      JSON.stringify(gsum.enums) === JSON.stringify(want.sum.enums) &&
      JSON.stringify(gsum.i32s) === JSON.stringify(want.sum.i32s) &&
      JSON.stringify(gsum.chs) === JSON.stringify(want.sum.chs) &&
      JSON.stringify(gsum.ccs) === JSON.stringify(want.sum.ccs);
    if (!match) diffs++;
    log(
      `PULL ch${ch} ${want.app} id=${id} ${match ? "OK" : "DIFF"}` +
        `\n  want enums=${JSON.stringify(want.sum.enums)} i32=${JSON.stringify(want.sum.i32s)} chs=${JSON.stringify(want.sum.chs)} ccs=${JSON.stringify(want.sum.ccs)} col=${want.sum.col}` +
        `\n  got  enums=${JSON.stringify(gsum.enums)} i32=${JSON.stringify(gsum.i32s)} chs=${JSON.stringify(gsum.chs)} ccs=${JSON.stringify(gsum.ccs)} col=${gsum.col}`,
    );
    await sleep(80);
  }

  if (diffs) {
    log(`DONE with ${diffs} DIFF(s)`);
    process.exit(1);
  }
  log("DONE — all params match");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
