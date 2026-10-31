// -----------------------------------------------------------------------------
// Plausibility of a lifelong counter of the GEM (the energy index of a
// channel, its production index, a pulse counter). Pure. Taken from
// LM1LC3N7/gladys-p1-monitor `src/guard.js` (same author, Apache-2.0,
// approved), unchanged but for the margin, given per counter kind
// (src/constants.js GUARDS: kWh or pulses per hour, plus a slack).
//
// The core turns the deltas of an `index` feature into consumption and cost:
// it skips a delta below zero (a counter reset) but counts every rise IN
// FULL. So the rules:
// - a value of 0 (or below) is never published;
// - a value plausible after the last one published (not lower, not more than
//   `perHour` on average since then) goes through; a value EQUAL to it goes
//   through without moving its date, so that a frozen reading never shrinks
//   the margin of the next real rise;
// - a drop and a jump up are NEVER confirmed by repetition nor by time: they
//   are held (the last accepted value is sent again), shown in the status,
//   kept in /data across restarts, and taken only on an explicit gesture of
//   the user (`acceptHeld`, the "Accept the held counters" action, two
//   clicks);
// - the acceptance is BOUNDED: it covers the value shown (`held.to`, read at
//   `held.at`) and what may have been counted since (the margin), nothing
//   else; a value outside the bounds is held again and the acceptance
//   dropped;
// - an accepted value is a floor both ways: a value under it is held (never
//   counted), the acceptance kept and its margin counted from then;
// - while a jump is held, every value at or above it stays held: the margin
//   growing while nothing is published must never cover it;
// - a value back to the usual rule (the drop or the jump was a glitch) ends
//   the hold, but only within the margin counted from the hold itself.
//
// Dates are on the SESSION clock of the app (the wall clock read once at the
// start plus the monotonic time since), never the wall clock alone.
// -----------------------------------------------------------------------------

const HOUR = 3_600_000;

/** What may be counted between `from` and `to` (ms) with `limits` ({ perHour, slack }). */
export const marginOf = (limits, from, to) =>
  (limits.perHour * Math.max(0, to - from)) / HOUR + limits.slack;

const validLast = (last) =>
  last && Number.isFinite(last.value) && last.value > 0 && Number.isFinite(last.at)
    ? { value: last.value, at: last.at }
    : undefined;

const validHeld = (held) =>
  held &&
  (held.direction === 'up' || held.direction === 'down') &&
  [held.from, held.to, held.threshold, held.at].every(Number.isFinite)
    ? {
        direction: held.direction,
        from: held.from,
        to: held.to,
        threshold: held.threshold,
        at: held.at,
      }
    : undefined;

export class CounterGuard {
  /**
   * `limits`: { perHour, slack } of the counter kind.
   * `last`: the value Gladys already holds (`{ value, at }`), when known.
   * `saved`: the state kept in /data (`state()`), so that a value held back
   * stays held across a restart. `loadedAt`: when it is loaded; a value held
   * read back from /data is dated then (its old date would widen the range
   * an acceptance takes).
   */
  constructor(limits, last, saved, loadedAt) {
    this.limits = limits;
    const kept = validLast(saved?.last);
    const known = validLast(last);
    if (kept && known && kept.value === known.value) {
      // The same value: its OLDEST date, the margin of the next rise counts from it.
      this.last = { value: kept.value, at: Math.min(kept.at, known.at) };
    } else {
      // Otherwise the most recent reference wins.
      this.last = kept && (!known || kept.at >= known.at) ? kept : known;
    }
    /**
     * A value held back until the user accepts it:
     * `{ direction: 'up' | 'down', from, to, threshold, at }`, `to` the last
     * value held, read at `at`. For a jump up, every value at or above
     * `threshold` stays held whatever the time.
     */
    const keptHeld = this.last ? validHeld(saved?.held) : undefined;
    this.held = keptHeld && Number.isFinite(loadedAt) ? { ...keptHeld, at: loadedAt } : keptHeld;
    /** The acceptance of the user: `{ direction, to, at }`, the value shown then. */
    this.accepted = undefined;
  }

  /** What may be counted between `from` and `to`. */
  margin(from, to) {
    return marginOf(this.limits, from, to);
  }

  /** Whether `value` may follow `previous` (both `{ value, at }`). */
  follows(previous, value, at) {
    return value >= previous.value && value - previous.value <= this.margin(previous.at, at);
  }

  /** What /data keeps: the reference and the value held (never an acceptance). */
  state() {
    return { last: this.last ?? null, held: this.held ?? null };
  }

  /**
   * The user accepts the value held, as shown now. Returns what will be
   * counted (`{ direction, from, to }`), or undefined when nothing is held.
   */
  acceptHeld() {
    if (!this.held) {
      return undefined;
    }
    const { direction, from, to, at } = this.held;
    this.accepted = { direction, to, at };
    return { direction, from, to };
  }

  /** Whether `value` is within the acceptance: the value shown, plus the margin since. */
  withinAccepted(value, at) {
    const { to, at: since } = this.accepted;
    const top = to + this.margin(since, at);
    // Both ways a floor: an accepted drop is no licence for a lower value later.
    return value >= to && value <= top;
  }

  /** Whether `value`, read at `at`, may be published. A published value becomes the reference. */
  accept(value, at) {
    if (!Number.isFinite(value) || value <= 0) {
      return false;
    }
    if (!this.last) {
      return this.take(value, at);
    }
    if (value === this.last.value) {
      // Unchanged (a frozen reading): published, its date NOT moved.
      this.release();
      return true;
    }
    if (this.accepted) {
      if (this.withinAccepted(value, at)) {
        return this.take(value, at);
      }
      if (value < this.accepted.to) {
        // Under the floor accepted (a glitch): held, shown, never counted; the
        // acceptance stays for the value listed, which may come back.
        this.held = { direction: 'down', from: this.last.value, to: value, threshold: value, at };
        // Its margin counts from now: a long glitch never widens it.
        this.accepted = { ...this.accepted, at };
        return false;
      }
      // Above what the user accepted: held again, the acceptance dropped.
      this.accepted = undefined;
    }
    const up = this.held?.direction === 'up';
    if (up && value >= this.held.threshold) {
      // Held, however long ago the last value was published.
      this.held = { ...this.held, to: value, at };
      return false;
    }
    // While a value is held, the margin since the reference (maybe days old)
    // is not enough: the value must also fit the short margin counted from
    // the hold. Otherwise it becomes the value held itself, its kWh shown,
    // nothing billed without the user.
    const sinceHold = !this.held || value - this.last.value <= this.margin(this.held.at, at);
    if (sinceHold && this.follows(this.last, value, at)) {
      return this.take(value, at);
    }
    const direction = value > this.last.value ? 'up' : 'down';
    this.held = {
      direction,
      from: this.last.value,
      to: value,
      threshold: direction === 'up' && up ? Math.min(value, this.held.threshold) : value,
      at,
    };
    return false;
  }

  release() {
    this.held = undefined;
    this.accepted = undefined;
  }

  take(value, at) {
    this.last = { value, at };
    this.release();
    return true;
  }
}
