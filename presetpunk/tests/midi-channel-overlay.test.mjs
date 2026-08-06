import test from "node:test";
import assert from "node:assert/strict";
import {
  overlayMidiChannelValue,
  shouldStampMidiChannelFromRowCh,
} from "../lib/midi-channel-overlay.js";

/** Simulate Control instrument select → overlay both MidiChannels from row.ch. */
function overlayControlChannels(rowCh, schemaChs) {
  const names = ["MIDI Channel", "Button Channel"];
  let ci = 0;
  const out = [...schemaChs];
  for (let i = 0; i < names.length; i++) {
    const { value, nextCi } = overlayMidiChannelValue({
      chs: null,
      rowCh,
      paramName: names[i],
      ci,
    });
    ci = nextCi;
    if (value != null) out[i] = value;
  }
  return out;
}

test("Control: instrument select overlays MIDI Channel and Button Channel from row.ch", () => {
  // Bug repro: schema still on CH 1 after picking an instrument on CH 14.
  const before = [1, 1];
  const after = overlayControlChannels(14, before);
  assert.deepEqual(after, [14, 14]);
});

test("Control: overlay does not leave stale schema when midiChCount > 1", () => {
  // Old broken rule (midiChCount === 1 only) left both slots untouched.
  const stale = overlayControlChannels(7, [3, 5]);
  assert.deepEqual(stale, [7, 7]);
});

test("named MIDI In CH is not clobbered without chs[]", () => {
  let ci = 0;
  const inHit = overlayMidiChannelValue({
    chs: null,
    rowCh: 14,
    paramName: "MIDI In CH",
    ci,
  });
  assert.equal(inHit.value, null);
  ci = inHit.nextCi;
  const outHit = overlayMidiChannelValue({
    chs: null,
    rowCh: 14,
    paramName: "MIDI Out CH",
    ci,
  });
  assert.equal(outHit.value, 14);
});

test("chs[] apps still use per-slot values", () => {
  let ci = 0;
  const a = overlayMidiChannelValue({
    chs: [2, 9],
    rowCh: 14,
    paramName: "MIDI In CH",
    ci,
  });
  assert.equal(a.value, 2);
  ci = a.nextCi;
  const b = overlayMidiChannelValue({
    chs: [2, 9],
    rowCh: 14,
    paramName: "MIDI Out CH",
    ci,
  });
  assert.equal(b.value, 9);
});

test("param stamp: Control stamps every MidiChannel (not only the first)", () => {
  let stampedOutCh = false;
  const names = ["MIDI Channel", "Button Channel"];
  const stamped = [];
  for (const name of names) {
    const r = shouldStampMidiChannelFromRowCh({
      sawMidiIn: false,
      sawMidiOut: false,
      stampedOutCh,
      paramName: name,
    });
    stampedOutCh = r.stampedOutCh;
    stamped.push(r.stamp);
  }
  assert.deepEqual(stamped, [true, true]);
});
