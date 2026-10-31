// -----------------------------------------------------------------------------
// The app on the SDK's fake Gladys (the real handlers of src/handlers.js), a
// virtual clock that moves at every read, a fake channel played as the link.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LINK, MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { parsePacket } from '../src/gem/packets.js';
import { testClock } from './kit/index.mjs';
import {
  CONFIG,
  GEM_IP,
  HOST_PORT,
  KWH,
  SERIAL,
  buildPacket,
  capture,
  channelDevice,
  channelFeature,
  device,
  monitorFeature,
  settle,
  setup,
  status,
} from './fixtures/gem.js';

const startCalls = (gladys) => gladys.fake.bodies('POST', `/container/${LINK.name}/start`);
const stopCalls = (gladys) => gladys.fake.bodies('POST', `/container/${LINK.name}/stop`);
const states = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
const msg = (gladys) => status(gladys).message.en ?? '';

/**
 * A GEM sending a packet every `every` seconds: `step(n)` sends the next one
 * with the counters given by `shape(seconds)` and moves the clock.
 */
function gem(ctx, shape, { every = 10, start = 1000, format = 'BIN32_NET' } = {}) {
  let seconds = start;
  return {
    async next(times = 1, extra = {}) {
      for (let i = 0; i < times; i += 1) {
        await ctx.send(buildPacket({ format, seconds, ...shape(seconds), ...extra }));
        seconds += every;
        await ctx.advance(every * SECOND);
      }
    },
    get seconds() {
      return seconds;
    },
  };
}

/** Channel 1 drawing 1 kW from 100 kWh, channel 2 idle at junk 5 Ws. */
const steady = (seconds) => ({
  absolute: [100 * KWH + (seconds - 1000) * 1000, 5],
  currents: [4.2, 0],
});

/** Up, two packets, devices created, a minute of packets: the counters published. */
async function running(t, options = {}) {
  const ctx = await setup(t, options);
  await ctx.gemUp();
  const g = gem(ctx, options.shape ?? steady, options.gem);
  await g.next(2);
  await ctx.createAll();
  await g.next(7);
  return { ...ctx, g };
}

test('without an address nothing listens: the link is never started, the status asks for it', async (t) => {
  const { gladys } = await setup(t, { config: {} });
  assert.equal(startCalls(gladys).length, 0);
  assert.equal(stopCalls(gladys).length, 1, 'a link left running from before is stopped');
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /adresse IP du GreenEye Monitor/);
});

test('an invalid address (name, broadcast, multicast, 0.0.0.0, port) is refused, the link not started', async (t) => {
  for (const address of [
    'gem.local',
    '255.255.255.255',
    '224.0.0.1',
    '0.0.0.0',
    '192.168.1.70:8000',
  ]) {
    const { gladys } = await setup(t, { config: { gem_address: address } });
    assert.equal(startCalls(gladys).length, 0, address);
    assert.match(msg(gladys), /not a valid IP address/, address);
  }
});

test('a saved address starts the link with the sender checked and the channel secret', async (t) => {
  const ctx = await setup(t);
  const [body] = startCalls(ctx.gladys);
  assert.equal(body.env.GEM_ADDRESS, GEM_IP);
  assert.equal(body.env.GEM_PORT, '8000');
  assert.equal(body.env.CHANNEL_PORT, String(LINK.channelPort));
  assert.equal(body.env.CHANNEL_TOKEN, ctx.store.data.token);
  assert.match(msg(ctx.gladys), /does not answer this container yet/);
  ctx.channel().up(null);
  await ctx.advance(100);
  assert.match(status(ctx.gladys).message.fr, new RegExp(`port ${HOST_PORT}`));
  // The same environment again: never restarted (it would drop the GEM session).
  await ctx.gladys.fake.configUpdated({ ...CONFIG, language: 'en' });
  assert.equal(startCalls(ctx.gladys).length, 1);
  // The sender check off: the link accepts any address.
  await ctx.gladys.fake.configUpdated({ ...CONFIG, check_source: false });
  assert.equal(startCalls(ctx.gladys).at(-1).env.GEM_ADDRESS, undefined);
  // The address removed: stopped.
  await ctx.gladys.fake.configUpdated({ gem_address: '' });
  assert.equal(stopCalls(ctx.gladys).length, 1);
  assert.match(msg(ctx.gladys), /Type the IP address/);
});

test('packets: the monitor and the channels that measured energy are discovered, values published', async (t) => {
  const ctx = await running(t);
  const devices = ctx.gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [device(String(SERIAL)), channelDevice(1)],
    'channel 2 (counter never moving) is not shown',
  );
  assert.deepEqual(
    devices[1].features.map((f) => f.external_id.split(':').at(-1)),
    ['index', 'power', 'current'],
  );
  for (const d of devices) for (const f of d.features) assert.equal(f.read_only, true);
  await ctx.flush();
  assert.equal(ctx.gladys.fake.lastState(channelFeature(1, 'power')), 1000);
  assert.equal(ctx.gladys.fake.lastState(channelFeature(1, 'current')), 4.2);
  assert.equal(ctx.gladys.fake.lastState(monitorFeature('voltage')), 120);
  const index = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  assert.ok(index > 100 && index < 101, String(index));
  assert.equal(status(ctx.gladys).connected, true);
  assert.match(msg(ctx.gladys), /GEM 1100603 connected \(BIN32-NET\), 1 channel/);
  assert.equal(ctx.store.data.serial, SERIAL, 'the first GEM heard is pinned in /data');
  // The index once a minute, never at every packet.
  const published = states(ctx.gladys, channelFeature(1, 'index')).length;
  await ctx.g.next(3);
  await ctx.flush();
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).length <= published + 1);
  // Nothing is ever sent to the GEM: the channel carries nothing from this side.
  assert.deepEqual(ctx.channel().sent, []);
});

test('nothing is published for a device not created in Gladys', async (t) => {
  const ctx = await setup(t);
  await ctx.gemUp();
  const g = gem(ctx, steady);
  await g.next(8);
  await ctx.flush();
  assert.deepEqual(ctx.gladys.fake.states, []);
});

test('the reference captures: junk channels of a BIN48 packet never appear by themselves', async (t) => {
  const ctx = await setup(t);
  await ctx.gemUp();
  await ctx.send(capture('BIN48-NET'));
  await ctx.advance(10 * SECOND);
  // The same counters (as a GEM with nothing drawing): no channel measured energy.
  const again = Buffer.from(capture('BIN48-NET'));
  await ctx.send(again);
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [device('1100603')],
  );
  assert.match(msg(ctx.gladys), /BIN48-NET/);
  // Junk that moves far beyond what a CT can measure is not energy either.
  const p = Buffer.from(capture('BIN48-NET'));
  const parsed = parsePacket(p);
  await ctx.advance(10 * SECOND);
  await ctx.send(
    buildPacket({
      format: 'BIN48_NET',
      seconds: parsed.seconds + 10,
      absolute: parsed.absolute.map((v, i) => (i === 40 ? v + 2 ** 38 : v)),
      polarized: parsed.polarized,
    }),
  );
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 1);
});

test('the channels typed are shown whatever they measured; an invalid list is said', async (t) => {
  const ctx = await setup(t, { config: { ...CONFIG, channels: '2, 5-6' } });
  await ctx.gemUp();
  await ctx.send(buildPacket({ seconds: 10, absolute: [1, 2] }));
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.slice(1).map((d) => d.external_id),
    [channelDevice(2), channelDevice(5), channelDevice(6)],
  );
  await ctx.gladys.fake.configUpdated({ ...CONFIG, channels: '1-99' });
  assert.match(msg(ctx.gladys), /list of channels is not valid/);
});

test('NET channel producing: signed power, a production index appears and is published', async (t) => {
  const solar = (seconds) => {
    const s = seconds - 1000;
    // 500 W consumed then 2 kW produced each second: absolute = both, polarized = produced.
    return {
      absolute: [10 * KWH + s * 2500],
      polarized: [3 * KWH + s * 2000],
      currents: [9],
    };
  };
  const ctx = await running(t, { shape: solar });
  const ch = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === channelDevice(1));
  assert.ok(ch.features.some((f) => f.external_id === channelFeature(1, 'production')));
  await ctx.createAll();
  await ctx.g.next(7);
  await ctx.flush();
  assert.equal(ctx.gladys.fake.lastState(channelFeature(1, 'power')), -1500);
  const consumed = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  const produced = ctx.gladys.fake.lastState(channelFeature(1, 'production'));
  assert.ok(consumed > 7 && consumed < 7.2, String(consumed));
  assert.ok(produced > 3 && produced < 3.5, String(produced));
});

test('a counter that jumps or drops is held, said, the last value sent again; never by time', async (t) => {
  let offset = 0;
  const ctx = await running(t, {
    shape: (seconds) => ({ absolute: [100 * KWH + (seconds - 1000) * 1000 + offset, 5] }),
  });
  await ctx.flush();
  const before = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  const published = states(ctx.gladys, channelFeature(1, 'index')).length;
  // The CT replaced: the counter restarts near 0.
  offset = -100 * KWH + 1;
  await ctx.g.next(7);
  await ctx.flush();
  assert.match(
    msg(ctx.gladys),
    /Counters held back[\s\S]*channel 1: 100\.\d+ → 0\.\d+ kWh \(drop\)/,
  );
  const after = states(ctx.gladys, channelFeature(1, 'index')).slice(published);
  // The last accepted value only (unchanged: publishChangedStates sends it with its heartbeat).
  assert.ok(after.every((v) => v === before));
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v > 1));
  // The power over the reset (a delta through the wrap) is never published.
  assert.ok(states(ctx.gladys, channelFeature(1, 'power')).every((w) => w >= 0 && w <= 200_000));
  assert.ok(!ctx.gladys.fake.requests.some((r) => r.status === 400), 'nothing refused by Gladys');
  // Days pass: still held.
  for (let day = 0; day < 3; day += 1) {
    await ctx.advance(24 * 60 * MINUTE);
    await ctx.g.next(1);
  }
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /Counters held back/);
  assert.ok(ctx.store.data.guards.ch1.held, 'kept in /data');
  assert.equal(ctx.store.data.guards.ch1.held.direction, 'down');
});

test('two clicks accept exactly the counters listed; one click, a click too soon or a change accept nothing', async (t) => {
  let offset = 0;
  const ctx = await running(t, {
    shape: (seconds) => ({ absolute: [100 * KWH + (seconds - 1000) * 1000 + offset, 5] }),
  });
  const click = async () => (await ctx.gladys.fake.action('accept_held_counters', {})).data.message;
  assert.match((await click()).en, /No counter is held back/);
  offset = 5000 * KWH;
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /\(jump\)/);
  const first = await click();
  assert.match(
    first.en,
    /Nothing accepted yet\. A second click accepts exactly: channel 1: 100\.\d+ → 5100\.\d+ kWh \(jump\)/,
  );
  assert.match(first.fr, /Rien n’est encore accepté/);
  // Too soon (under 3 s): listed again, nothing taken.
  assert.match((await click()).en, /Nothing accepted yet/);
  await ctx.advance(4 * SECOND);
  // The value moved far beyond the margin since the first click: nothing accepted.
  await ctx.advance(4 * SECOND);
  offset = 9000 * KWH;
  await ctx.g.next(7);
  assert.match((await click()).en, /changed since the first click: nothing accepted/);
  assert.match(msg(ctx.gladys), /\(jump\)/);
  // A clean two clicks.
  assert.match((await click()).en, /accepts exactly: channel 1: 100\.\d+ → 9100\.\d+ kWh/);
  await ctx.advance(5 * SECOND);
  const done = await click();
  assert.match(done.en, /^Accepted: channel 1/);
  await ctx.g.next(7);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.lastState(channelFeature(1, 'index')) > 9000);
  assert.doesNotMatch(msg(ctx.gladys), /Counters held back/);
  // Too late (over 5 minutes) after a first click: a first click again.
  offset = 0;
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /\(drop\)/);
  await click();
  await ctx.advance(6 * MINUTE);
  assert.match((await click()).en, /Nothing accepted yet/);
  // Saving the configuration never accepts.
  await ctx.gladys.fake.configUpdated({ ...CONFIG });
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /\(drop\)/);
});

test('a hold survives a restart (from /data), and the session clock ignores a wall clock jump', async (t) => {
  let offset = 0;
  const shape = (seconds) => ({ absolute: [100 * KWH + (seconds - 1000) * 1000 + offset, 5] });
  const store = memoryStore();
  const base = testClock();
  let skew = 0;
  const clock = {
    now: () => base.now() + skew,
    monotonic: base.monotonic,
    timers: base.timers,
    advance: (ms) => base.advance(ms),
  };
  const first = await running(t, { store, clock, shape });
  offset = 50 * KWH;
  await first.g.next(7);
  assert.match(msg(first.gladys), /\(jump\)/);
  await first.app.stop();
  // NTP moves the wall clock 30 days ahead: the margin must not cover the jump.
  skew = 30 * 24 * 60 * MINUTE;
  const devices = first.gladys.devices;
  const second = await setup(t, { store, clock, gladysOptions: { devices } });
  await second.gemUp();
  const g = { s: first.g.seconds };
  for (let i = 0; i < 8; i += 1) {
    await second.send(buildPacket({ seconds: g.s, ...shape(g.s) }));
    g.s += 10;
    await second.advance(10 * SECOND);
  }
  assert.match(msg(second.gladys), /Counters held back[\s\S]*\(jump\)/);
  await second.flush();
  assert.ok(
    states(second.gladys, channelFeature(1, 'index')).every((v) => v < 140),
    'the jump never published',
  );
});

test('a reference from /data dated in the future is taken as now (a normal rise goes through)', async (t) => {
  const clock = testClock();
  const store = memoryStore({
    token: 'k'.repeat(43),
    serial: SERIAL,
    seen: { channels: [1] },
    guards: { ch1: { last: { value: 100, at: clock.now() + 24 * 60 * MINUTE }, held: null } },
  });
  const ctx = await setup(t, { store, clock });
  await ctx.createAll();
  await ctx.gemUp();
  await ctx.advance(2 * MINUTE);
  // 1 kWh two minutes later: within 100 kWh/h + 0.5.
  await ctx.send(buildPacket({ seconds: 10, absolute: [101 * KWH] }));
  await ctx.flush();
  assert.equal(ctx.gladys.fake.lastState(channelFeature(1, 'index')), 101);
  assert.doesNotMatch(msg(ctx.gladys), /held back/);
});

test('a value of 0 is never published, from the GEM or from Gladys', async (t) => {
  const ctx = await running(t, {
    config: { ...CONFIG, channels: '1' },
    shape: () => ({ absolute: [0, 5], pulses: [0, 0, 0, 0] }),
  });
  assert.ok(ctx.gladys.devices.some((d) => d.external_id === channelDevice(1)));
  await ctx.g.next(7);
  await ctx.flush();
  assert.deepEqual(states(ctx.gladys, channelFeature(1, 'index')), []);
});

test('another GEM is refused and said; its serial typed, it is followed with its own devices', async (t) => {
  const ctx = await running(t);
  const other = 2_200_001;
  await ctx.send(buildPacket({ serial: other, seconds: 5000, absolute: [1, 1] }));
  assert.match(
    msg(ctx.gladys),
    /Packets of GEM 2200001 refused: this integration follows GEM 1100603 \(the first one heard\)/,
  );
  assert.equal(ctx.store.data.serial, SERIAL);
  assert.ok(ctx.store.data.guards.ch1, 'the counter of the first GEM kept');
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: '2200001' });
  assert.equal(ctx.store.data.serial, other);
  assert.deepEqual(ctx.store.data.guards, {});
  await ctx.send(buildPacket({ serial: other, seconds: 6000, absolute: [5 * KWH] }));
  await ctx.advance(10 * SECOND);
  await ctx.send(buildPacket({ serial: other, seconds: 6010, absolute: [5 * KWH + 10_000] }));
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [device(String(other)), channelDevice(1, other)],
  );
  await ctx.send(buildPacket({ serial: SERIAL, seconds: 9999, absolute: [1] }));
  assert.match(
    msg(ctx.gladys),
    /Packets of GEM 1100603 refused: this integration follows GEM 2200001 \(the serial number typed\)/,
  );
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: 'abc' });
  assert.match(msg(ctx.gladys), /serial number typed is not valid/);
});

test('order and freshness: a repeat, an older packet, a packet kept over a minute are dropped', async (t) => {
  const ctx = await running(t);
  await ctx.flush();
  const count = () => states(ctx.gladys, channelFeature(1, 'current')).length;
  const seconds = ctx.g.seconds - 10;
  const current = (c) => buildPacket({ seconds, ...steady(seconds), currents: [c] });
  await ctx.send(current(77)); // the same seconds as the last one taken
  await ctx.send(buildPacket({ seconds: seconds - 30, ...steady(seconds - 30), currents: [66] }));
  await ctx.send(buildPacket({ seconds: seconds + 10, ...steady(seconds + 10), currents: [55] }), {
    stamp: new Date(ctx.clock.now() - 2 * MINUTE).toISOString(),
  });
  await ctx.flush();
  assert.ok(
    !states(ctx.gladys, channelFeature(1, 'current')).some((v) => [77, 66, 55].includes(v)),
  );
  assert.ok(count() > 0);
  // A wrap of the seconds counter of the GEM is not an old packet.
  const wrap = gem(ctx, steady, { start: 2 ** 24 - 5 });
  await wrap.next(2);
  await ctx.flush();
});

test('temperatures: off by default; °F converted; 0 and missing sensors never published', async (t) => {
  const temps = [null, 68, 0, -4, 300, null, null, null];
  const ctx = await running(t, {
    shape: (seconds) => ({ ...steady(seconds), temperatures: temps }),
  });
  assert.ok(
    !ctx.gladys.fake.discoveredDevices[0].features.some((f) => /temp-/.test(f.external_id)),
  );
  assert.match(msg(ctx.gladys), /Temperatures not published/);
  await ctx.gladys.fake.configUpdated({ ...CONFIG, temperature_unit: 'fahrenheit' });
  await ctx.g.next(1);
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices[0].features.map((f) => f.external_id.split(':').at(-1)),
    ['voltage', 'temp-2', 'temp-4'],
  );
  await ctx.createAll();
  await ctx.g.next(1);
  await ctx.flush();
  assert.equal(ctx.gladys.fake.lastState(monitorFeature('temp-2')), 20);
  assert.equal(ctx.gladys.fake.lastState(monitorFeature('temp-4')), -20);
  assert.doesNotMatch(msg(ctx.gladys), /Temperatures not published/);
});

test('pulse counters: appear once they rose, guarded like the energy', async (t) => {
  let pulses = 1000;
  const ctx = await running(t, {
    shape: (seconds) => ({ ...steady(seconds), pulses: [0, (pulses += 3), 7, 0] }),
  });
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices[0].features.map((f) => f.external_id.split(':').at(-1)),
    ['voltage', 'pulse-2'],
  );
  await ctx.createAll();
  await ctx.g.next(7);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.lastState(monitorFeature('pulse-2')) > 1000);
  pulses = 1;
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /pulse counter 2: \d+ → \d+ pulses \(drop\)/);
});

test('a GEM that opens a connection for each packet stays connected while packets come', async (t) => {
  const ctx = await running(t);
  for (let i = 2; i < 6; i += 1) {
    ctx.channel().emit('message', { type: 'session', state: 'down', session: i - 1, at: ctx.at() });
    await ctx.gemUp(i);
    await ctx.g.next(1);
    assert.equal(status(ctx.gladys).connected, true);
  }
  await ctx.flush();
  assert.equal(
    ctx.gladys.fake.lastState(channelFeature(1, 'power')),
    1000,
    'the power across sessions',
  );
});

test('no packet for a while: stale, not connected, nothing published', async (t) => {
  const ctx = await running(t);
  await ctx.flush();
  const before = ctx.gladys.fake.states.length;
  await ctx.advance(3 * MINUTE);
  assert.equal(status(ctx.gladys).connected, false);
  assert.match(msg(ctx.gladys), /No packet from GEM 1100603 for 3 min: nothing is published/);
  assert.equal(ctx.gladys.fake.states.length, before);
  await ctx.g.next(1);
  assert.equal(status(ctx.gladys).connected, true);
});

test('getConfig failing in connected: retried without end, the status says it, then it works', async (t) => {
  const gladysOptions = {};
  const ctx = await setup(t, { connect: false, gladysOptions });
  let failures = 3;
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  t.mock.method(ctx.gladys, 'getConfig', async () => {
    // The SDK reads it too while connecting: only the app's reads fail.
    if (!new Error().stack.includes('gladysConnected')) return original();
    if (failures > 0) {
      failures -= 1;
      throw new Error('boom');
    }
    return original();
  });
  await ctx.gladys.connect();
  await settle(20);
  assert.match(msg(ctx.gladys), /could not be read from Gladys \(attempt 1\)/);
  await ctx.advance(5 * SECOND);
  assert.match(msg(ctx.gladys), /attempt 2/);
  await ctx.advance(10 * SECOND);
  await ctx.advance(30 * SECOND);
  assert.equal(startCalls(ctx.gladys).length, 1);
  assert.match(msg(ctx.gladys), /does not answer this container yet/);
  // Gladys reconnects and fails once more: retried again, never given up.
  failures = 1;
  await ctx.gladys.disconnect();
  await ctx.gladys.connect();
  await settle(20);
  assert.match(msg(ctx.gladys), /attempt 1/);
  await ctx.advance(6 * SECOND);
  assert.doesNotMatch(msg(ctx.gladys), /could not be read/);
});

test('/data unreadable: never overwritten, said; values still published', async (t) => {
  const store = memoryStore({ token: 'k'.repeat(43), serial: SERIAL }, { unreadable: true });
  const ctx = await running(t, { store });
  assert.equal(store.saves, 0);
  assert.match(msg(ctx.gladys), /cannot be read: it is never overwritten/);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.lastState(channelFeature(1, 'power')) > 0);
});

test('/data frozen: the start and the saves never wait without bound', async (t) => {
  const store = memoryStore();
  store.loadHold = new Promise(() => {});
  const clock = testClock();
  const gladys = createFakeGladys({ config: CONFIG });
  const { GreenEyeApp } = await import('../src/app.js');
  const app = new GreenEyeApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    createChannel: () => ({ on() {}, start() {}, stop() {}, retryNow() {} }),
  });
  t.after(() => app.stop());
  let booted = false;
  app.boot().then(() => (booted = true));
  await settle(10);
  assert.equal(booted, false);
  await clock.advance(5 * SECOND);
  await settle(10);
  assert.equal(booted, true, 'given up after 5 s');
  assert.equal(app.unreadable, true, 'a frozen /data is never taken for an empty one');

  // Saves hanging: packets keep flowing, the save resolves false within 5 s.
  const store2 = memoryStore();
  const ctx = await setup(t, { store: store2 });
  let release;
  store2.hold = new Promise((resolve) => (release = resolve));
  let direct;
  ctx.app.saveMemory().then((r) => (direct = r));
  await ctx.advance(6 * SECOND);
  assert.equal(direct, false, 'a save hanging is given up after 5 s');
  await ctx.gemUp();
  const g = gem(ctx, steady);
  await g.next(2);
  let result;
  ctx.app.saveMemory().then((r) => (result = r));
  await ctx.advance(6 * SECOND);
  assert.equal(result, false);
  await ctx.createAll();
  await g.next(3);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.lastState(channelFeature(1, 'power')) > 0);
  release();
});

test('a save failing: said in the status, held counters kept in memory', async (t) => {
  const store = memoryStore();
  let offset = 0;
  const ctx = await running(t, {
    store,
    shape: (s) => ({ absolute: [100 * KWH + (s - 1000) * 1000 + offset, 5] }),
  });
  store.failing = true;
  offset = 900 * KWH;
  await ctx.g.next(7);
  await ctx.advance(SECOND);
  assert.match(msg(ctx.gladys), /\(jump\)/);
  assert.match(msg(ctx.gladys), /\/data could not be written/);
});

test('48 channels at a packet a second stay within the 250 states a minute of Gladys', async (t) => {
  const many = (seconds) => ({
    absolute: Array.from({ length: 48 }, (_, i) => (i + 1) * KWH + (seconds - 1000) * (i + 1) * 10),
    currents: Array.from({ length: 48 }, (_, i) => (seconds % 7) + i / 10),
  });
  const ctx = await running(t, { shape: many, gem: { every: 1, format: 'BIN48_NET' } });
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 49);
  const before = ctx.gladys.fake.states.length;
  await ctx.g.next(60);
  const sent = ctx.gladys.fake.states.length - before;
  assert.ok(sent <= 260, `${sent} states in a minute`);
  assert.ok(sent > 100, `${sent} states in a minute`);
});

test('the connection refused from another address and junk are said in the status', async (t) => {
  const ctx = await running(t);
  ctx.channel().emit('message', { type: 'refused', from: '192.168.1.99', count: 2, at: ctx.at() });
  ctx.channel().emit('message', { type: 'junk', session: 1, ecm: 1, malformed: 3, skipped: 9 });
  await settle(10);
  assert.match(msg(ctx.gladys), /2 connection\(s\) refused from 192\.168\.1\.99/);
  assert.match(msg(ctx.gladys), /1 ECM packet\(s\) ignored[^.]*\. 3 malformed/);
  // Garbage from the channel itself never stops anything.
  for (const bad of [
    null,
    { type: 'packet', session: 1, at: ctx.at(), hex: 'zz' },
    { type: 'packet', session: 1, at: ctx.at(), hex: 'feff07' },
  ]) {
    ctx.channel().emit('message', bad);
  }
  await ctx.g.next(1);
  assert.equal(status(ctx.gladys).connected, true);
});

test('Gladys reconnecting: nothing old published again, the Discovery and the status sent again', async (t) => {
  const ctx = await running(t);
  await ctx.flush();
  await ctx.gladys.disconnect();
  const before = ctx.gladys.fake.states.length;
  await ctx.gladys.connect();
  await settle(20);
  await ctx.advance(5 * SECOND);
  assert.equal(ctx.gladys.fake.states.length, before, 'no state before a new packet');
  await ctx.g.next(1);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.states.length > before);
});

test('every supported_options published follows the rules of the core (none here)', async (t) => {
  const ctx = await running(t, {
    config: { ...CONFIG, temperature_unit: 'celsius', channels: '1-48' },
    shape: (s) => ({
      ...steady(s),
      temperatures: [20, 21, 0, 0, 0, 0, 0, 0],
      pulses: [s, 0, 0, 0],
    }),
  });
  for (const d of ctx.gladys.fake.discoveredDevices) {
    for (const f of d.features) {
      if (f.supported_options === undefined) continue;
      assert.ok(Array.isArray(f.supported_options));
      const values = new Set();
      for (const option of f.supported_options) {
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label === option.label.trim());
        assert.ok(!values.has(option.value));
        values.add(option.value);
      }
    }
  }
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 49);
});

test('the channel secret never reaches the logs, the status nor the Discovery', async (t) => {
  const ctx = await running(t);
  const token = ctx.store.data.token;
  assert.ok(token.length >= 32);
  assert.ok(!ctx.logs.join('\n').includes(token));
  assert.ok(!JSON.stringify(ctx.gladys.fake.connectionStatuses).includes(token));
  assert.ok(!JSON.stringify(ctx.gladys.fake.discoveredDevices).includes(token));
  assert.ok(!JSON.stringify(ctx.gladys.fake.states).includes(token));
});
