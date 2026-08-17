/** Echolot param 15: packed ping/pong × note/cc (firmware contract). */
export const ECHOLOT_MIDI_MAP_IDX = 15;
export const ECHOLOT_MIDI_MAP_MAX = 0x0fffffff;

/**
 * @param {number} pingCc
 * @param {number} pongCc
 * @param {number} pingNote
 * @param {number} pongNote
 */
export function packEcholotMidiMap(pingCc, pongCc, pingNote, pongNote) {
  const pc = clamp7(pingCc, 32);
  const pg = clamp7(pongCc, 32);
  const pn = clamp7(pingNote, 60);
  const po = clamp7(pongNote, 60);
  return pc | (pg << 7) | (pn << 14) | (po << 21);
}

/** @param {number} map */
export function unpackEcholotMidiMap(map) {
  const m = Number(map) | 0;
  if (!m) return null;
  return {
    pingCc: m & 0x7f,
    pongCc: (m >> 7) & 0x7f,
    pingNote: (m >> 14) & 0x7f,
    pongNote: (m >> 21) & 0x7f,
  };
}

function clamp7(n, fallback = 0) {
  const v = Number(n);
  return Math.max(0, Math.min(127, Number.isFinite(v) ? v : fallback));
}

/**
 * Row → packed map for wire (single routing copies pong from ping).
 * @param {{ pingCc?: number, pongCc?: number, pingNote?: number, pongNote?: number, cc?: number, note?: number, echoRouting?: number, echoIo?: number }} row
 * @param {boolean} [pingPong]
 */
export function echolotMidiMapPacked(row, pingPong = false) {
  const pingCc = slot(row, "pingCc", row.cc, 32);
  const pingNote = slot(row, "pingNote", row.note, 60);
  let pongCc = slot(row, "pongCc", pingCc, pingCc);
  let pongNote = slot(row, "pongNote", pingNote, pingNote);
  if (!pingPong) {
    pongCc = pingCc;
    pongNote = pingNote;
  }
  return packEcholotMidiMap(pingCc, pongCc, pingNote, pongNote);
}

function slot(row, key, fallback, def) {
  const raw = row[key] ?? fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp7(n) : clamp7(def);
}
