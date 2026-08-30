/**
 * Browser entry: exposes window.FpMidi for the vanilla index.html script.
 */
import { pullSetupFromDevice, pushSetupToDevice, pushAppParamsToDevice, pushLiveStructureToDevice, pushGlobalConfigToDevice } from "./setup-io.js";
import { faderpunkPortsListed, isUsbWedgeError, USB_WEDGE_ERROR } from "./device.js";
import {
  FIRMWARE_RELEASES_URL,
  MIN_FIRMWARE_LABEL,
  isFirmwareTooOldError,
} from "./fw-compat.js";

window.FpMidi = {
  ready: true,
  faderpunkPortsListed,
  isUsbWedgeError,
  USB_WEDGE_ERROR,
  isFirmwareTooOldError,
  FIRMWARE_RELEASES_URL,
  MIN_FIRMWARE_LABEL,
  pullSetupFromDevice,
  pushSetupToDevice,
  pushAppParamsToDevice,
  pushLiveStructureToDevice,
  pushGlobalConfigToDevice,
};

window.dispatchEvent(new Event("fp-midi-ready"));
