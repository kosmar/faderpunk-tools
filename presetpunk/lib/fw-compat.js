/** First firmware whose GlobalConfig matches current postcard bindings.
 *  Bump `MIN_FIRMWARE` + `MIN_FIRMWARE_LABEL` (and i18n `fw.header` / `fw.tooOld*`)
 *  whenever that wire shape grows — see faderpunk-firmware-bootsel skill
 *  (Presetpunk + GitHub Pages → firmware floor).
 */
export const MIN_FIRMWARE = { major: 1, minor: 12, patch: 0 };
export const MIN_FIRMWARE_LABEL = "1.12.0-beta.0";
/** `/releases/latest` skips prereleases and currently lands on 1.11.0. */
export const FIRMWARE_RELEASES_URL =
  "https://github.com/ATOVproject/faderpunk/releases";

export const FIRMWARE_TOO_OLD_CODE = "FIRMWARE_TOO_OLD";

export function parseFwVersion(raw) {
  const m = String(raw ?? "")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function cmpFw(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isFirmwareTooOld(version) {
  const parsed = parseFwVersion(version);
  if (!parsed) return true;
  return cmpFw(parsed, MIN_FIRMWARE) < 0;
}

export class FirmwareTooOldError extends Error {
  constructor(have) {
    const shown = have || "unknown";
    super(
      `Firmware ${shown} is too old — Presetpunk needs ≥ ${MIN_FIRMWARE_LABEL}`,
    );
    this.name = "FirmwareTooOldError";
    this.code = FIRMWARE_TOO_OLD_CODE;
    this.have = shown;
    this.need = MIN_FIRMWARE_LABEL;
    this.url = FIRMWARE_RELEASES_URL;
  }
}

export function isFirmwareTooOldError(err) {
  return (
    err?.code === FIRMWARE_TOO_OLD_CODE || err?.name === "FirmwareTooOldError"
  );
}

export function assertFirmwareSupported(version) {
  if (isFirmwareTooOld(version)) {
    throw new FirmwareTooOldError(version);
  }
}
