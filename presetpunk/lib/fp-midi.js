/**
 * Browser entry: exposes window.FpMidi for the vanilla index.html script.
 */
import { pullSetupFromDevice, pushSetupToDevice, pushAppParamsToDevice, pushLiveStructureToDevice, pushGlobalConfigToDevice } from "./setup-io.js";

window.FpMidi = {
  ready: true,
  pullSetupFromDevice,
  pushSetupToDevice,
  pushAppParamsToDevice,
  pushLiveStructureToDevice,
  pushGlobalConfigToDevice,
};

window.dispatchEvent(new Event("fp-midi-ready"));
