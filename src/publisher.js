// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute: push() keeps
// the current value of a feature (the last one wins) with the time it was
// received; unchanged values are skipped by publishChangedStates and sent
// again every 30 min (only when the GEM reported them again). Whatever is
// left over (budget spent, Gladys unreachable) waits for the next flush,
// every second, but never longer than a minute: an older value is dropped,
// never published as the current one. Never energy consumption. Taken from
// LM1LC3N7/gladys-stiebel-eltron (same author, Apache-2.0), with the age.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, now, timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    /** A monotonic clock. */
    this.now = now;
    this.timers = timers;
    /** featureId -> { value: { state } | { text }, at } */
    this.pending = new Map();
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, { value, at: this.now() });
  }

  clear() {
    this.pending.clear();
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.send().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async send() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < MINUTE);
    for (const [featureId, { at }] of this.pending) {
      if (now - at > TIMINGS.valueMaxAge) this.pending.delete(featureId);
    }
    const room = Math.min(LIMITS.statesPerMinute - this.window.length, LIMITS.statesPerRequest);
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, entry] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ id: featureId, entry });
    }
    try {
      const result = await this.gladys.publishChangedStates(
        batch.map(({ id, entry }) => ({ device_feature_external_id: id, ...entry.value })),
        { heartbeat: TIMINGS.stateHeartbeat },
      );
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.window.push(now);
      }
    } catch (err) {
      // Kept for the next round (within its age), unless a newer value arrived meanwhile.
      for (const { id, entry } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, entry);
        }
      }
      throw err;
    }
  }
}
