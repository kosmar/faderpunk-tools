/** Firmware panic beacon: CC on MIDI channel 16 of the perf port, once a second. */
export const PANIC_BEACON_STATUS = 0xbf;
export const PANIC_CC_MARKER = 110;
export const PANIC_CC_LINE_LO = 111;
export const PANIC_CC_LINE_HI = 112;
export const PANIC_CC_HASH_LO = 113;
export const PANIC_CC_HASH_MID = 114;
export const PANIC_CC_HASH_HI = 115;

const PANIC_CCS = new Set([
  PANIC_CC_MARKER,
  PANIC_CC_LINE_LO,
  PANIC_CC_LINE_HI,
  PANIC_CC_HASH_LO,
  PANIC_CC_HASH_MID,
  PANIC_CC_HASH_HI,
]);

/**
 * Collect beacon CCs across messages — the six values arrive as separate
 * MIDI packets and the listener may join mid-burst.
 * @returns {{ feed: (data: Uint8Array | number[]) => void, result: () => ({ line: number, hash: number } | null) }}
 */
export function createPanicBeaconCollector() {
  const seen = new Map();

  function feed(data) {
    if (!data || data.length < 3) return;
    if (data[0] !== PANIC_BEACON_STATUS) return;
    const cc = data[1];
    if (!PANIC_CCS.has(cc)) return;
    seen.set(cc, data[2] & 0x7f);
  }

  function result() {
    if (!seen.has(PANIC_CC_MARKER)) return null;
    const at = (cc) => seen.get(cc) ?? 0;
    return {
      line: at(PANIC_CC_LINE_LO) | (at(PANIC_CC_LINE_HI) << 7),
      hash:
        at(PANIC_CC_HASH_LO) |
        (at(PANIC_CC_HASH_MID) << 7) |
        (at(PANIC_CC_HASH_HI) << 14),
    };
  }

  return { feed, result };
}

/**
 * @param {{ line: number, hash: number } | null} site
 * @param {Record<string, string>} [files] `files` map from panic-files.json
 * @returns {string | null}
 */
export function formatPanicSite(site, files) {
  if (!site) return null;
  const key = Number(site.hash).toString(16).padStart(6, "0");
  const path = files?.[key];
  if (path) return `${path}:${site.line}`;
  return `unknown source (hash 0x${key}) line ${site.line}`;
}
