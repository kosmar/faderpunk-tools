/**
 * MidiChannel overlay rules for Presetpunk column → schema sync.
 *
 * Keep in sync with `applyColumnOverlaysToSchema` / param stampers in index.html.
 */

/**
 * @param {object} args
 * @param {number[] | null | undefined} args.chs  Per-slot channels (Grids/Grooves/Echolot/Harmonica), or null
 * @param {number} args.rowCh  Denormalized row.ch (instrument / primary Out CH)
 * @param {string} [args.paramName]  Catalog param name (e.g. "MIDI Channel", "MIDI In CH")
 * @param {number} args.ci  Index among MidiChannel params so far
 * @returns {{ value: number | null, nextCi: number }}
 *   `value === null` → leave existing schema value alone
 */
export function overlayMidiChannelValue({ chs, rowCh, paramName = "", ci }) {
  const n = Math.max(1, Math.min(16, Number(rowCh) || 1));
  if (Array.isArray(chs) && ci < chs.length) {
    return { value: Number(chs[ci]), nextCi: ci + 1 };
  }
  if (!Array.isArray(chs)) {
    // Control: MIDI Channel + Button Channel (no per-slot chs) — both follow instrument.
    // Named "… In …" must not inherit Out/instrument CH (Harmonica/Echolot defensive).
    if (/\bin\b/i.test(String(paramName || ""))) {
      return { value: null, nextCi: ci + 1 };
    }
    return { value: n, nextCi: ci + 1 };
  }
  // chs present but exhausted — keep schema
  return { value: null, nextCi: ci + 1 };
}

/**
 * Whether a MidiChannel param should receive row.ch when stamping flat param lists
 * (no dedicated chs[] helper for the app).
 *
 * @param {object} args
 * @param {boolean} args.sawMidiIn
 * @param {boolean} args.sawMidiOut
 * @param {boolean} args.stampedOutCh
 * @param {string} [args.paramName]
 * @returns {{ stamp: boolean, stampedOutCh: boolean }}
 */
export function shouldStampMidiChannelFromRowCh({
  sawMidiIn,
  sawMidiOut,
  stampedOutCh,
  paramName = "",
}) {
  if (sawMidiOut && !stampedOutCh) {
    return { stamp: true, stampedOutCh: true };
  }
  if (!sawMidiIn) {
    // Classic apps without MidiIn (Control MIDI + Button, LFO, …): every
    // non-In MidiChannel follows row.ch — not only the first.
    if (/\bin\b/i.test(String(paramName || ""))) {
      return { stamp: false, stampedOutCh };
    }
    return { stamp: true, stampedOutCh };
  }
  return { stamp: false, stampedOutCh };
}
