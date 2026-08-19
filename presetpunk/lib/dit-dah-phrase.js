/** Dit Dah Phrase 1–9: 9× little-endian i32, 4 ASCII bytes each, NUL-terminated (max 36). */

export const DIT_DAH_PHRASE_PACKS = 9;
export const DIT_DAH_PHRASE_MAX = 36;
/** Firmware `DEFAULT_PHRASE_0` — `SOS\\0` LE. */
export const DIT_DAH_DEFAULT_PACK0 = 0x00534f53;

export function packDitDahPhrase(text) {
  const bytes = new Uint8Array(DIT_DAH_PHRASE_PACKS * 4);
  let o = 0;
  for (const ch of String(text ?? "")) {
    if (o >= DIT_DAH_PHRASE_MAX) break;
    let c = ch.charCodeAt(0);
    if (c >= 97 && c <= 122) c -= 32;
    if (c === 0 || c > 127) continue;
    bytes[o++] = c;
  }
  const view = new DataView(bytes.buffer);
  const out = [];
  for (let i = 0; i < DIT_DAH_PHRASE_PACKS; i++) {
    out.push(view.getInt32(i * 4, true));
  }
  return out;
}

export function unpackDitDahPhrase(packs) {
  const nums = Array.from({ length: DIT_DAH_PHRASE_PACKS }, (_, i) => {
    const p = packs?.[i];
    if (typeof p === "number") return p | 0;
    const n = Number(p?.value);
    return Number.isFinite(n) ? n | 0 : 0;
  });
  const buf = new ArrayBuffer(DIT_DAH_PHRASE_PACKS * 4);
  const view = new DataView(buf);
  for (let i = 0; i < DIT_DAH_PHRASE_PACKS; i++) {
    view.setInt32(i * 4, nums[i], true);
  }
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}
