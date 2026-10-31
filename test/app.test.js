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
/** What /data keeps for a serial. */
const unitIn = (store, serial) => store.data.serials.find((u) => u.serial === serial);
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
  const kept = unitIn(ctx.store, SERIAL).guards.ch1;
  assert.ok(kept.held, 'kept in /data');
  assert.equal(kept.held.direction, 'down');
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
    serials: [
      {
        serial: SERIAL,
        seen: { channels: [1] },
        guards: {
          ch1: { last: { value: 100, at: clock.now() + 24 * 60 * MINUTE }, held: null },
        },
      },
    ],
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
  assert.ok(unitIn(ctx.store, SERIAL).guards.ch1, 'the counter of the first GEM kept');
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: '2200001' });
  assert.equal(ctx.store.data.serial, other);
  assert.deepEqual(unitIn(ctx.store, other).guards, {});
  assert.ok(unitIn(ctx.store, SERIAL).guards.ch1, 'never wiped by a change of serial');
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

test('/data unreadable: never overwritten, no pin learned, only a typed serial followed', async (t) => {
  const store = memoryStore({ token: 'k'.repeat(43), serial: SERIAL }, { unreadable: true });
  const ctx = await setup(t, { store });
  await ctx.gemUp();
  const g = gem(ctx, steady);
  await g.next(3);
  assert.equal(store.saves, 0);
  assert.match(msg(ctx.gladys), /cannot be read: it is never overwritten/);
  assert.match(msg(ctx.gladys), /GEM 1100603 heard but not followed: \/data cannot be read/);
  assert.equal(ctx.app.memory.serial, undefined, 'nothing pinned');
  assert.equal(ctx.gladys.fake.discoveredDevices?.length ?? 0, 0);
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: String(SERIAL) });
  await g.next(2);
  await ctx.createAll();
  await g.next(2);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.lastState(channelFeature(1, 'power')) > 0);
  assert.equal(store.saves, 0);
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

// --- Review r1 -----------------------------------------------------------------------------

/** A test clock whose wall clock can be moved (NTP) without touching the monotonic one. */
function skewClock() {
  const base = testClock();
  const clock = {
    skew: 0,
    now: () => base.now() + clock.skew,
    monotonic: base.monotonic,
    timers: base.timers,
    advance: (ms) => base.advance(ms),
  };
  return clock;
}

const click = async (ctx) =>
  (await ctx.gladys.fake.action('accept_held_counters', {})).data.message;

test('I1: an ABS counter wrapping at 2^40 Ws is counted on, never held, nothing lost; kept in /data', async (t) => {
  const W40 = 2 ** 40;
  const start = W40 - 30 * 20_000;
  const store = memoryStore();
  const shape = (s) => ({ absolute: [(start + (s - 1000) * 2000) % W40, 5] });
  const ctx = await running(t, { store, shape, gem: { format: 'BIN32_ABS' } });
  await ctx.g.next(45);
  await ctx.flush();
  const values = states(ctx.gladys, channelFeature(1, 'index'));
  assert.ok(values.at(-1) > 305_419.89, String(values.at(-1)));
  assert.ok(
    values.every((v, i) => i === 0 || v >= values[i - 1]),
    'never going down',
  );
  assert.doesNotMatch(msg(ctx.gladys), /held back/);
  assert.equal(unitIn(store, SERIAL).wraps['abs-1'].offset, W40);
  // A restart keeps the offset: the index goes on.
  await ctx.app.stop();
  const devices = ctx.gladys.devices;
  const again = await setup(t, { store, gladysOptions: { devices } });
  await again.gemUp();
  const g = gem(again, shape, { start: ctx.g.seconds, format: 'BIN32_ABS' });
  await g.next(8);
  await again.flush();
  assert.ok(again.gladys.fake.lastState(channelFeature(1, 'index')) > values.at(-1));
  assert.doesNotMatch(msg(again.gladys), /held back/);
});

test('I1: a NET channel whose absolute counter wraps keeps its consumption index (never frozen)', async (t) => {
  const W40 = 2 ** 40;
  const start = W40 - 30 * 50_000;
  const produced = 200_000 * KWH;
  const shape = (s) => ({
    absolute: [(start + (s - 1000) * 5000) % W40],
    polarized: [produced + (s - 1000) * 1000],
  });
  const ctx = await running(t, { shape });
  await ctx.createAll();
  await ctx.g.next(40);
  await ctx.flush();
  const values = states(ctx.gladys, channelFeature(1, 'index'));
  const last = values.at(-1);
  assert.ok(last > (start - produced) / KWH, String(last));
  assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]));
  assert.doesNotMatch(msg(ctx.gladys), /held back|0 or less/);
  assert.ok(ctx.gladys.fake.lastState(channelFeature(1, 'production')) > 200_000);
});

test('I1: a pulse counter wrapping at 2^24 is counted on; a reset far from the top stays held', async (t) => {
  const W24 = 2 ** 24;
  let reset = false;
  const shape = (s) => ({
    ...steady(s),
    pulses: [reset ? 3 : (W24 - 100 + (s - 1000)) % W24, 0, 0, 0],
  });
  const ctx = await running(t, { shape });
  await ctx.createAll();
  await ctx.g.next(21);
  await ctx.flush();
  assert.ok(ctx.gladys.fake.lastState(monitorFeature('pulse-1')) > W24);
  assert.doesNotMatch(msg(ctx.gladys), /held back/);
  reset = true;
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /pulse counter 1: \d+ → \d+ pulses \(drop\)/);
});

test('I1: a NET counter reading 0 or less is said in the status, never published', async (t) => {
  const shape = (s) => ({ absolute: [10 * KWH + (s - 1000) * 1000], polarized: [20 * KWH] });
  const ctx = await running(t, { shape, config: { ...CONFIG, channels: '1' } });
  await ctx.createAll();
  await ctx.g.next(7);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /Counter\(s\) reading 0 or less, not published: channel 1/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v > 0));
});

test('I2: a mistyped serial then the right one keeps the hold; saving never accepts', async (t) => {
  let offset = 0;
  const shape = (s) => ({ absolute: [100 * KWH + (s - 1000) * 1000 + offset, 5] });
  const ctx = await running(t, { shape });
  offset = 50 * KWH;
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /\(jump\)/);
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: '1100604' });
  await ctx.g.next(3);
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: String(SERIAL) });
  await ctx.g.next(14);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /Counters held back[\s\S]*\(jump\)/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v < 140));
});

test('I2: a guard without /data is built on a fresh read of Gladys; a failed read publishes nothing', async (t) => {
  const ctx = await setup(t);
  await ctx.gemUp();
  const g = gem(ctx, steady);
  await g.next(2);
  await ctx.createAll();
  t.mock.method(ctx.gladys, 'getDevices', async () => {
    throw new Error('down');
  });
  await g.next(8);
  await ctx.flush();
  assert.deepEqual(states(ctx.gladys, channelFeature(1, 'index')), []);
  // Gladys holds 130 kWh for this index: the fresh read gives it, the jump down is held.
  const fresh = ctx.gladys.devices.map((d) => ({
    ...d,
    features: d.features.map((f) =>
      f.external_id === channelFeature(1, 'index')
        ? { ...f, last_value: 130, last_value_changed: new Date(ctx.clock.now()).toISOString() }
        : f,
    ),
  }));
  t.mock.method(ctx.gladys, 'getDevices', async () => fresh);
  await g.next(7);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /channel 1: 130 → 100\.\d+ kWh \(drop\)/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v === 130));
});

test('I3 E9: the guard runs on the session clock: NTP moving the wall clock 10 h ahead takes no jump', async (t) => {
  let offset = 0;
  const clock = skewClock();
  const shape = (s) => ({ absolute: [100 * KWH + (s - 1000) * 1000 + offset, 5] });
  const ctx = await running(t, { shape, clock });
  await ctx.flush();
  clock.skew = 10 * 60 * MINUTE;
  offset = 50 * KWH;
  await ctx.g.next(7);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /\(jump\)/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v < 140));
});

test('I3 E8: a last value of Gladys dated in the future is taken as now', async (t) => {
  const clock = testClock();
  const future = new Date(clock.now() + 24 * 60 * MINUTE).toISOString();
  const store = memoryStore({
    token: 'k'.repeat(43),
    serial: SERIAL,
    serials: [{ serial: SERIAL, seen: { channels: [1] } }],
  });
  const first = await setup(t, { store, clock });
  const devices = first.gladys.fake.discoveredDevices.map((d) => ({
    ...d,
    features: d.features.map((f) =>
      f.external_id === channelFeature(1, 'index')
        ? { ...f, last_value: 150, last_value_changed: future }
        : f,
    ),
  }));
  await first.app.stop();
  const ctx = await setup(t, { store, clock, gladysOptions: { devices } });
  await ctx.gemUp();
  await ctx.send(buildPacket({ seconds: 10, absolute: [150 * KWH] }));
  await ctx.advance(61 * SECOND);
  // 1.5 kWh a minute later: within 100 kWh/h + 0.5 from now, not from a date ahead.
  await ctx.send(buildPacket({ seconds: 71, absolute: [151.5 * KWH] }));
  await ctx.flush();
  assert.equal(ctx.gladys.fake.lastState(channelFeature(1, 'index')), 151.5);
});

test('I3 B3/B4/B5/B7: the second click takes nothing when the holds changed in any way', async (t) => {
  let off = [0, 0];
  const shape = (s) => ({
    absolute: [100 * KWH + (s - 1000) * 1000 + off[0], 50 * KWH + (s - 1000) * 1000 + off[1]],
  });
  const ctx = await running(t, { shape });
  // B3: one more counter held after the first click.
  off = [5000 * KWH, 0];
  await ctx.g.next(7);
  assert.match((await click(ctx)).en, /accepts exactly: channel 1:/);
  off = [5000 * KWH, 5000 * KWH];
  await ctx.g.next(7);
  assert.match((await click(ctx)).en, /changed since the first click/);
  // Back to normal for both.
  off = [0, 0];
  await ctx.g.next(7);
  assert.doesNotMatch(msg(ctx.gladys), /held back/);
  // B4: the same jump, released and held again from another value.
  off = [5000 * KWH, 0];
  await ctx.g.next(7);
  await click(ctx);
  off = [0, 0];
  await ctx.g.next(7);
  off = [5000 * KWH, 0];
  await ctx.g.next(7);
  assert.match((await click(ctx)).en, /changed since the first click/);
  // B5: the device deleted and created again between the clicks.
  await click(ctx);
  const ch1 = ctx.gladys.devices.find((d) => d.external_id === channelDevice(1));
  await ctx.gladys.fake.deviceDeleted(ch1);
  await ctx.gladys.fake.deviceCreated(ch1);
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /channel 1: [\d.]+ → [\d.]+ kWh \(jump\)/);
  assert.match((await click(ctx)).en, /changed since the first click/);
  off = [0, 0];
  await ctx.g.next(7);
  assert.doesNotMatch(msg(ctx.gladys), /held back/);
  // B7: a drop listed, then a jump of the same counter from the same value.
  off = [-0.1 * KWH, 0];
  await ctx.g.next(6);
  assert.match((await click(ctx)).en, /channel 1: [\d.]+ → [\d.]+ kWh \(drop\)/);
  off = [3 * KWH, 0];
  await ctx.g.next(6);
  assert.match(msg(ctx.gladys), /\(jump\)/);
  await ctx.advance(2 * MINUTE);
  assert.match((await click(ctx)).en, /changed since the first click/);
});

test('I3 A2/A7/A8/M4/M6: another session, a long gap, produced over total, out-of-range values', async (t) => {
  const shape = (s) => ({
    absolute: [10 * KWH + (s - 1000) * 1000],
    polarized: [KWH + (s - 1000) * 100],
    currents: [4],
  });
  const ctx = await running(t, { shape });
  await ctx.flush();
  const powers = () => states(ctx.gladys, channelFeature(1, 'power'));
  const currents = () => states(ctx.gladys, channelFeature(1, 'current'));
  let s = ctx.g.seconds;
  // A2: a packet of another session (fresh seconds, its own current): ignored.
  await ctx.send(buildPacket({ seconds: s, ...shape(s), currents: [33] }), { id: 99 });
  await ctx.flush();
  assert.ok(!currents().includes(33), currents().join());
  // A7: two hours later (GEM seconds), 3 kW on average: no power over the gap.
  let before = powers().length;
  s += 7200;
  let abs = 10 * KWH + (s - 1000) * 1000 + 7200 * 2000;
  let pol = KWH + (s - 1000) * 100;
  await ctx.send(buildPacket({ seconds: s, absolute: [abs], polarized: [pol], currents: [5] }));
  await ctx.flush();
  assert.ok(currents().includes(5), 'the packet itself is taken');
  assert.equal(powers().length, before, powers().join());
  // A8: the produced energy grows more than the total: no power.
  before = powers().length;
  s += 10;
  abs += 1000;
  pol += 10_000;
  await ctx.send(buildPacket({ seconds: s, absolute: [abs], polarized: [pol], currents: [6] }));
  await ctx.flush();
  assert.ok(currents().includes(6));
  assert.equal(powers().length, before, powers().join());
  // M4/M6: 500 A, 0 V: not values.
  s += 10;
  abs += 20_000;
  await ctx.send(
    buildPacket({ seconds: s, voltage: 0, absolute: [abs], polarized: [pol], currents: [500] }),
  );
  await ctx.flush();
  assert.ok(!currents().includes(500));
  assert.ok(!states(ctx.gladys, monitorFeature('voltage')).includes(0));
  assert.ok(powers().includes(2000), 'the next packet in a row has its power');
});

test('I3 A4: nothing is pinned before the configuration is read', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, {
    store,
    connect: false,
    config: { ...CONFIG, gem_serial: '2200001' },
  });
  ctx.channel().up(null);
  await ctx.gemUp();
  await ctx.send(buildPacket({ seconds: 10, absolute: [1] }));
  await ctx.gladys.connect();
  await settle(20);
  assert.equal(ctx.app.memory.serial, 2_200_001);
  assert.ok(!(store.data.serials ?? []).some((u) => u.serial === SERIAL));
});

test('I3 M5: a feature of a created device is kept when the Discovery no longer builds it', async (t) => {
  const ctx = await running(t, {
    config: { ...CONFIG, temperature_unit: 'celsius' },
    shape: (s) => ({ ...steady(s), temperatures: [20, null, null, null, null, null, null, null] }),
  });
  await ctx.createAll();
  await ctx.gladys.fake.configUpdated({ ...CONFIG, temperature_unit: 'off' });
  const monitor = ctx.gladys.fake.discoveredDevices[0];
  assert.ok(monitor.features.some((f) => f.external_id === monitorFeature('temp-1')));
});

test('m1: a GEM restarting a few minutes after its start keeps sending values, said', async (t) => {
  const ctx = await running(t);
  await ctx.flush();
  // Restarted: its seconds counter starts again below the last one, in a new connection.
  ctx.channel().emit('message', { type: 'session', state: 'down', session: 1, at: ctx.at() });
  await ctx.gemUp(2);
  const g = gem(ctx, steady, { start: 1010 });
  await g.next(3);
  await ctx.flush();
  assert.equal(status(ctx.gladys).connected, true);
  assert.match(msg(ctx.gladys), /The GEM restarted/);
  assert.equal(ctx.gladys.fake.lastState(channelFeature(1, 'power')), 1000);
  // In the same connection, a step back is an old packet: dropped.
  await ctx.send(buildPacket({ seconds: 1015, ...steady(1015), currents: [44] }));
  await ctx.flush();
  assert.ok(!states(ctx.gladys, channelFeature(1, 'current')).includes(44));
});

test('m3: a save hanging on /data is said in the status after 5 s', async (t) => {
  const store = memoryStore();
  const ctx = await running(t, { store });
  let release;
  store.hold = new Promise((resolve) => (release = resolve));
  ctx.app.saveMemory();
  await ctx.advance(6 * SECOND);
  assert.match(msg(ctx.gladys), /\/data could not be written/);
  release();
  await settle(20);
  await ctx.advance(SECOND);
  assert.doesNotMatch(msg(ctx.gladys), /could not be written/);
});

test('m4: the serial field cleared, the first GEM heard is followed again and said so', async (t) => {
  const ctx = await running(t, { config: { ...CONFIG, gem_serial: '1100604' } });
  assert.match(msg(ctx.gladys), /follows GEM 1100604 \(the serial number typed\)/);
  await ctx.gladys.fake.configUpdated({ ...CONFIG });
  await ctx.g.next(2);
  assert.equal(ctx.app.memory.serial, SERIAL);
  assert.equal(ctx.app.memory.typed, false);
  assert.doesNotMatch(msg(ctx.gladys), /refused/);
});

test('I1: a reset of a counter near its top stays a drop (not taken for a wrap)', async (t) => {
  const W40 = 2 ** 40;
  let reset = false;
  const shape = (s) => ({ absolute: [reset ? KWH : W40 - 1000 * KWH + (s - 1000) * 1000, 5] });
  const ctx = await running(t, { shape, gem: { format: 'BIN32_ABS' } });
  reset = true;
  await ctx.g.next(7);
  assert.match(msg(ctx.gladys), /channel 1: [\d.]+ → 1 kWh \(drop\)/);
});

test('I2: switching serials and back keeps the last value accepted (a lower value is a drop)', async (t) => {
  let off = 0;
  const shape = (s) => ({ absolute: [100 * KWH + (s - 1000) * 1000 + off, 5] });
  const ctx = await running(t, { shape });
  // A rise accepted after the last write of /data (written every 10 min only).
  off = 1 * KWH;
  await ctx.g.next(7);
  await ctx.flush();
  const top = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: '1100604' });
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: String(SERIAL) });
  // Back under the last value accepted, above the one /data had before.
  off = 0.3 * KWH;
  await ctx.g.next(7);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /channel 1: [\d.]+ → [\d.]+ kWh \(drop\)/);
  assert.ok(
    states(ctx.gladys, channelFeature(1, 'index')).every((v, i, a) => i === 0 || v >= a[i - 1]),
  );
  assert.ok(ctx.gladys.fake.lastState(channelFeature(1, 'index')) >= top);
});

// --- Review r2 -----------------------------------------------------------------------------

/** Channel 1 at `fromTop` kWh under 2^40 Ws, 1 kW, then what `after` gives. */
async function nearTop(t, fromTop, options = {}) {
  const W40 = 2 ** 40;
  const start = W40 - fromTop * KWH;
  const shape = (s) => ({ absolute: [start + (s - 1000) * 1000, 5] });
  const ctx = await running(t, { shape, gem: { format: 'BIN32_ABS' }, ...options });
  await ctx.flush();
  return { ctx, W40, shape };
}

test('r2 I1 (s9b): the GEM reset near the top of its counter, back in a new connection: a drop, held', async (t) => {
  const { ctx } = await nearTop(t, 1);
  const top = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  ctx.channel().emit('message', { type: 'session', state: 'down', session: 1, at: ctx.at() });
  await ctx.gemUp(2);
  const g = gem(ctx, (s) => ({ absolute: [0.01 * KWH + (s - 5) * 1000, 5] }), {
    start: 5,
    format: 'BIN32_ABS',
  });
  await g.next(8);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /channel 1: [\d.]+ → 0\.\d+ kWh \(drop\)/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v <= top + 0.01));
});

test('r2 I1 (s9c): silent 2 h, the GEM comes back reset: its seconds do not match, a drop, held', async (t) => {
  const { ctx } = await nearTop(t, 150);
  const top = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  await ctx.advance(2 * 60 * MINUTE);
  // Reset during the silence: running again for 30 min, its seconds start from 0.
  const g = gem(ctx, (s) => ({ absolute: [0.5 * KWH + s * 1000, 5] }), {
    start: 1800,
    format: 'BIN32_ABS',
  });
  await g.next(8);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /channel 1: [\d.]+ → [\d.]+ kWh \(drop\)/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v <= top + 0.01));
});

test('r2 I1 (s9d): a true wrap while nobody listened for 2 h is counted on (the GEM ran on)', async (t) => {
  const { ctx, W40, shape } = await nearTop(t, 1);
  await ctx.app.stop();
  const devices = ctx.gladys.devices;
  // Two hours later, the GEM counted 7200 s more and its counter wrapped.
  await ctx.advance(2 * 60 * MINUTE);
  const again = await setup(t, { store: ctx.store, clock: ctx.clock, gladysOptions: { devices } });
  await again.gemUp();
  const start = ctx.g.seconds + 7200;
  const g = gem(again, (s) => ({ absolute: [shape(s).absolute[0] % W40, 5] }), {
    start,
    format: 'BIN32_ABS',
  });
  await g.next(8);
  await again.flush();
  assert.doesNotMatch(msg(again.gladys), /held back/);
  assert.ok(again.gladys.fake.lastState(channelFeature(1, 'index')) > 305_419.9);
});

test('r2 m1 (s11): the link restarted while the GEM restarted: its packets are taken', async (t) => {
  const ctx = await running(t);
  await ctx.flush();
  ctx.channel().down();
  ctx.channel().up(null);
  // The new link numbers its sessions from 1 again; the GEM's seconds went back.
  await ctx.gemUp(1);
  const g = gem(ctx, steady, { start: 1010 });
  await g.next(3);
  await ctx.flush();
  assert.equal(status(ctx.gladys).connected, true);
  assert.match(msg(ctx.gladys), /The GEM restarted/);
});

test('r2 F3: a serial changed while Gladys is read never builds its guards on the old GEM', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  await ctx.gemUp();
  const g = gem(ctx, steady);
  await g.next(2);
  await ctx.createAll();
  let release;
  let calls = 0;
  const original = ctx.gladys.getDevices.bind(ctx.gladys);
  t.mock.method(ctx.gladys, 'getDevices', async () => {
    calls += 1;
    await new Promise((resolve) => (release = resolve));
    return original();
  });
  // Within the 5 s the read may take: packets a second apart.
  const at = g.seconds;
  await ctx.send(buildPacket({ seconds: at, ...steady(at) }));
  assert.equal(calls, 1);
  // F4: the counters asked again meanwhile (a device changed): one read at a time.
  await ctx.gladys.fake.deviceUpdated(ctx.gladys.devices[0]);
  await ctx.advance(SECOND);
  await ctx.send(buildPacket({ seconds: at + 1, ...steady(at + 1) }));
  assert.equal(calls, 1, 'one check of the counters at a time');
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: '2200001' });
  release();
  await settle(20);
  await ctx.app.saveMemory();
  assert.deepEqual(unitIn(store, 2_200_001).guards, {});
  assert.equal(ctx.app.guards.size, 0);
});

test('r2 K3/K4: typing the serial already followed marks it typed; 8 serials kept, the oldest dropped', async (t) => {
  const store = memoryStore();
  const ctx = await running(t, { store });
  assert.equal(ctx.app.memory.typed, false);
  await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: String(SERIAL) });
  assert.equal(ctx.app.memory.typed, true);
  assert.equal(store.data.typed, true);
  for (let i = 1; i <= 9; i += 1) {
    await ctx.gladys.fake.configUpdated({ ...CONFIG, gem_serial: String(3_000_000 + i) });
  }
  await ctx.app.saveMemory();
  assert.equal(ctx.app.memory.serials.size, 8, 'bounded in memory too');
  const kept = store.data.serials.map((u) => u.serial);
  assert.equal(kept.length, 8);
  assert.equal(kept.at(-1), 3_000_009, 'the one followed is the most recent');
  assert.ok(!kept.includes(SERIAL) && !kept.includes(3_000_001), 'the oldest dropped');
  assert.ok(JSON.stringify(store.data).length < 256 * 1024);
});

// --- Review r3: the wrap rule pinned (mutants X3, X4, X5, X12) ------------------------------

/**
 * The reviewer's s13a: the GEM restarted 5 min before the module stops (its
 * seconds near 300), 50 kWh under the top of its counter; the module is away
 * 2 h; the GEM is reset `resetAgo` seconds before the module comes back. Its
 * seconds count `resetAgo - 280` against ~7200 elapsed: not a GEM that ran on.
 */
async function resetDuringAbsence(t, resetAgo) {
  const W40 = 2 ** 40;
  const start = W40 - 50 * KWH;
  const shape = (s) => ({ absolute: [start + (s - 190) * 1000, 5] });
  const ctx = await running(t, { shape, gem: { format: 'BIN32_ABS', start: 190 } });
  await ctx.flush();
  const top = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  assert.ok(top > 305_369 && top < 305_370);
  await ctx.app.stop();
  assert.equal(unitIn(ctx.store, SERIAL).gem.seconds, 270, 'the last GEM seconds kept in /data');
  const devices = ctx.gladys.devices;
  await ctx.advance(2 * 60 * MINUTE);
  const again = await setup(t, { store: ctx.store, clock: ctx.clock, gladysOptions: { devices } });
  await again.gemUp();
  const g = gem(again, (s) => ({ absolute: [0.01 * KWH + (s - resetAgo) * 1000, 5] }), {
    start: resetAgo,
    format: 'BIN32_ABS',
  });
  await g.next(8);
  await again.flush();
  assert.match(msg(again.gladys), /channel 1: [\d.]+ → 0\.\d+ kWh \(drop\)/);
  assert.ok(states(again.gladys, channelFeature(1, 'index')).every((v) => v <= top + 0.01));
  assert.ok(!again.logs.some((l) => /wrapped around/.test(l)), 'never taken for a wrap');
}

test('r3 X4 (s13a): the GEM reset 1 h before the module comes back from 2 h away: 3330 s counted against 7200 s, a drop, held', async (t) => {
  // Off by ~3880 s: over 5 % of 2 h (360 s) and 2 min, under 50 % and 2 h.
  await resetDuringAbsence(t, 3600);
});

test('r3 X3 (s13a2): the GEM reset 1.5 h before the module comes back from 2 h away: 5130 s counted against 7200 s, a drop, held', async (t) => {
  // Off by ~2080 s: over 5 % of 2 h (360 s), under 50 % (3600 s).
  await resetDuringAbsence(t, 5400);
});

test('r3 X5 (s13b): the GEM rebooted (counters kept), then a true wrap: counted on, never held', async (t) => {
  const W40 = 2 ** 40;
  const shape = (s) => ({ absolute: [W40 - 0.05 * KWH + (s - 1000) * 1000, 5] });
  const ctx = await running(t, { shape, gem: { format: 'BIN32_ABS' } });
  await ctx.flush();
  const top = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  // The GEM reboots: a new connection, its seconds from 5, its counters kept
  // (55 000 Ws under the top): it wraps at the 7th packet.
  ctx.channel().emit('message', { type: 'session', state: 'down', session: 1, at: ctx.at() });
  await ctx.advance(30 * SECOND);
  await ctx.gemUp(2);
  const g = gem(ctx, (s) => ({ absolute: [(W40 - 55_000 + (s - 5) * 1000) % W40, 5] }), {
    start: 5,
    format: 'BIN32_ABS',
  });
  await g.next(14);
  await ctx.flush();
  assert.ok(ctx.logs.some((l) => /GEM counter abs-1 wrapped around/.test(l)));
  assert.doesNotMatch(msg(ctx.gladys), /held back/);
  const index = states(ctx.gladys, channelFeature(1, 'index'));
  assert.ok(index.at(-1) > 305_419.9, `counted on past the top: ${index.at(-1)}`);
  assert.ok(index.every((v, i, a) => i === 0 || v >= a[i - 1]) && index.at(-1) > top);
  // The GEM seconds of the LAST packet are the base of the next step.
  assert.equal(ctx.app.unit().gem.seconds, 135, 'the GEM seconds of the last packet');
});

test('r3 X12 (s13d): seconds going on, the raw counter falls from 1 kWh under the top to 0.5 kWh in 10 s: a drop, held', async (t) => {
  const W40 = 2 ** 40;
  let fallen;
  // 1.48 kWh through the top in 10 s: over the wrap margin of 10 s (0.78 kWh),
  // under the guard's margin of a minute (2.17 kWh).
  const shape = (s) => ({
    absolute: [
      fallen === undefined ? W40 - KWH + (s - 1000) * 1000 : 0.5 * KWH + (s - fallen) * 1000,
      5,
    ],
  });
  const ctx = await running(t, { shape, gem: { format: 'BIN32_ABS' } });
  const top = ctx.gladys.fake.lastState(channelFeature(1, 'index'));
  fallen = ctx.g.seconds;
  await ctx.g.next(8);
  await ctx.flush();
  assert.match(msg(ctx.gladys), /channel 1: [\d.]+ → 0\.5\d* kWh \(drop\)/);
  assert.ok(states(ctx.gladys, channelFeature(1, 'index')).every((v) => v <= top + 0.01));
  assert.ok(!ctx.logs.some((l) => /wrapped around/.test(l)), 'never taken for a wrap');
});
