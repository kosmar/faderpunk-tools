/**
 * Control Issues CC-window helpers.
 *
 * Firmware blinks the button LED on downbeat only when
 * `windowed_out > output_min` (see control_issues.rs). A collapsed
 * Output Min === Output Max window (classic Presetpunk mid-default of
 * 64/64) freezes the CC and kills that blink + scope movement.
 */

/**
 * @param {number} min
 * @param {number} max
 * @returns {{ min: number, max: number, healed: boolean }}
 */
export function healCollapsedCcWindow(min, max) {
  const a = Number(min);
  const b = Number(max);
  // Exact mid-default collapse from generic i32 midpoint seeding.
  if (a === 64 && b === 64) {
    return { min: 0, max: 127, healed: true };
  }
  return { min: a, max: b, healed: false };
}

/**
 * Mirror of firmware blink gate: active signal above the CC floor.
 * @param {number} windowedOut  Scaled 12-bit or 7-bit output
 * @param {number} outLo        CC window low (same units as windowedOut)
 */
export function controlIssuesButtonBlinkEligible(windowedOut, outLo) {
  return Number(windowedOut) > Number(outLo);
}

/**
 * Apply heal to catalog-aligned schemaValues in place.
 * @param {object[]} params  Catalog params
 * @param {object[]} schemaValues
 * @returns {boolean} whether anything changed
 */
export function healControlIssuesSchemaValues(params, schemaValues) {
  if (!Array.isArray(params) || !Array.isArray(schemaValues)) return false;
  let minI = -1;
  let maxI = -1;
  params.forEach((p, i) => {
    if (p?.tag !== "i32") return;
    const name = String(p.value?.name || "");
    if (/^Output Min$/i.test(name)) minI = i;
    if (/^Output Max$/i.test(name)) maxI = i;
  });
  if (minI < 0 || maxI < 0) return false;
  const minV = Number(schemaValues[minI]?.value);
  const maxV = Number(schemaValues[maxI]?.value);
  const { min, max, healed } = healCollapsedCcWindow(minV, maxV);
  if (!healed) return false;
  schemaValues[minI] = { tag: "i32", value: min };
  schemaValues[maxI] = { tag: "i32", value: max };
  return true;
}
