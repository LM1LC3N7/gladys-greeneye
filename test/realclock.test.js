// -----------------------------------------------------------------------------
// End to end on a REAL clock sped up 20 times (testkit realClock): the real
// link service on loopback, the real channel, the app on the SDK's fake
// Gladys, and a fake GEM that connects like the real one and sends a packet
// every 5 s (simulated), as its "Packet Send" does. Everything is stopped in
// a `finally`: a failure never leaves the test process alive.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';
import { GreenEyeApp } from '../src/app.js';
import { ChannelClient } from '../src/channel.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { startLinkService } from '../src/link/service.js';
import { memoryStore } from '../src/store.js';
import { KWH, buildPacket, channelFeature, fakeGem, linkContainer } from './fixtures/gem.js';

const quiet = process.env.DEBUG_TEST
  ? { debug: console.log, info: console.log, warn: console.log, error: console.log }
  : { debug() {}, info() {}, warn() {}, error() {} };
const until = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('real clock x20: packets every 5 s, power and index published, the rounds at their period', async () => {
  const clock = realClock({ speed: 20 });
  const token = 'e'.repeat(43);
  const store = memoryStore({ token });
  let link;
  let app;
  let gem;
  let sender;
  try {
    link = await startLinkService({
      env: { CHANNEL_TOKEN: token, GEM_PORT: '0', CHANNEL_PORT: '0', GEM_ADDRESS: '127.0.0.1' },
      logger: quiet,
      now: clock.now,
      clock: clock.monotonic,
      timers: clock.timers,
    });
    const gladys = createFakeGladys({
      config: { gem_address: '127.0.0.1' },
      containers: [linkContainer()],
    });
    app = new GreenEyeApp({
      gladys,
      logger: quiet,
      store,
      now: clock.now,
      clock: clock.monotonic,
      timers: clock.timers,
      createChannel: (options) =>
        new ChannelClient({ ...options, host: '127.0.0.1', port: link.channel.port, delays: [20] }),
    });
    await app.boot();
    registerHandlers(gladys, app);
    await gladys.connect();
    await until(() => app.channel?.connected);

    gem = await fakeGem(link.port);
    // 2 kW on channel 1, a packet every 5 s (simulated).
    let seconds = 5000;
    const send = () => {
      gem.send(
        buildPacket({ seconds, absolute: [50 * KWH + (seconds - 5000) * 2000], currents: [8.5] }),
      );
      seconds += 5;
    };
    send();
    sender = clock.timers.setInterval(send, 5000);
    await until(() => gladys.fake.discoveredDevices?.length === 2);
    for (const device of gladys.fake.discoveredDevices) await gladys.fake.deviceCreated(device);

    await until(() => gladys.fake.lastState(channelFeature(1, 'power', 1100603)) === 2000);
    await until(() => gladys.fake.lastState(channelFeature(1, 'index', 1100603)) > 50);
    assert.equal(gladys.fake.lastState(channelFeature(1, 'current', 1100603)), 8.5);
    assert.equal(gladys.fake.connectionStatus.connected, true);

    // The background round: every 10 s (0.5 s real), never faster.
    const tick = spyOn(app, 'tick', clock);
    await measurePeriod(tick, { count: 4, period: TIMINGS.tick });
    tick.restore();
    // The counters: once a minute (3 s real), however often the packets come.
    const counters = spyOn(app, 'publishCounters', clock);
    await measurePeriod(counters, { count: 3, period: TIMINGS.indexInterval });
    counters.restore();
    assert.equal(gem.bytes.length, 0, 'nothing ever sent to the GEM');
  } finally {
    if (sender) clock.timers.clearInterval(sender);
    gem?.close();
    await app?.stop();
    await link?.stop();
    clock.close();
  }
});
