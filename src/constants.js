// -----------------------------------------------------------------------------
// Frozen keys, limits and timings.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** The manifest actions (keys frozen). */
export const ACTIONS = Object.freeze({ ACCEPT_HELD: 'accept_held_counters' });

/** The sub-container the GEM connects to (manifest `containers`). */
export const LINK = Object.freeze({
  name: 'gem-link',
  portName: 'gem',
  gemPort: 8000,
  channelPort: 7779,
});

/** The device type of the external ids: `ext:<selector>:greeneye:<slug>`. */
export const DEVICE_TYPE = 'greeneye';

/** The plausibility of the lifelong counters (src/guard.js): per hour, plus a slack. */
export const GUARDS = Object.freeze({
  /** kWh of one channel: 100 kW on average (a 200 A CT at 240 V is 48 kW). */
  energy: Object.freeze({ perHour: 100, slack: 0.5 }),
  /** Pulses of one counter: 100 pulses a second on average. */
  pulses: Object.freeze({ perHour: 360_000, slack: 100 }),
});

/** Values outside these bounds are not measurements (never published). */
export const BOUNDS = Object.freeze({
  voltage: Object.freeze({ min: 50, max: 300 }),
  current: Object.freeze({ min: 0, max: 400 }),
  /** W, signed: negative while a NET channel produces. */
  power: Object.freeze({ min: -200_000, max: 200_000 }),
  /** °C, after the conversion from °F (the 1-Wire sensors of the GEM: -55 to 125 °C). */
  temperature: Object.freeze({ min: -55, max: 125 }),
});

export const LIMITS = Object.freeze({
  /** Open TCP connections on the GEM port, all sources together. */
  linkSockets: 4,
  /** Packets a session may send per packetsWindow (the GEM sends one every 1 to 255 s). */
  packets: 40,
  packetsWindow: 10 * SECOND,
  /** Bytes skipped (junk, malformed packets) per session before it is closed. */
  skippedBytes: 64 * 1024,
  /** An incomplete packet older than this closes the connection. */
  packetStall: 5 * SECOND,
  /** Messages the link keeps while the main container is away. */
  linkQueue: 100,
  /** A refused connection is told to the main container at most this often. */
  refusedNoticeEvery: 10 * SECOND,
  /** Gladys accepts 300 states a minute: 250 leaves room. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** Text length in a status. */
  status: 900,
  /** Counters listed in the status (the rest summed up). */
  heldListed: 6,
});

export const TIMINGS = Object.freeze({
  /** The background round: status, link, freshness. */
  tick: 10 * SECOND,
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Packets older than this (kept by the link while this container was away) are dropped. */
  valueMaxAge: MINUTE,
  /** The counters (indexes, pulses) are checked and published once a minute at most. */
  indexInterval: MINUTE,
  /** The seconds counted by the GEM may differ this much (or 5 %) from the session clock. */
  gemClockTolerance: 2 * MINUTE,
  /** "The GEM restarted" stays in the status this long. */
  restartNotice: 10 * MINUTE,
  /** The power is computed over two packets at most this far apart (GEM seconds). */
  powerMaxGap: HOUR,
  /**
   * Seconds this close below the last packet: an old packet in the same
   * connection (dropped), a restart of the GEM in a new one (taken).
   */
  staleSeconds: 600,
  /** No packet for max(staleMin, 3 × the measured interval), capped at staleMax: stale. */
  staleMin: 2 * MINUTE,
  staleMax: 15 * MINUTE,
  /** The link is started again at most this often while it is not running. */
  linkRetry: MINUTE,
  /** getConfig() retried after a failure: 5 s, 10 s, 30 s, 1 min, then every 2 min. */
  configRetry: [5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE],
  /** A link running whose channel never comes up for this long is started again... */
  linkSilent: 3 * MINUTE,
  /** ...at most this often. */
  linkForceSpacing: 10 * MINUTE,
  /** /data: a read or a write not done within this is given up (a FIFO, a frozen mount). */
  dataTimeout: 5 * SECOND,
  /** The guards are written to /data at most this often while nothing is held. */
  guardSaveEvery: 10 * MINUTE,
  /** "Accept the held counters": the second click, from 3 s to 5 min after the first. */
  acceptAfter: 3 * SECOND,
  acceptWithin: 5 * MINUTE,
});
