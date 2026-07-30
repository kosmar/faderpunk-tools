/** Host MIDI clock (24 PPQN) for driving the device when Clock Src = MIDI USB. */

/**
 * Lookahead scheduler: `MIDIOutput.send(data, timestamp)` queues ticks in the
 * browser MIDI clock, so main-thread jank / Chrome background timer clamping
 * does not stretch the musical grid the way a naive `setInterval(…, 20ms)` does.
 */
export class HostClock {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bpm = 120;
  private outputs: MIDIOutput[] = [];
  private running = false;
  /** Absolute `performance.now()` time of the next 0xF8 to queue. */
  private nextTickAt = 0;
  private visBound = false;

  isRunning() {
    return this.running;
  }

  getBpm() {
    return this.bpm;
  }

  setOutputs(outputs: MIDIOutput[]) {
    this.outputs = outputs;
  }

  setBpm(bpm: number) {
    this.bpm = Math.max(20, Math.min(300, Math.round(Number(bpm) || 120)));
    // Do NOT restartTicks() while running — Web MIDI cannot cancel already
    // queued F8s (up to lookahead). Restarting would double-clock the device
    // with old+new tempos until the stale queue drains (feels stuck until
    // Stop/Panic/Start). New interval applies as pump continues from
    // `nextTickAt` after the pending ticks play out.
    if (this.running && this.timer) this.pump();
  }

  /** Send Start (0xFA) and begin clock ticks. */
  start() {
    this.ensureVisibilityHook();
    this.send(0xfa);
    this.running = true;
    this.restartTicks();
  }

  /** Send Continue (0xFB) and ensure ticks are running. */
  continue() {
    this.ensureVisibilityHook();
    this.send(0xfb);
    this.running = true;
    if (!this.timer) this.restartTicks();
  }

  /** Stop ticks and send Stop (0xFC). */
  stop() {
    this.clearTicks();
    this.running = false;
    this.send(0xfc);
  }

  /** Silence ticks without Stop (e.g. disconnect). */
  halt() {
    this.clearTicks();
    this.running = false;
  }

  /**
   * Pause ticks while keeping `running` true (hidden browser tab).
   * Prefer the lookahead pump instead — kept for callers that still opt in.
   */
  pauseTicks() {
    this.clearTicks();
  }

  /** Resume ticks after `pauseTicks` if still marked running. */
  resumeTicks() {
    if (this.running && !this.timer) this.restartTicks();
  }

  private tickIntervalMs() {
    return 60_000 / (this.bpm * 24);
  }

  /**
   * How far ahead to queue. Must survive main-thread stalls (scope rAF + SysEx)
   * without emptying — but long queues make live BPM changes lag until the
   * old F8s drain (Web MIDI cannot cancel scheduled sends).
   * Hidden tabs get a longer buffer because Chrome clamps timers to ~1 Hz.
   */
  private lookaheadMs() {
    if (typeof document !== "undefined" && document.hidden) return 2000;
    return 450;
  }

  private restartTicks() {
    this.clearTicks();
    this.nextTickAt = performance.now();
    this.pump();
    // Pump often while visible; when hidden Chrome clamps this to ~1 Hz,
    // which is fine because lookahead then covers >1 s of ticks.
    this.timer = setInterval(() => this.pump(), 25);
  }

  private pump() {
    if (!this.running || this.outputs.length === 0) return;
    const interval = this.tickIntervalMs();
    const now = performance.now();
    // If we fell far behind (tab freeze), jump forward instead of flooding.
    if (this.nextTickAt < now - interval * 2) {
      this.nextTickAt = now;
    }
    const horizon = now + this.lookaheadMs();
    while (this.nextTickAt <= horizon) {
      this.sendAt(0xf8, this.nextTickAt);
      this.nextTickAt += interval;
    }
  }

  private clearTicks() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureVisibilityHook() {
    if (this.visBound || typeof document === "undefined") return;
    this.visBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!this.running) return;
      // Entering background: fill a long queue before Chrome sleeps the timer.
      // Returning: catch up so the first audible beat isn't late.
      this.pump();
    });
  }

  private send(status: number) {
    for (const output of this.outputs) {
      try {
        output.send([status]);
      } catch (err) {
        console.warn("Host MIDI clock send failed:", err);
      }
    }
  }

  private sendAt(status: number, when: number) {
    for (const output of this.outputs) {
      try {
        output.send([status], when);
      } catch (err) {
        // Some stacks reject timestamps — fall back to immediate send.
        try {
          output.send([status]);
        } catch (err2) {
          console.warn("Host MIDI clock send failed:", err2 ?? err);
        }
      }
    }
  }
}

export const hostClock = new HostClock();
