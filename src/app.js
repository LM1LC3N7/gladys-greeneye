// -----------------------------------------------------------------------------
// The integration: one Brultech GreenEye Monitor (GEM), which connects by
// itself to the `gem-link` sub-container (the main container cannot publish
// a port) and pushes its binary packets ("Packet Send" in its settings); the
// link hands them over through the private channel (src/channel.js).
// Read only: nothing is ever sent to the GEM.
//
//   - Nothing listens before the configuration: the link is started only once
//     a valid GEM address is saved, stopped when it is removed.
//   - Identity: the serial number in every packet. The first GEM heard is
//     pinned in /data (or the one typed in the configuration); the packets of
//     another serial are refused and said in the status. The serial is in
//     every external id (src/model.js).
//   - Order and freshness: a packet older than a minute (kept by the link
//     while this container was away) is dropped; the GEM's own seconds
//     counter orders the packets: a repeat or an older packet is dropped,
//     never published (the time of arrival never orders them).
//   - Values: voltage, currents, temperatures (in °C, converted exactly from
//     °F when the GEM is set so; the unit is chosen in the configuration, the
//     packet does not carry it), the power of each channel over the last two
//     packets (signed: negative while a NET channel produces).
//   - Lifelong counters (the energy index of each channel, its production
//     index, the pulse counters) go through src/guard.js: never 0, never a
//     drop, a jump or a drop held back (the last accepted value is sent
//     again), kept in /data, said in the status, and taken only by the user
//     with two clicks on "Accept the held counters". Never confirmed by time.
//
// Clocks: `clock` (monotonic) for every delay and freshness; the guards on
// the SESSION clock (`sessionNow`: the wall clock read once at the start plus
// the monotonic time since), never the wall clock alone, and /data keeps
// those session dates; `now` (wall) only to start the session clock, bound
// what /data gives back, and compare with the time the link stamped on a
// message (both containers share the host clock).
// -----------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ChannelClient } from './channel.js';
import { linkEnv, normalizeConfig } from './config.js';
import { BOUNDS, GUARDS, LIMITS, LINK, TIMINGS } from './constants.js';
import { PacketError, WRAP, parsePacket } from './gem/packets.js';
import { CounterGuard } from './guard.js';
import { ACCEPT, STATUS } from './i18n.js';
import {
  buildDevices,
  celsiusOf,
  channelSlug,
  deviceIds,
  monitorSlug,
  plausibleCurrent,
  plausiblePower,
  plausibleVoltage,
  round,
  shownChannels,
} from './model.js';
import { StatePublisher } from './publisher.js';
import {
  GUARD_KEY,
  MAX_SERIALS,
  emptyMemory,
  emptyUnit,
  fileStore,
  isToken,
  newToken,
  normalizeMemory,
  serializeMemory,
} from './store.js';

const HEX = /^(?:[0-9a-f]{2}){3,625}$/;
const WS_PER_KWH = 3_600_000;
/** 16 hex characters of the hash of the link environment (it holds the secret: never kept as is). */
const envHash = (env) =>
  createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 16);
/** The delta of a counter that wraps at `wrap`. */
const delta = (current, previous, wrap) => (current - previous + wrap) % wrap;

/** A promise that gives `fallback` after `ms` if `promise` has not settled. */
function within(promise, ms, timers, fallback) {
  let timer;
  return Promise.race([
    promise.finally(() => timers.clearTimeout(timer)),
    new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

/** `{ value, at }` (wall) of a feature of a created device, from Gladys. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    feature?.last_value !== '' &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

const TIMEOUT = Symbol('timeout');

export class GreenEyeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'greeneye' }),
    store = fileStore(),
    now = Date.now,
    clock = () => performance.now(),
    timers = globalThis,
    createChannel = (options) => new ChannelClient(options),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.createChannel = createChannel;
    this.wallStart = now();
    this.monoStart = clock();
    this.config = normalizeConfig();
    this.configRead = false;
    this.memory = emptyMemory();
    this.unreadable = false;
    this.unsaved = false;
    this.booted = undefined;
    this.stopped = false;
    this.generation = 0;
    this.connectEpoch = 0;
    this.configChain = Promise.resolve();
    this.link = { status: 'not started', port: null, error: undefined, lastTry: -Infinity };
    this.linkStopped = false;
    this.channel = undefined;
    this.session = undefined;
    this.refused = undefined;
    this.junk = { ecm: 0, malformed: 0 };
    this.otherSerial = undefined;
    /** The last packet taken: `{ packet, mono }` (the GEM seconds order the next ones). */
    this.previous = undefined;
    this.lastPacketMono = undefined;
    this.interval = undefined;
    this.lastIndexAt = undefined;
    /** key -> { guard } (src/guard.js), built once the device exists in Gladys. */
    this.guards = new Map();
    this.savedHeld = '';
    this.savedNonPositive = '';
    this.guardAdded = false;
    this.wrapped = false;
    this.countersBusy = false;
    this.lastCounters = undefined;
    /** Counters reading 0 or below (never published), said in the status. */
    this.nonPositive = new Set();
    this.unpinned = undefined;
    this.restartedAt = undefined;
    this.lastGuardSave = -Infinity;
    this.pendingAccept = undefined;
    this.saving = undefined;
    this.saveAgain = false;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.created = new Map();
    this.createdFeatures = new Set();
    this.tickTimer = undefined;
    this.timersById = {};
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.clock() - this.monoStart);
  }

  // --- Start and stop -------------------------------------------------------------

  /** At start-up, before Gladys: /data (bounded), the channel, the rounds. */
  boot() {
    if (!this.booted) {
      this.booted = this.doBoot();
    }
    return this.booted;
  }

  async doBoot() {
    let raw = null;
    const loaded = await within(
      this.store.load().then(
        (data) => ({ data }),
        (err) => ({ err }),
      ),
      TIMINGS.dataTimeout,
      this.timers,
      TIMEOUT,
    );
    if (loaded === TIMEOUT || loaded.err) {
      // A file that exists but cannot be read (or a frozen /data) is not
      // "nothing kept": it is never overwritten.
      this.unreadable = true;
      const code = loaded === TIMEOUT ? 'timeout' : (loaded.err?.code ?? 'invalid');
      this.logger.error(`/data/greeneye.json cannot be read (${code})`);
    } else {
      raw = loaded.data;
    }
    this.memory = normalizeMemory(raw, this.now());
    if (!isToken(this.memory.token)) {
      this.memory.token = newToken();
      await this.saveMemory();
    }
    this.publisher.start();
    this.tickTimer = this.timers.setInterval(() => {
      this.tick().catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
    }, TIMINGS.tick);
    this.startChannel();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    this.connectEpoch += 1;
    this.timers.clearInterval(this.tickTimer);
    for (const id of Object.values(this.timersById)) this.timers.clearTimeout(id);
    this.timersById = {};
    this.publisher.stop();
    this.channel?.stop();
    this.channel = undefined;
    // The guards as they are now, for the next start (bounded: never holds the shutdown).
    this.keepGuards();
    // Bounded on the real clock too: a stop never waits on a frozen /data,
    // whatever timers were injected.
    return Promise.race([
      this.saveMemory(),
      new Promise((resolve) => setTimeout(resolve, TIMINGS.dataTimeout).unref?.()),
    ]).then(() => undefined);
  }

  later(name, delay, fn) {
    this.timers.clearTimeout(this.timersById[name]);
    const generation = this.generation;
    this.timersById[name] = this.timers.setTimeout(() => {
      this.timersById[name] = undefined;
      if (generation === this.generation && !this.stopped) {
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.warn(`${name} failed: ${err.message}`));
      }
    }, delay);
  }

  /**
   * Writes /data; resolves true once written, false otherwise, and never
   * waits more than TIMINGS.dataTimeout. Never over a file that could not be
   * read. One write at a time: a save asked while one is in flight is done
   * right after it (the last state wins), never a second one beside it.
   */
  saveMemory() {
    if (this.unreadable) return Promise.resolve(false);
    if (this.saving) {
      this.saveAgain = true;
      return within(this.saving, TIMINGS.dataTimeout, this.timers, false);
    }
    const run = (async () => {
      let ok;
      do {
        this.saveAgain = false;
        try {
          await this.store.save(serializeMemory(this.memory));
          ok = true;
        } catch (err) {
          ok = false;
          this.logger.warn(`Saving /data/greeneye.json failed (${err?.code ?? 'error'})`);
        }
      } while (this.saveAgain && !this.stopped);
      return ok;
    })();
    this.saving = run;
    run.then((ok) => {
      if (this.saving === run) this.saving = undefined;
      this.setUnsaved(!ok);
    });
    return within(run, TIMINGS.dataTimeout, this.timers, TIMEOUT).then((result) => {
      // A write still hanging (a frozen /data) is said now; the next saves wait
      // behind it, one at most (saveAgain), never piling up.
      if (result === TIMEOUT) {
        this.setUnsaved(true);
        return false;
      }
      return result;
    });
  }

  setUnsaved(unsaved) {
    if (this.unsaved === unsaved) return;
    this.unsaved = unsaved;
    this.updateStatus();
  }

  // --- Gladys ---------------------------------------------------------------------------

  /**
   * Gladys (re)connected: the configuration is read, retried without end
   * (5 s, 10 s, 30 s, 1 min, then every 2 min) while it fails; then the
   * status and the Discovery again. Nothing old is published as new: the
   * next packet of the GEM brings fresh values.
   */
  async gladysConnected() {
    await this.boot();
    const epoch = ++this.connectEpoch;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.gladys.forgetPublishedStates?.();
    // What waited for Gladys is no longer the state: the next packet brings it again.
    this.publisher.clear();
    for (let attempt = 1; !this.stopped && epoch === this.connectEpoch; attempt += 1) {
      let raw;
      try {
        raw = await this.gladys.getConfig();
      } catch (err) {
        if (epoch !== this.connectEpoch || this.stopped) return;
        this.logger.warn(`Reading the configuration failed (attempt ${attempt}): ${err.message}`);
        await this.setStatus(false, STATUS.configUnread(attempt)).catch(() => {});
        const delays = TIMINGS.configRetry;
        await new Promise((resolve) => {
          this.later('configRetry', delays[Math.min(attempt - 1, delays.length - 1)], resolve);
        });
        continue;
      }
      if (epoch !== this.connectEpoch || this.stopped) return;
      this.refreshCreated();
      // The counters are published again at the next packet.
      this.lastIndexAt = undefined;
      await this.configUpdated(raw);
      return;
    }
  }

  /** Saved by the user: applied one after the other, the last one winning. */
  configUpdated(raw) {
    const run = this.configChain.then(() => this.applyConfig(raw));
    this.configChain = run.catch((err) =>
      this.logger.error(`Configuration failed: ${err.message}`),
    );
    return run;
  }

  async applyConfig(raw) {
    await this.boot();
    if (this.stopped) return;
    this.config = normalizeConfig(raw);
    this.configRead = true;
    const typed = this.config.serial;
    if (typed !== null && (typed !== this.memory.serial || !this.memory.typed)) {
      // Another GEM typed: its own devices; what was kept for the other one stays in /data.
      this.logger.info(`Following GEM ${typed} (typed in the configuration)`);
      this.adoptSerial(typed, { typed: true });
    } else if (typed === null && this.memory.typed) {
      // The field cleared: the first GEM heard is followed again.
      this.logger.info('Serial number cleared: following the first GEM heard');
      this.adoptSerial(undefined, { typed: false });
    }
    if (this.config.problem) {
      // Nothing listens without a valid address of the GEM, not even a link
      // left running from before this start (cleared while it was stopped).
      if (!this.linkStopped) {
        await this.stopLink();
        this.linkStopped = true;
      }
    } else {
      this.linkStopped = false;
      await this.ensureLink();
    }
    this.publishedDevices = undefined;
    await this.publishDiscovery();
    await this.updateStatus();
  }

  /**
   * Follows `serial` from now (undefined: the next GEM heard). What was seen,
   * held and unwrapped for each serial stays in /data under its serial: a
   * mistyped serial then the right one keeps every hold (review r1, I2).
   */
  adoptSerial(serial, { typed = false } = {}) {
    // The counters of the GEM followed so far, as they are, before switching.
    this.keepGuards();
    this.memory.serial = serial;
    this.memory.typed = serial !== undefined && typed;
    if (serial !== undefined) this.unit(serial, { touch: true });
    this.guards.clear();
    this.pendingAccept = undefined;
    this.previous = undefined;
    this.lastCounters = undefined;
    this.otherSerial = undefined;
    this.unpinned = undefined;
    this.savedHeld = '';
    this.lastIndexAt = undefined;
    this.nonPositive.clear();
    this.saveMemory();
  }

  /**
   * What is kept for `serial` (the one followed by default); `touch` makes
   * it the most recent of the MAX_SERIALS kept. Without a serial, an empty
   * one that is never stored.
   */
  unit(serial = this.memory.serial, { touch = false } = {}) {
    if (serial === undefined) return emptyUnit();
    let unit = this.memory.serials.get(serial);
    if (!unit || touch) {
      unit ??= emptyUnit();
      this.memory.serials.delete(serial);
      this.memory.serials.set(serial, unit);
      while (this.memory.serials.size > MAX_SERIALS) {
        const oldest = this.memory.serials.keys().next().value;
        this.memory.serials.delete(oldest);
      }
    }
    return unit;
  }

  refreshCreated() {
    this.created.clear();
    this.createdFeatures.clear();
    for (const device of this.gladys.devices ?? []) {
      if (typeof device?.external_id !== 'string' || !device.external_id.includes(':greeneye:')) {
        continue;
      }
      this.created.set(device.external_id, device);
      for (const feature of device.features ?? []) {
        if (typeof feature?.external_id === 'string') {
          this.createdFeatures.add(feature.external_id);
        }
      }
    }
    // A guard whose device is gone is built again (from /data and Gladys) when it comes back.
    for (const key of [...this.guards.keys()]) {
      if (!this.createdFeatures.has(this.counterFeatureId(key))) this.guards.delete(key);
    }
  }

  /** A device created, updated or deleted: kept for its features. */
  async deviceChanged() {
    this.refreshCreated();
    this.publishedDevices = undefined;
    this.lastIndexAt = undefined;
    await this.publishDiscovery();
  }

  async scan() {
    this.publishedDevices = undefined;
    await this.publishDiscovery();
  }

  async publishDiscovery() {
    const devices = buildDevices(this.gladys, this.memory.serial, this.unit().seen, {
      config: this.config,
      created: this.created,
    });
    const text = JSON.stringify(devices);
    if (text === this.publishedDevices) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.publishedDevices = text;
    } catch (err) {
      this.logger.warn(`Publishing the Discovery failed: ${err.message}`);
    }
  }

  async setStatus(connected, text) {
    const message = {
      en: text.en.slice(0, LIMITS.status),
      fr: text.fr.slice(0, LIMITS.status),
    };
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    await this.gladys.setConnectionStatus(connected, message);
    this.lastStatus = key;
  }

  /** How long without a packet before the values are stale. */
  staleAfter() {
    const measured = this.interval === undefined ? 0 : 3 * this.interval;
    return Math.min(TIMINGS.staleMax, Math.max(TIMINGS.staleMin, measured));
  }

  /** The status from what is known now; sent only when it changed. */
  async updateStatus() {
    if (!this.configRead || this.stopped) return;
    const generation = this.generation;
    const mono = this.clock();
    let connected = false;
    let text;
    const since = this.lastPacketMono === undefined ? undefined : mono - this.lastPacketMono;
    if (this.config.problem === 'address:empty') {
      text = STATUS.noAddress;
    } else if (this.config.problem) {
      text = STATUS.badAddress;
    } else if (this.link.status !== 'running') {
      text = STATUS.linkDown(this.link.error ?? this.link.status);
    } else if (!this.channel?.connected) {
      text = STATUS.linkUnreachable;
    } else if (since !== undefined && since < this.staleAfter()) {
      // Fresh packets, whether the GEM keeps its connection open or opens one per packet.
      connected = true;
      text = STATUS.connected({
        serial: this.memory.serial,
        format: this.memory.format ?? '?',
        channels: shownChannels(this.config, this.unit().seen).length,
      });
    } else if (since !== undefined && this.memory.serial !== undefined) {
      text = STATUS.stale({ serial: this.memory.serial, since });
    } else if (this.session) {
      text = STATUS.noPacket(this.session.from);
    } else {
      text = STATUS.waiting(this.link.port, this.config.checkSource ? this.config.host : null);
    }
    const extras = [];
    const held = this.heldEntries();
    if (held.length > 0) extras.push(STATUS.held(held, LIMITS.heldListed));
    if (this.otherSerial) {
      extras.push(
        STATUS.otherSerial(
          this.otherSerial,
          this.config.serial ?? this.memory.serial,
          this.memory.typed,
        ),
      );
    }
    if (this.refused) extras.push(STATUS.refused(this.refused.from, this.refused.count));
    if (this.junk.ecm > 0 || this.junk.malformed > 0) extras.push(STATUS.junk(this.junk));
    if (this.unpinned !== undefined) extras.push(STATUS.unpinned(this.unpinned));
    if (this.restartedAt !== undefined && mono - this.restartedAt < TIMINGS.restartNotice) {
      extras.push(STATUS.restarted);
    }
    if (this.nonPositive.size > 0) extras.push(STATUS.nonPositive([...this.nonPositive].sort()));
    if (this.config.serialInvalid) extras.push(STATUS.serialInvalid);
    if (this.config.channelsInvalid) extras.push(STATUS.channelsInvalid);
    if (this.config.temperatureUnit === 'off') extras.push(STATUS.temperaturesOff);
    if (this.unreadable) extras.push(STATUS.dataUnreadable);
    else if (this.unsaved) extras.push(STATUS.dataUnsaved);
    // The held counters first: the most important extra is never cut.
    const message = {
      en: [text.en, ...extras.map((e) => e.en)].join(''),
      fr: [text.fr, ...extras.map((e) => e.fr)].join(''),
    };
    if (generation !== this.generation) return;
    await this.setStatus(connected, message).catch((err) =>
      this.logger.warn(`Publishing the status failed: ${err.message}`),
    );
  }

  // --- The link (sub-container) ------------------------------------------------------------

  /** Reads the state of the link from Gladys; the container entry, or undefined. */
  async readLink(generation) {
    const containers = await this.gladys.getContainers();
    if (generation !== this.generation) return undefined;
    const container = (containers ?? []).find((c) => c?.name === LINK.name);
    const port = container?.ports?.find((p) => p?.name === LINK.portName)?.host_port;
    this.link = {
      ...this.link,
      status: typeof container?.status === 'string' ? container.status.slice(0, 40) : 'unknown',
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      error: undefined,
    };
    return container;
  }

  /**
   * Starts the link only when it does not run, or runs with another
   * environment (address, sender check, secret): Gladys restarts a container
   * on every startContainer, which drops the GEM session. The environment is
   * compared through a hash kept in /data, never the secret itself.
   * `force`: started again although it runs, because the channel has not come
   * up for a long while (another secret). Spaced by the caller (tick).
   */
  async ensureLink({ force = false } = {}) {
    this.link.lastTry = this.clock();
    const generation = this.generation;
    try {
      const env = linkEnv(this.config, this.memory.token, LINK);
      const hash = envHash(env);
      const container = await this.readLink(generation);
      if (generation !== this.generation) return;
      if (force || container?.status !== 'running' || this.memory.linkEnv !== hash) {
        if (force) this.logger.warn('The GEM link does not answer the channel: started again');
        await this.gladys.startContainer(LINK.name, { env });
        this.memory.linkEnv = hash;
        this.saveMemory();
        await this.readLink(generation);
        if (generation !== this.generation) return;
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.link = { ...this.link, status: 'error', error: String(err.message).slice(0, 120) };
      this.logger.warn(`Could not start the GEM link: ${err.message}`);
    }
    this.startChannel();
    // Started (again): the channel tries at once, not at the end of its backoff.
    this.channel?.retryNow?.();
  }

  async stopLink() {
    try {
      await this.gladys.stopContainer(LINK.name);
    } catch (err) {
      this.logger.debug(`Stopping the GEM link: ${err.message}`);
    }
    this.link = { ...this.link, status: 'not started', port: null, error: undefined };
    this.setSession(undefined);
  }

  startChannel() {
    if (this.channel || this.stopped || !isToken(this.memory.token)) return;
    const generation = this.generation;
    const channel = this.createChannel({
      host: LINK.name,
      port: LINK.channelPort,
      token: this.memory.token,
      logger: this.logger,
    });
    this.channel = channel;
    this.channelDownSince = this.clock();
    channel.on('up', (info) => {
      if (generation !== this.generation) return;
      // The link may have restarted: its session ids start again (review r2, m1).
      if (this.previous) this.previous.session = undefined;
      this.channelDownSince = undefined;
      this.logger.info('Connected to the GEM link');
      const current = info?.session;
      this.setSession(
        current && Number.isSafeInteger(current.id)
          ? { id: current.id, from: current.from }
          : undefined,
      );
      this.updateStatus();
    });
    channel.on('down', () => {
      if (generation !== this.generation) return;
      this.channelDownSince = this.clock();
      this.logger.warn('Lost the GEM link, reconnecting');
      this.setSession(undefined);
      this.updateStatus();
    });
    channel.on('message', (message) => {
      if (generation !== this.generation) return;
      try {
        this.onLinkMessage(message);
      } catch (err) {
        this.logger.warn(`Message of the GEM link ignored: ${err.message}`);
      }
    });
    channel.start();
  }

  setSession(session) {
    if (this.session?.id === session?.id) return;
    this.session = session
      ? { id: session.id, from: String(session.from ?? '').slice(0, 64) }
      : undefined;
    if (this.session) {
      this.refused = undefined;
      this.junk = { ecm: 0, malformed: 0 };
      this.logger.info(`GEM session ${this.session.id} from ${this.session.from}`);
    }
  }

  onLinkMessage(message) {
    switch (message?.type) {
      case 'session':
        if (message.state === 'up' && Number.isSafeInteger(message.session)) {
          this.setSession({ id: message.session, from: message.from });
        } else if (message.state === 'down' && message.session === this.session?.id) {
          this.setSession(undefined);
        }
        this.updateStatus();
        return;
      case 'refused':
        this.refused = {
          from: typeof message.from === 'string' ? message.from.slice(0, 64) : 'unknown',
          count:
            (this.refused?.count ?? 0) +
            (Number.isSafeInteger(message.count) && message.count > 0 ? message.count : 1),
        };
        this.updateStatus();
        return;
      case 'junk':
        if (message.session === this.session?.id) {
          const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
          this.junk = { ecm: count(message.ecm), malformed: count(message.malformed) };
          this.updateStatus();
        }
        return;
      case 'packet':
        this.onPacket(message);
        return;
      default:
    }
  }

  // --- Packets -------------------------------------------------------------------------------

  onPacket(message) {
    if (!this.session || message.session !== this.session.id) return;
    // One reading of each clock for the whole packet.
    const mono = this.clock();
    const sent = Date.parse(message.at);
    if (!Number.isFinite(sent) || Math.abs(this.now() - sent) > TIMINGS.valueMaxAge) {
      // Kept by the link while this container was away: no longer the state.
      return;
    }
    if (typeof message.hex !== 'string' || !HEX.test(message.hex)) return;
    let packet;
    try {
      packet = parsePacket(Buffer.from(message.hex, 'hex'));
    } catch (err) {
      if (!(err instanceof PacketError)) throw err;
      this.junk = { ...this.junk, malformed: this.junk.malformed + 1 };
      return;
    }
    if (!this.checkIdentity(packet)) return;
    const previous = this.previous?.packet;
    let seconds;
    let restarted = false;
    if (previous) {
      const back = previous.seconds - packet.seconds;
      if (back === 0) return; // the same packet again
      const sameSession = this.previous.session === this.session.id;
      if (back > 0 && back <= TIMINGS.staleSeconds && sameSession) {
        // Older than the last one taken, in the same connection (TCP keeps the
        // order: only a misbehaving sender does this).
        return;
      }
      if (back > 0 && back <= TIMINGS.staleSeconds) {
        // Back in a new connection: the GEM restarted (its counter starts again).
        this.restartedAt = mono;
        restarted = true;
        this.logger.info('The GEM restarted (its seconds counter went back)');
        seconds = undefined;
      } else {
        seconds = delta(packet.seconds, previous.seconds, WRAP.seconds);
        // A GEM restarted, a long gap: a new start, no power over it.
        if (seconds * 1000 > TIMINGS.powerMaxGap) seconds = undefined;
      }
    }
    if (seconds !== undefined) this.interval = seconds * 1000;
    this.previous = { packet, mono, session: this.session.id };
    // The 5-byte and 3-byte counters, unwrapped (reviews r1 and r2, I1).
    const counters = this.unwrap(packet, this.gemStep(packet, this.sessionNow(), restarted));
    const firstPacket = this.lastPacketMono === undefined;
    this.lastPacketMono = mono;
    let changed = false;
    if (this.memory.format !== packet.format) {
      this.memory.format = packet.format;
      changed = true;
    }
    changed = this.learn(packet, counters, seconds) || changed;
    this.publishPacket(packet, previous, seconds, mono, counters);
    if (changed) {
      this.saveMemory();
      this.publishDiscovery();
    }
    if (firstPacket || changed) this.updateStatus();
  }

  /** Whether the packet is of the GEM followed; pins the first one heard. */
  checkIdentity(packet) {
    const expected = this.config.serial ?? this.memory.serial;
    if (expected === undefined) {
      if (!this.configRead) return false; // the serial typed is not known yet
      if (this.unreadable) {
        // /data unreadable: no new pin (it could not be kept); only a typed serial is followed.
        if (this.unpinned !== packet.serial) {
          this.unpinned = packet.serial;
          this.updateStatus();
        }
        return false;
      }
      this.logger.info(`Following GEM ${packet.serial} (the first one heard)`);
      this.adoptSerial(packet.serial);
      return true;
    }
    if (packet.serial !== expected) {
      if (this.otherSerial !== packet.serial) {
        this.otherSerial = packet.serial;
        this.logger.warn(`Packets of GEM ${packet.serial} refused (following ${expected})`);
        this.updateStatus();
      }
      return false;
    }
    if (this.otherSerial !== undefined) {
      this.otherSerial = undefined;
      this.updateStatus();
    }
    return true;
  }

  /**
   * What the packet shows working: a channel whose absolute counter rose by a
   * plausible amount since the previous packet, a production on a NET
   * channel, a plausible temperature, a pulse counter that rose. True when
   * something new was seen.
   */
  learn(packet, counters, seconds) {
    const seen = this.unit().seen;
    const before = this.lastCounters;
    this.lastCounters = counters;
    const previous = seconds !== undefined ? before : undefined;
    let changed = false;
    const add = (set, n) => {
      if (!set.has(n)) {
        set.add(n);
        changed = true;
      }
    };
    if (previous && previous.absolute.length === counters.absolute.length) {
      const most = Math.max(Math.abs(BOUNDS.power.min), BOUNDS.power.max) * seconds;
      for (let i = 0; i < packet.channels; i += 1) {
        const rose = counters.absolute[i] - previous.absolute[i];
        if (rose > 0 && rose <= most) add(seen.channels, i + 1);
      }
      for (let i = 0; i < counters.pulses.length; i += 1) {
        const rose = counters.pulses[i] - previous.pulses[i];
        if (rose > 0 && rose <= (GUARDS.pulses.perHour * seconds) / 3600 + 1) {
          add(seen.pulses, i + 1);
        }
      }
    }
    if (packet.net) {
      for (const n of shownChannels(this.config, seen)) {
        if (n <= packet.channels && counters.polarized[n - 1] > 0) add(seen.produced, n);
      }
    }
    if (this.config.temperatureUnit !== 'off') {
      packet.temperatures.forEach((raw, i) => {
        if (celsiusOf(raw, this.config.temperatureUnit) !== undefined) add(seen.temps, i + 1);
      });
    }
    return changed;
  }

  /** Pushes a state when the feature exists in Gladys. */
  push(featureId, state) {
    if (this.createdFeatures.has(featureId)) this.publisher.push(featureId, state);
  }

  publishPacket(packet, previous, seconds, mono, counters) {
    const serial = this.memory.serial;
    const monitor = deviceIds(this.gladys, monitorSlug(serial));
    if (plausibleVoltage(packet.voltage)) {
      this.push(monitor.feature('voltage'), { state: round(packet.voltage, 1) });
    }
    if (this.config.temperatureUnit !== 'off') {
      packet.temperatures.forEach((raw, i) => {
        const celsius = celsiusOf(raw, this.config.temperatureUnit);
        if (celsius !== undefined) this.push(monitor.feature(`temp-${i + 1}`), { state: celsius });
      });
    }
    const powerOk =
      previous && seconds !== undefined && seconds > 0 && previous.channels === packet.channels;
    for (const n of shownChannels(this.config, this.unit().seen)) {
      if (n > packet.channels) continue;
      const i = n - 1;
      const ids = deviceIds(this.gladys, channelSlug(serial, n));
      if (plausibleCurrent(packet.currents[i])) {
        this.push(ids.feature('current'), { state: round(packet.currents[i], 2) });
      }
      if (powerOk) {
        // As the reference: (consumed - produced) / seconds, consumed = absolute - produced.
        const total = delta(packet.absolute[i], previous.absolute[i], WRAP.ws);
        const produced =
          packet.net && previous.net
            ? delta(packet.polarized[i], previous.polarized[i], WRAP.ws)
            : 0;
        const watts = (total - 2 * produced) / seconds;
        // A counter that went back (a reset) gives a huge delta: never published.
        if (produced <= total && plausiblePower(watts)) {
          this.push(ids.feature('power'), { state: round(watts, 1) });
        }
      }
    }
    if (this.lastIndexAt !== undefined && mono < this.lastIndexAt) this.lastIndexAt = undefined;
    if (
      !this.countersBusy &&
      (this.lastIndexAt === undefined || mono - this.lastIndexAt >= TIMINGS.indexInterval)
    ) {
      this.lastIndexAt = mono;
      this.countersBusy = true;
      this.publishCounters(packet, counters)
        .catch((err) => this.logger.warn(`Checking the counters failed: ${err.message}`))
        .finally(() => {
          this.countersBusy = false;
        });
    }
  }

  // --- Lifelong counters ----------------------------------------------------------------------

  /** The feature external id of a counter key. */
  counterFeatureId(key) {
    const serial = this.memory.serial;
    let m = /^ch(\d+)(-prod)?$/.exec(key);
    if (m) {
      return deviceIds(this.gladys, channelSlug(serial, Number(m[1]))).feature(
        m[2] ? 'production' : 'index',
      );
    }
    m = /^pulse-(\d)$/.exec(key);
    return deviceIds(this.gladys, monitorSlug(serial)).feature(`pulse-${m?.[1]}`);
  }

  /**
   * The seconds the GEM counted since the last packet of the serial followed
   * (kept in /data with the session date it came), or undefined when the GEM
   * did not run on continuously: it restarted (its seconds went back in a new
   * connection), or the seconds it counted do not match the time elapsed on
   * the session clock (a reset while nobody listened: its seconds started
   * again from 0). Tolerance: 2 minutes or 5 %.
   */
  gemStep(packet, at, restarted) {
    const unit = this.unit();
    const before = unit.gem;
    unit.gem = { seconds: packet.seconds, at };
    if (!before || restarted) return undefined;
    const counted = delta(packet.seconds, before.seconds, WRAP.seconds);
    const elapsed = Math.max(0, at - before.at) / 1000;
    const tolerance = Math.max(TIMINGS.gemClockTolerance / 1000, elapsed * 0.05);
    return Math.abs(counted - elapsed) <= tolerance ? counted : undefined;
  }

  /**
   * The raw counters of a packet unwrapped: the absolute and polarized
   * energies (5 bytes, 2^40 Ws) and the pulses (3 bytes, 2^24). A raw value
   * that goes back by more than half of its range is a wrap only when the
   * GEM ran on continuously (`step`: the seconds it counted since the last
   * packet, see gemStep) and the forward step through the top fits the
   * margin of the counter over those seconds: then the counter's offset
   * grows by the range (kept in /data). Any other step back (a reset of the
   * GEM, a replaced CT) stays a drop, for the guard to hold.
   */
  unwrap(packet, step) {
    const wraps = this.unit().wraps;
    let changed = false;
    const one = (key, raw, range, perHour, slack) => {
      const entry = Object.hasOwn(wraps, key) ? wraps[key] : undefined;
      if (!entry) {
        wraps[key] = { raw, offset: 0 };
        return raw;
      }
      if (raw < entry.raw && entry.raw - raw > range / 2 && step !== undefined) {
        const forward = raw + range - entry.raw;
        const margin = (perHour * step) / 3600 + slack;
        if (forward <= margin) {
          entry.offset += range;
          changed = true;
          this.logger.info(`GEM counter ${key} wrapped around: counted on`);
        }
      }
      entry.raw = raw;
      return raw + entry.offset;
    };
    const ws = [GUARDS.energy.perHour * WS_PER_KWH, GUARDS.energy.slack * WS_PER_KWH];
    const out = {
      absolute: packet.absolute.map((raw, i) => one(`abs-${i + 1}`, raw, WRAP.ws, ...ws)),
      polarized: packet.net
        ? packet.polarized.map((raw, i) => one(`pol-${i + 1}`, raw, WRAP.ws, ...ws))
        : null,
      pulses: packet.pulses.map((raw, i) =>
        one(`pulse-${i + 1}`, raw, WRAP.pulses, GUARDS.pulses.perHour, GUARDS.pulses.slack),
      ),
    };
    if (changed) this.wrapped = true;
    return out;
  }

  /** The value of each counter of a packet (unwrapped): [key, value, limits]. */
  countersOf(packet, counters) {
    const out = [];
    const seen = this.unit().seen;
    for (const n of shownChannels(this.config, seen)) {
      if (n > packet.channels) continue;
      const i = n - 1;
      const produced = counters.polarized ? counters.polarized[i] : 0;
      // Consumed = absolute - produced (NET); ABS: the absolute counter.
      out.push([`ch${n}`, round((counters.absolute[i] - produced) / WS_PER_KWH, 3), GUARDS.energy]);
      if (counters.polarized && seen.produced.has(n)) {
        out.push([`ch${n}-prod`, round(produced / WS_PER_KWH, 3), GUARDS.energy]);
      }
    }
    for (const n of seen.pulses) {
      out.push([`pulse-${n}`, counters.pulses[n - 1], GUARDS.pulses]);
    }
    return out;
  }

  /**
   * The guard of a counter whose feature exists in Gladys, built from /data
   * and the last value Gladys holds. Their dates are taken on the session
   * clock (what /data keeps was written on the session clock of the life
   * that wrote it), and a date ahead of the session clock is now: a
   * reference "in the future" never shrinks the margin of the next rise to
   * nothing, a wall clock moved by NTP during this life changes nothing.
   */
  guardOf(key, featureId, limits, devices = [...this.created.values()]) {
    let entry = this.guards.get(key);
    if (!entry) {
      const device = devices.find((d) =>
        (d?.features ?? []).some((f) => f.external_id === featureId),
      );
      const sessionNow = this.sessionNow();
      const bounded = (ref) =>
        ref && Number.isFinite(ref.at) ? { ...ref, at: Math.min(ref.at, sessionNow) } : ref;
      const guards = this.unit().guards;
      const saved = Object.hasOwn(guards, key) ? guards[key] : undefined;
      const kept = saved ? { last: bounded(saved.last), held: bounded(saved.held) } : undefined;
      const guard = new CounterGuard(
        limits,
        bounded(lastValueOf(device, featureId)),
        kept,
        sessionNow,
      );
      entry = { guard };
      this.guards.set(key, entry);
      this.guardAdded = true;
    }
    return entry.guard;
  }

  /**
   * The counters, once a minute. A guard built without what /data kept is
   * built on a FRESH read of the devices from Gladys (never the cache of the
   * last connection, which may lack the last value): when that read fails,
   * nothing is checked nor published this round (review r1, I2).
   */
  async publishCounters(packet, counters) {
    const serial = this.memory.serial;
    const generation = this.generation;
    const todo = this.countersOf(packet, counters)
      .map(([key, value, limits]) => [key, value, limits, this.counterFeatureId(key)])
      .filter(([, , , featureId]) => this.createdFeatures.has(featureId));
    const guards = this.unit().guards;
    let devices;
    if (todo.some(([key]) => !this.guards.has(key) && !Object.hasOwn(guards, key))) {
      const read = await within(
        Promise.resolve()
          .then(() => this.gladys.getDevices())
          .then(
            (list) => ({ list }),
            (err) => ({ err }),
          ),
        TIMINGS.dataTimeout,
        this.timers,
        TIMEOUT,
      );
      if (read === TIMEOUT || read.err || !Array.isArray(read.list)) {
        this.logger.warn('Reading the devices from Gladys failed: the counters wait');
        this.lastIndexAt = undefined;
        return;
      }
      if (generation !== this.generation || serial !== this.memory.serial) return;
      devices = read.list;
    }
    for (const [key, value, limits, featureId] of todo) {
      const guard = this.guardOf(key, featureId, limits, devices);
      const wasHeld = guard.held;
      const plausible = guard.accept(value, this.sessionNow());
      if (!plausible && guard.held && guard.held !== wasHeld && !wasHeld) {
        this.logger.warn(
          `GEM counter ${key} ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back`,
        );
      }
      // A counter at 0 or below (abs − pol of a NET channel) is never published: said.
      if (value <= 0) this.nonPositive.add(key);
      else this.nonPositive.delete(key);
      // While a value is held, the last accepted one is sent again (no delta for the core).
      const state = plausible ? value : guard.held ? guard.last?.value : undefined;
      if (state !== undefined && state > 0) this.push(featureId, { state });
    }
    this.saveGuards();
  }

  /** The guards into the memory, with their session dates. */
  keepGuards() {
    if (this.memory.serial === undefined) return;
    const guards = this.unit().guards;
    for (const [key, { guard }] of this.guards) {
      if (!GUARD_KEY.test(key)) continue;
      const state = guard.state();
      if (!state.last) continue;
      guards[key] = {
        last: { ...state.last },
        held: state.held ? { ...state.held } : null,
      };
    }
  }

  /**
   * Written at once when a counter is first checked or a hold appears,
   * changes or ends; otherwise every 10 minutes.
   */
  saveGuards() {
    const heldKey = JSON.stringify(
      this.heldEntries().map(([key, h]) => [key, h.direction, h.from, h.threshold]),
    );
    const mono = this.clock();
    const nonPositive = [...this.nonPositive].sort().join(',');
    if (nonPositive !== this.savedNonPositive) {
      this.savedNonPositive = nonPositive;
      this.updateStatus();
    }
    if (
      !this.guardAdded &&
      !this.wrapped &&
      heldKey === this.savedHeld &&
      mono - this.lastGuardSave < TIMINGS.guardSaveEvery
    ) {
      return;
    }
    this.guardAdded = false;
    this.wrapped = false;
    const statusChanged = heldKey !== this.savedHeld;
    this.savedHeld = heldKey;
    this.lastGuardSave = mono;
    this.keepGuards();
    this.saveMemory();
    if (statusChanged) this.updateStatus();
  }

  /** [key, held] of every counter held back, in a stable order. */
  heldEntries() {
    return [...this.guards]
      .filter(([, { guard }]) => guard.held)
      .map(([key, { guard }]) => [key, guard.held])
      .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  }

  /**
   * "Accept the held counters", in two clicks: the first lists every counter
   * held (nothing accepted), the second, from 3 s to 5 min later, accepts
   * exactly those listed, and only when each is still held the same way (a
   * rise since the first click within its margin); otherwise nothing at all.
   * Each acceptance stays bounded (src/guard.js). A save of the form never
   * accepts.
   */
  async acceptHeldButton() {
    await this.boot();
    const mono = this.clock();
    const now = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const entries = this.heldEntries();
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > TIMINGS.acceptWithin || elapsed < TIMINGS.acceptAfter) {
      if (entries.length === 0) return ACCEPT.nothing;
      const listed = entries.map(([key, h]) => [
        key,
        { direction: h.direction, from: h.from, to: h.to },
      ]);
      this.pendingAccept = {
        at: mono,
        listedAt: now,
        listed,
        guards: new Map(listed.map(([key]) => [key, this.guards.get(key)?.guard])),
      };
      return ACCEPT.confirm(listed, TIMINGS.acceptWithin);
    }
    const same =
      pending.listed.length === entries.length &&
      pending.listed.every(([key, listed]) => {
        const guard = this.guards.get(key)?.guard;
        const held = guard?.held;
        return (
          guard === pending.guards.get(key) &&
          held &&
          held.direction === listed.direction &&
          held.from === listed.from &&
          held.to >= listed.to &&
          held.to - listed.to <= guard.margin(pending.listedAt, now)
        );
      });
    if (!same) return entries.length === 0 ? ACCEPT.nothing : ACCEPT.changed;
    const accepted = pending.listed.map(([key]) => [key, this.guards.get(key).guard.acceptHeld()]);
    this.logger.info(`GEM counters accepted by the user: ${accepted.map(([k]) => k).join(', ')}`);
    // Taken at the next packet.
    this.lastIndexAt = undefined;
    return ACCEPT.done(accepted);
  }

  // --- Background ------------------------------------------------------------------------------

  async tick() {
    if (this.stopped) return;
    const mono = this.clock();
    if (
      this.configRead &&
      !this.config.problem &&
      this.link.status === 'running' &&
      this.channelDownSince !== undefined &&
      mono - this.channelDownSince >= TIMINGS.linkSilent &&
      mono - (this.lastForcedLink ?? -Infinity) >= TIMINGS.linkForceSpacing
    ) {
      // Running, but the channel never came up for minutes: another secret, most likely.
      this.lastForcedLink = mono;
      await this.ensureLink({ force: true });
      return;
    }
    if (
      this.configRead &&
      !this.config.problem &&
      (this.link.status !== 'running' || !this.channel?.connected) &&
      mono - this.link.lastTry >= TIMINGS.linkRetry
    ) {
      await this.ensureLink();
    } else if (!this.channel?.connected) {
      this.channel?.retryNow?.();
    }
    await this.updateStatus();
  }
}
