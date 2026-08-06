#!/usr/bin/env node
// Push playground WIP layout without HoldPerfMute (not in current FW).
// One app at a time, cable keepalive between steps.
import { spawn, execFileSync } from "node:child_process";
import { serialize, deserialize } from "../vendor/fp-config/index.js";
import { buildConfigFrame, parseConfigFrame } from "../lib/sysex.js";

const RX_PORT = "Faderpunk";
const TX_PORT = "Faderpunk Config";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

function send(msg) {
  const frame = buildConfigFrame(serialize("ConfigMsgIn", msg));
  const inner = Array.from(frame.slice(1, -1)).map((b) =>
    b.toString(16).padStart(2, "0"),
  );
  execFileSync("sendmidi", ["dev", TX_PORT, "hex", "syx", ...inner]);
}

async function recv(tag, timeoutMs = 5000) {
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

function makeLayout(placed) {
  const arr = Array.from({ length: 16 }, () => undefined);
  for (const { ch, appId, channels, id } of placed) {
    arr[ch] = [appId, channels, id];
  }
  return [arr];
}

async function alive(label) {
  rxQueue.length = 0;
  send({ tag: "GetVersion" });
  const v = await recv("Version", 4000);
  log(`✓ ${label} · fw ${v.value.major}.${v.value.minor}.${v.value.patch}`);
}

async function setLayout(placed, label) {
  log(`SetLayout ${label}`);
  send({ tag: "SetLayout", value: makeLayout(placed) });
  await recv("Layout", 10000);
  log("  Layout ack");
}

async function waitSlot(id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    rxQueue.length = 0;
    send({ tag: "GetAppParams", value: { layout_id: id } });
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      while (rxQueue.length) {
        const msg = rxQueue.shift();
        if (msg.tag === "AppState" && Number(msg.value[0]) === id) {
          const n = Array.isArray(msg.value[1]) ? msg.value[1].length : 0;
          if (n > 0) {
            log(`  ✓ layoutId=${id} (${n} params)`);
            return;
          }
        }
      }
      await sleep(25);
    }
    try {
      await alive(`poll id=${id}`);
    } catch {
      throw new Error(`cable quiet while waiting layoutId=${id}`);
    }
    await sleep(350);
  }
  throw new Error(`layoutId=${id} not ready`);
}

/** Newest WIP left→right, then utility fillers. Super LFO = 2ch @6–7. */
const PLAYGROUND = [
  { ch: 0, appId: 38, channels: 1, id: 0, name: "Loop de Cay" },
  { ch: 1, appId: 37, channels: 1, id: 1, name: "Harmonica" },
  { ch: 2, appId: 36, channels: 1, id: 2, name: "Hold Sam" },
  { ch: 4, appId: 34, channels: 1, id: 4, name: "Arp de Lévy" },
  { ch: 5, appId: 33, channels: 1, id: 5, name: "Echolot" },
  { ch: 6, appId: 32, channels: 2, id: 6, name: "Super LFO" },
  { ch: 8, appId: 31, channels: 1, id: 7, name: "Golden Gate" },
  { ch: 9, appId: 30, channels: 1, id: 8, name: "Grooves" },
  { ch: 10, appId: 29, channels: 1, id: 9, name: "Heat Pump" },
  // Vamp last — previously stalled incremental push when early
  { ch: 3, appId: 35, channels: 1, id: 3, name: "Chord Vamp" },
  { ch: 11, appId: 14, channels: 1, id: 10, name: "Quantizer" },
  { ch: 12, appId: 1, channels: 1, id: 11, name: "Control" },
  { ch: 13, appId: 40, channels: 2, id: 12, name: "Venn" },
  { ch: 15, appId: 1, channels: 1, id: 13, name: "Control" },
];

await sleep(400);
await alive("start");

// Assume empty (or replace wholesale). Do NOT clear first if already empty —
// clear+heavy respawn is what kills the config cable.
const placed = [];
for (let i = 0; i < PLAYGROUND.length; i++) {
  const slot = PLAYGROUND[i];
  placed.push(slot);
  // Keep channel order in the wire layout (ids may be out of order when Vamp is last)
  const wire = [...placed].sort((a, b) => a.ch - b.ch);
  await setLayout(wire, `${i + 1}/${PLAYGROUND.length} ${slot.name} @ch${slot.ch}`);
  await sleep(slot.channels > 1 || i >= 8 ? 1200 : 700);
  await alive(`after ${slot.name}`);
  await waitSlot(slot.id, i >= 8 ? 50000 : 35000);
  await sleep(300);
}

send({ tag: "GetLayout" });
const lay = await recv("Layout");
for (let ch = 0; ch < 16; ch++) {
  const s = lay.value[0]?.[ch];
  if (s) log(`ch${String(ch).padStart(2)} app=${s[0]} n=${s[1]} id=${s[2]}`);
}
log("SUCCESS playground layout live");
rx.kill();
process.exit(0);
