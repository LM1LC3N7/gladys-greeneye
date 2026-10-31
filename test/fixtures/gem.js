// -----------------------------------------------------------------------------
// Test fixtures: GEM packets built as the GEM sends them (the reverse of
// src/gem/packets.js, as the reference's PacketFormat.format), the captures
// of the reference (test/fixtures/*.bin, siobrultech-protocols, MIT), a fake
// GEM (a TCP client that connects to the link, as the real one does), a fake
// channel for the app, and the app on the SDK's fake Gladys with a virtual
// clock.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock, settle } from '../kit/index.mjs';
import { GreenEyeApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { LINK } from '../../src/constants.js';
import { FORMATS, checksumOf } from '../../src/gem/packets.js';
import { memoryStore } from '../../src/store.js';

export { settle };

export const SELECTOR = 'test-integration';
export const GEM_IP = '192.168.1.70';
export const SERIAL = 1100603;
export const CONFIG = { gem_address: GEM_IP };
export const HOST_PORT = 41234;

export const device = (slug) => `ext:${SELECTOR}:greeneye:${slug}`;
export const channelDevice = (n, serial = SERIAL) => device(`${serial}-ch${n}`);
export const channelFeature = (n, key, serial = SERIAL) => `${channelDevice(n, serial)}:${key}`;
export const monitorFeature = (key, serial = SERIAL) => `${device(String(serial))}:${key}`;

export const capture = (name) => readFileSync(new URL(`./${name}.bin`, import.meta.url));

const le = (value, size) => {
  const out = Buffer.alloc(size);
  let v = value;
  for (let i = 0; i < size; i += 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};

/** A temperature field: halves, sign-magnitude, little endian; null -> 256 (no sensor). */
const tempBytes = (value) => {
  const raw = value === null ? 512 : Math.round(Math.abs(value) * 2);
  const out = le(raw, 2);
  if (value !== null && value < 0) out[1] |= 0x80;
  return out;
};

/**
 * A GEM packet. Energies in watt-seconds; `kwh` gives the absolute counters
 * in kWh instead. Defaults: BIN32-NET, 120 V, serial SERIAL.
 */
export function buildPacket({
  format = 'BIN32_NET',
  serial = SERIAL,
  voltage = 120,
  absolute = [],
  polarized = [],
  currents = [],
  seconds = 1000,
  pulses = [0, 0, 0, 0],
  temperatures = [null, null, null, null, null, null, null, null],
  time = [26, 10, 31, 12, 0, 0],
} = {}) {
  const fmt = FORMATS[format];
  const n = fmt.channels;
  const parts = [Buffer.from([0xfe, 0xff, fmt.code])];
  const v = Buffer.alloc(2);
  v.writeUInt16BE(Math.round(voltage * 10));
  parts.push(v);
  parts.push(...Array.from({ length: n }, (_, i) => le(absolute[i] ?? 0, 5)));
  if (fmt.net) parts.push(...Array.from({ length: n }, (_, i) => le(polarized[i] ?? 0, 5)));
  const s = Buffer.alloc(4);
  s.writeUInt16BE(serial % 100_000, 0);
  s[2] = 0;
  s[3] = Math.floor(serial / 100_000);
  parts.push(s);
  parts.push(...Array.from({ length: n }, (_, i) => le(Math.round((currents[i] ?? 0) * 50), 2)));
  parts.push(le(seconds % 2 ** 24, 3));
  parts.push(...pulses.map((p) => le(p, 3)));
  parts.push(...temperatures.map(tempBytes));
  if (n === 32) parts.push(Buffer.from([0, 0]));
  if (fmt.time) parts.push(Buffer.from(time));
  parts.push(Buffer.from([0xff, 0xfe, 0]));
  const packet = Buffer.concat(parts);
  packet[packet.length - 1] = checksumOf(packet, packet.length);
  return packet;
}

export const KWH = 3_600_000;

/** A packet message as the link sends it on the channel. */
export const packetMessage = (session, packet, at) => ({
  type: 'packet',
  session,
  at,
  hex: packet.toString('hex'),
});

/** A fake GEM: connects to the link like the real one, keeps what it receives. */
export async function fakeGem(port, { host = '127.0.0.1', localAddress } = {}) {
  const socket = connect({ host, port, ...(localAddress ? { localAddress } : {}) });
  const received = [];
  let closed = false;
  socket.on('data', (chunk) => received.push(chunk));
  socket.on('error', () => {});
  socket.on('close', () => {
    closed = true;
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    send: (data) => socket.write(data),
    get bytes() {
      return Buffer.concat(received);
    },
    get closed() {
      return closed;
    },
    close: () => socket.destroy(),
  };
}

/** The channel of the app, played by the test. */
export class FakeChannel extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.connected = false;
    this.sent = [];
    this.starts = 0;
  }

  start() {
    this.starts += 1;
  }

  stop() {
    this.stopped = true;
    this.connected = false;
  }

  send(message) {
    if (!this.connected) return false;
    this.sent.push(message);
    return true;
  }

  retryNow() {}

  up(session = null) {
    this.connected = true;
    this.emit('up', { session, queued: 0, dropped: 0 });
  }

  down() {
    this.connected = false;
    this.emit('down');
  }
}

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) =>
        logs.push(
          `${level}: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}`,
        ),
    ]),
  );

export const linkContainer = (status = 'running') => ({
  name: LINK.name,
  status,
  desired: 'running',
  ports: [
    {
      container_port: LINK.gemPort,
      protocol: 'tcp',
      host_port: HOST_PORT,
      name: LINK.portName,
      label: { en: 'x' },
      browsable: false,
    },
  ],
  devices: [],
});

/**
 * The app on the SDK's fake Gladys, a virtual clock (moving at every read),
 * a fake channel and a memory /data.
 */
export async function setup(
  t,
  {
    config = CONFIG,
    store = memoryStore(),
    containers = [linkContainer()],
    connect: doConnect = true,
    gladysOptions = {},
    clock = testClock(),
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, containers, ...gladysOptions });
  const logs = [];
  const channels = [];
  const app = new GreenEyeApp({
    gladys,
    logger: recorder(logs),
    store,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    createChannel: (options) => {
      const channel = new FakeChannel(options);
      channels.push(channel);
      return channel;
    },
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await app.boot();
  if (doConnect) {
    await gladys.connect();
    await settle(20);
  }
  const channel = () => channels.at(-1);
  const at = () => new Date(clock.now()).toISOString();
  /** The GEM connects to the link (session `id`). */
  const gemUp = async (id = 1, from = GEM_IP) => {
    if (!channel().connected) channel().up(null);
    channel().emit('message', { type: 'session', state: 'up', session: id, from, at: at() });
    await settle(10);
  };
  /** The GEM sends a packet (in the current session). */
  const send = async (packet, { id = app.session?.id ?? 1, stamp = at() } = {}) => {
    channel().emit('message', packetMessage(id, packet, stamp));
    await settle(10);
  };
  const advance = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  /** Lets the publisher flush (a second of virtual time). */
  const flush = async () => {
    await advance(1100);
  };
  /** Creates in Gladys every device of the Discovery (as the user would). */
  const createAll = async () => {
    for (const d of gladys.fake.discoveredDevices ?? []) {
      const known = gladys.devices.find((c) => c.external_id === d.external_id);
      if (!known) await gladys.fake.deviceCreated(d);
      else if (known.features.length !== d.features.length) await gladys.fake.deviceUpdated(d);
    }
    await settle(20);
  };
  return {
    gladys,
    app,
    clock,
    logs,
    channel,
    channels,
    gemUp,
    send,
    advance,
    flush,
    createAll,
    store,
    at,
  };
}

export const status = (gladys) => gladys.fake.connectionStatus ?? { message: {} };
