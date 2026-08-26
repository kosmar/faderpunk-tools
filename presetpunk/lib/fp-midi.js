/**
 * Browser entry: exposes window.FpMidi for the vanilla index.html script.
 */
import { pullSetupFromDevice, pushSetupToDevice, pushAppParamsToDevice, pushLiveStructureToDevice, pushGlobalConfigToDevice } from "./setup-io.js";
import { faderpunkPortsListed, isUsbWedgeError, USB_WEDGE_ERROR } from "./device.js";

window.FpMidi = {
  ready: true,
  faderpunkPortsListed,
  isUsbWedgeError,
  USB_WEDGE_ERROR,
  pullSetupFromDevice,
  pushSetupToDevice,
  pushAppParamsToDevice,
  pushLiveStructureToDevice,
  pushGlobalConfigToDevice,
};

window.dispatchEvent(new Event("fp-midi-ready"));
