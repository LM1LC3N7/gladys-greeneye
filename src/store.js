// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in greeneye.json, readable by the container user only (0600):
//
//   token    the secret of the channel between this container and the
//            `gem-link` sub-container (random, generated here, given to the
//            link in its environment). Not a user secret: it only proves to
//            each side that the other one is ours.
//   linkEnv  16 hex characters of the hash of the environment the link was
//            last started with (the link is started again only when it changes)
//   serial   the serial number of the GEM followed (pinned: the packets of
//            another GEM are refused until its serial is typed in the
//            configuration); `typed` whether it came from the configuration
//            (a field cleared then follows the first GEM heard again)
//   format   the packet format last seen (BIN48-NET...), for the status
//   serials  a list, oldest first, one entry per serial number (8 at most,
//            the most recent kept; a list keeps the order), never
//            wiped by a change of serial (a mistyped serial then the right
//            one keeps every hold):
//     seen    the channels, production channels, temperature sensors and
//             pulse counters seen working (the Discovery is rebuilt from them)
//     guards  per counter (`ch<n>`, `ch<n>-prod`, `pulse-<n>`): the last value
//             accepted and the value held back, session dates (src/app.js)
//     wraps   per raw counter of the GEM (`abs-<n>`, `pol-<n>`, `pulse-<n>`):
//             the last raw value and the offset added by the wraps of its
//             5-byte (2^40 Ws) or 3-byte (2^24) field
//     gem     the seconds counter of the GEM in its last packet and the
//             session date it came (a wrap is taken only when the GEM ran on)
//
// Never waits without bound (lessons of gladys-gce and gladys-ipx800 0.1.3):
// the file is opened non-blocking, a special file (FIFO, device) is refused,
// at most 256 KiB are read, and the app races every read and write against
// a timer (TIMINGS.dataTimeout). A file that exists but cannot be read is not
// "nothing kept": it is never overwritten (src/app.js). Read back bounded,
// only known keys of the expected shape (never an inherited or `__proto__`
// key).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { MAX_CHANNELS, MAX_SERIAL } from './config.js';
import { NUM_PULSE_COUNTERS, NUM_TEMPERATURE_SENSORS } from './gem/packets.js';

export const STATE_FILE = '/data/greeneye.json';
const MAX_BYTES = 256 * 1024;

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
export const isToken = (value) => typeof value === 'string' && TOKEN.test(value);
export const newToken = () => randomBytes(32).toString('base64url');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A failure of /data, with a short code (never a path or a content). */
const failure = (code) =>
  Object.assign(new Error(`/data: ${code}`), { code: String(code).slice(0, 20) });

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** null when there is no file yet; throws when it exists but cannot be read. */
    async load() {
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw failure(err?.code ?? 'EIO');
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw failure('not_file');
        if (info.size > MAX_BYTES) throw failure('too_large');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let size = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > MAX_BYTES) throw failure('too_large');
        }
        try {
          return JSON.parse(buffer.subarray(0, size).toString('utf8'));
        } catch {
          throw failure('not_json');
        }
      } finally {
        await handle.close().catch(() => {});
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        // Whatever sits there (a FIFO would block a plain open) is removed,
        // then the file is created anew, non-blocking, never followed.
        await rm(temporary, { force: true });
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK,
          0o600,
        );
        try {
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close().catch(() => {});
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/**
 * For the tests: the same JSON round trip as the file. `failing` refuses
 * every save, `unreadable` every load; `hold` (a promise) makes saves wait,
 * `loadHold` the load (a frozen /data).
 */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    unreadable,
    hold: undefined,
    loadHold: undefined,
    async load() {
      if (this.loadHold) await this.loadHold;
      if (this.unreadable) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hold) await this.hold;
      if (this.failing) {
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

export const emptySeen = () => ({
  channels: new Set(),
  produced: new Set(),
  temps: new Set(),
  pulses: new Set(),
});

export const emptyUnit = () => ({ seen: emptySeen(), guards: {}, wraps: {}, gem: undefined });

export const emptyMemory = () => ({
  token: undefined,
  linkEnv: undefined,
  serial: undefined,
  typed: false,
  format: undefined,
  /** serial -> { seen, guards, wraps } */
  serials: new Map(),
});

export const MAX_SERIALS = 8;

const SEEN_LIMITS = {
  channels: MAX_CHANNELS,
  produced: MAX_CHANNELS,
  temps: NUM_TEMPERATURE_SENSORS,
  pulses: NUM_PULSE_COUNTERS,
};

/** The keys of the counters: `ch<n>`, `ch<n>-prod`, `pulse-<n>`. */
export const GUARD_KEY = /^(?:ch([1-9]|[1-3]\d|4[0-8])(?:-prod)?|pulse-[1-4])$/;
/** The keys of the raw counters of the GEM: `abs-<n>`, `pol-<n>`, `pulse-<n>`. */
export const WRAP_KEY = /^(?:(?:abs|pol)-(?:[1-9]|[1-3]\d|4[0-8])|pulse-[1-4])$/;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isSerial = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_SERIAL;

/** A reference or a hold read from /data, its date bounded by `now` (a future date is now). */
function guardEntry(raw, now) {
  if (!isObject(raw)) return undefined;
  const ref = (r) =>
    isObject(r) && finite(r.value) && r.value > 0 && finite(r.at) && r.at > 0
      ? { value: r.value, at: Math.min(r.at, now) }
      : null;
  const last = ref(raw.last);
  let held = null;
  if (
    last &&
    isObject(raw.held) &&
    (raw.held.direction === 'up' || raw.held.direction === 'down') &&
    [raw.held.from, raw.held.to, raw.held.threshold, raw.held.at].every(finite)
  ) {
    held = {
      direction: raw.held.direction,
      from: raw.held.from,
      to: raw.held.to,
      threshold: raw.held.threshold,
      at: Math.min(raw.held.at, now),
    };
  }
  return last ? { last, held } : undefined;
}

/** A wrap entry read from /data: whole raw and offset. */
function wrapEntry(raw) {
  if (!isObject(raw)) return undefined;
  const ok =
    Number.isSafeInteger(raw.raw) &&
    raw.raw >= 0 &&
    Number.isSafeInteger(raw.offset) &&
    raw.offset >= 0;
  return ok ? { raw: raw.raw, offset: raw.offset } : undefined;
}

function unitOf(raw, now) {
  const unit = emptyUnit();
  if (!isObject(raw)) return unit;
  if (Object.hasOwn(raw, 'seen') && isObject(raw.seen)) {
    for (const [kind, max] of Object.entries(SEEN_LIMITS)) {
      const list = Object.hasOwn(raw.seen, kind) ? raw.seen[kind] : undefined;
      if (!Array.isArray(list)) continue;
      for (const n of list.slice(0, max)) {
        if (Number.isInteger(n) && n >= 1 && n <= max) unit.seen[kind].add(n);
      }
    }
  }
  if (Object.hasOwn(raw, 'guards') && isObject(raw.guards)) {
    for (const key of Object.keys(raw.guards).slice(0, 120)) {
      if (!GUARD_KEY.test(key)) continue;
      const entry = guardEntry(raw.guards[key], now);
      if (entry) unit.guards[key] = entry;
    }
  }
  if (Object.hasOwn(raw, 'wraps') && isObject(raw.wraps)) {
    for (const key of Object.keys(raw.wraps).slice(0, 120)) {
      if (!WRAP_KEY.test(key)) continue;
      const entry = wrapEntry(raw.wraps[key]);
      if (entry) unit.wraps[key] = entry;
    }
  }
  const gem = Object.hasOwn(raw, 'gem') ? raw.gem : undefined;
  if (
    isObject(gem) &&
    Number.isInteger(gem.seconds) &&
    gem.seconds >= 0 &&
    gem.seconds < 2 ** 24 &&
    finite(gem.at) &&
    gem.at > 0
  ) {
    unit.gem = { seconds: gem.seconds, at: Math.min(gem.at, now) };
  }
  return unit;
}

/** From the file (any shape) to the memory; `now` (wall) replaces a time in the future. */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  if (!isObject(raw)) {
    return memory;
  }
  if (Object.hasOwn(raw, 'token') && isToken(raw.token)) {
    memory.token = raw.token;
  }
  if (Object.hasOwn(raw, 'linkEnv') && /^[0-9a-f]{16}$/.test(String(raw.linkEnv))) {
    memory.linkEnv = raw.linkEnv;
  }
  if (Object.hasOwn(raw, 'serial') && isSerial(raw.serial)) {
    memory.serial = raw.serial;
    memory.typed = raw.typed === true;
  }
  if (Object.hasOwn(raw, 'format') && /^BIN(?:32|48)-(?:NET|ABS)(?:-TIME)?$/.test(raw.format)) {
    memory.format = raw.format;
  }
  if (Object.hasOwn(raw, 'serials') && Array.isArray(raw.serials)) {
    // Oldest first: the order of the list is the order of use.
    for (const entry of raw.serials.slice(-MAX_SERIALS)) {
      if (!isObject(entry) || !isSerial(entry.serial)) continue;
      memory.serials.delete(entry.serial);
      memory.serials.set(entry.serial, unitOf(entry, now));
    }
  }
  return memory;
}

export function serializeMemory(memory) {
  const sorted = (set) => [...set].sort((a, b) => a - b);
  const serials = [...memory.serials].slice(-MAX_SERIALS).map(([serial, unit]) => ({
    serial,
    seen: Object.fromEntries(Object.entries(unit.seen).map(([k, v]) => [k, sorted(v)])),
    guards: unit.guards,
    wraps: unit.wraps,
    gem: unit.gem ?? null,
  }));
  return {
    token: memory.token,
    linkEnv: memory.linkEnv,
    serial: memory.serial ?? null,
    typed: memory.typed === true,
    format: memory.format ?? null,
    serials,
  };
}
