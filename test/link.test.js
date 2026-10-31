// -----------------------------------------------------------------------------
// The link service on loopback with real sockets: the fake GEM connects like
// the real one, a real channel client plays the main container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect, createServer } from 'node:net';
import { ChannelClient } from '../src/channel.js';
import { startLinkService } from '../src/link/service.js';
import { buildPacket, capture, fakeGem } from './fixtures/gem.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const TOKEN = 't'.repeat(43);

const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function start(t, env = {}, options = {}) {
  const link = await startLinkService({
    env: { CHANNEL_TOKEN: TOKEN, GEM_PORT: '0', CHANNEL_PORT: '0', ...env },
    logger: quiet,
    ...options,
  });
  t.after(() => link.stop());
  const client = new ChannelClient({
    host: '127.0.0.1',
    port: link.channel.port,
    token: options.clientToken ?? TOKEN,
    logger: quiet,
    delays: [20],
  });
  const messages = [];
  client.on('message', (m) => messages.push(m));
  client.start();
  t.after(() => client.stop());
  if (!options.clientToken) await until(() => client.connected);
  return { link, client, messages };
}

test('packets cut and glued reach the main container whole, in order; nothing is written to the GEM', async (t) => {
  const { link, messages } = await start(t, { GEM_ADDRESS: '127.0.0.1' });
  const gem = await fakeGem(link.port);
  t.after(() => gem.close());
  const stream = Buffer.concat([
    Buffer.from('noise'),
    capture('BIN32-NET'),
    capture('BIN48-NET-TIME_tricky'),
    buildPacket({ seconds: 42 }),
  ]);
  for (let i = 0; i < stream.length; i += 100) {
    gem.send(stream.subarray(i, i + 100));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await until(() => messages.filter((m) => m.type === 'packet').length === 3);
  const packets = messages.filter((m) => m.type === 'packet');
  assert.deepEqual(
    packets.map((m) => m.hex.length / 2),
    [429, 625, 429],
  );
  assert.equal(packets[0].hex, capture('BIN32-NET').toString('hex'));
  assert.ok(packets.every((m) => m.session === 1 && !Number.isNaN(Date.parse(m.at))));
  assert.equal(messages[0].type, 'session');
  assert.equal(messages[0].from, '127.0.0.1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(gem.bytes.length, 0, 'the link never writes to the GEM');
});

test('the sender checked: another address is closed before a byte is read, and told', async (t) => {
  const { link, messages } = await start(t, { GEM_ADDRESS: '192.168.1.70' });
  const gem = await fakeGem(link.port);
  gem.send(buildPacket());
  await until(() => gem.closed);
  await until(() => messages.some((m) => m.type === 'refused'));
  assert.equal(messages.find((m) => m.type === 'refused').from, '127.0.0.1');
  assert.ok(!messages.some((m) => m.type === 'packet'));
});

test('a new connection of the GEM replaces the old one; a fifth socket is closed at once', async (t) => {
  const { link, messages } = await start(t);
  const first = await fakeGem(link.port);
  const second = await fakeGem(link.port);
  await until(() => first.closed);
  await until(() =>
    messages.some((m) => m.type === 'session' && m.state === 'down' && m.reason === 'replaced'),
  );
  second.send(buildPacket());
  await until(() => messages.some((m) => m.type === 'packet' && m.session === 2));
  const extra = [];
  for (let i = 0; i < 4; i += 1) extra.push(await fakeGem(link.port));
  await until(() => extra.filter((s) => s.closed).length >= 1);
  for (const s of [second, ...extra]) s.close();
});

test('an incomplete packet left 5 s closes the session; junk is counted and bounded', async (t) => {
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100),
    clearTimeout: (id) => clearTimeout(id),
  };
  const { link, messages } = await start(t, {}, { timers });
  const gem = await fakeGem(link.port);
  const ecm = Buffer.from(buildPacket());
  ecm[2] = 3;
  gem.send(ecm);
  gem.send(buildPacket().subarray(0, 100));
  await until(() => gem.closed, 2000);
  assert.ok(messages.some((m) => m.type === 'session' && m.reason === 'incomplete packet'));
  assert.ok(messages.some((m) => m.type === 'junk' && m.ecm === 1));
  const junk = await fakeGem(link.port);
  for (let i = 0; i < 20 && !junk.closed; i += 1) {
    junk.send(Buffer.alloc(8192, 0x41));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await until(() => junk.closed);
  assert.ok(messages.some((m) => /not a GEM packet/.test(m.reason ?? '')));
});

test('a flood of packets closes the session', async (t) => {
  const { link, messages } = await start(t);
  const gem = await fakeGem(link.port);
  const one = buildPacket();
  gem.send(Buffer.concat(Array.from({ length: 60 }, () => one)));
  await until(() => gem.closed);
  await until(() => messages.some((m) => m.reason === 'too many packets'));
  assert.ok(messages.filter((m) => m.type === 'packet').length <= 40);
});

test('the channel: a client without the secret gets nothing; packets wait (bounded) for the right one', async (t) => {
  let tick = 0;
  // A clock that moves 20 s per read: the packet rate never trips here.
  const clock = () => (tick += 20_000);
  const { link, client, messages } = await start(t, {}, { clientToken: 'x'.repeat(43), clock });
  const gem = await fakeGem(link.port);
  t.after(() => gem.close());
  for (let batch = 0; batch < 4; batch += 1) {
    for (let i = 0; i < 30; i += 1) gem.send(buildPacket({ seconds: batch * 30 + i }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.connected, false);
  assert.equal(messages.length, 0);
  // A raw client that proves nothing is dropped.
  const raw = connect({ host: '127.0.0.1', port: link.channel.port });
  raw.on('error', () => {});
  raw.write('{"type":"hello","nonce":"00","proof":"00"}\n');
  await until(() => raw.destroyed || raw.readableEnded, 2000).catch(() => {});
  raw.destroy();
  const good = new ChannelClient({
    host: '127.0.0.1',
    port: link.channel.port,
    token: TOKEN,
    logger: quiet,
    delays: [20],
  });
  const got = [];
  let info;
  good.on('up', (i) => (info = i));
  good.on('message', (m) => got.push(m));
  good.start();
  t.after(() => good.stop());
  await until(() => good.connected);
  await until(() => got.length >= 100);
  assert.ok(got.length <= 100, 'the oldest dropped beyond 100');
  assert.ok(info.dropped > 0);
});

test('never more than 4 sockets open: a fifth is closed before it becomes a session', async (t) => {
  const { link, messages } = await start(t);
  // Sockets whose close event never comes (a peer gone silent): they stay counted.
  const sockets = Array.from({ length: 5 }, () => {
    const socket = new EventEmitter();
    socket.remoteAddress = '127.0.0.1';
    socket.destroyed = false;
    socket.destroy = () => (socket.destroyed = true);
    socket.setKeepAlive = () => {};
    return socket;
  });
  for (const socket of sockets) link.server.emit('connection', socket);
  await until(() => messages.filter((m) => m.type === 'session' && m.state === 'up').length === 4);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.filter((m) => m.type === 'session' && m.state === 'up').length, 4);
  assert.equal(sockets[4].destroyed, true);
});

test('L7: data of a replaced session is never read (the old socket closed at once)', async (t) => {
  const { link, messages } = await start(t);
  const fake = () => {
    const socket = new EventEmitter();
    socket.remoteAddress = '127.0.0.1';
    socket.destroyed = false;
    socket.destroy = () => (socket.destroyed = true);
    socket.setKeepAlive = () => {};
    return socket;
  };
  const first = fake();
  const second = fake();
  link.server.emit('connection', first);
  link.server.emit('connection', second);
  assert.equal(first.destroyed, true);
  // A late chunk of the replaced socket (already in the kernel buffer).
  first.emit('data', buildPacket({ seconds: 1 }));
  second.emit('data', buildPacket({ seconds: 2 }));
  await until(() => messages.some((m) => m.type === 'packet'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    messages.filter((m) => m.type === 'packet').map((m) => m.session),
    [2],
  );
});

test('L8: a GEM address that is not an IP refuses every connection', async (t) => {
  const { link, messages } = await start(t, { GEM_ADDRESS: 'not-an-ip' });
  const gem = await fakeGem(link.port);
  gem.send(buildPacket());
  await until(() => gem.closed);
  await until(() => messages.some((m) => m.type === 'refused'));
  assert.ok(!messages.some((m) => m.type === 'packet' || m.type === 'session'));
});

test('C2: the main container accepts nothing from a receiver that does not prove the secret', async (t) => {
  const open = new Set();
  const server = createServer((socket) => {
    open.add(socket);
    socket.write(`${JSON.stringify({ type: 'challenge', nonce: 'a'.repeat(32) })}\n`);
    socket.on('data', () => {
      socket.write(`${JSON.stringify({ type: 'ready', proof: 'f'.repeat(64) })}\n`);
      socket.write(`${JSON.stringify({ type: 'packet', session: 1, hex: 'feff' })}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    // Never waits on a connection left open (a broken client must fail, not hang).
    for (const socket of open) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const client = new ChannelClient({
    host: '127.0.0.1',
    port: server.address().port,
    token: TOKEN,
    logger: quiet,
    delays: [10_000],
  });
  let up = false;
  const got = [];
  client.on('up', () => (up = true));
  client.on('message', (m) => got.push(m));
  client.start();
  t.after(() => client.stop());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(up, false);
  assert.deepEqual(got, []);
});

test('C3: a receiver without a secret accepts no client, even one proving the empty secret', async (t) => {
  const { createChannelServer, proof } = await import('../src/channel.js');
  const server = createChannelServer({ port: 0, host: '127.0.0.1', token: '', logger: quiet });
  await server.start();
  t.after(() => server.stop());
  const raw = connect({ host: '127.0.0.1', port: server.port });
  raw.on('error', () => {});
  const lines = [];
  let buffer = '';
  raw.setEncoding('utf8');
  raw.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      if (lines.length === 1) {
        const nonce = 'b'.repeat(32);
        raw.write(
          `${JSON.stringify({ type: 'hello', nonce, proof: proof('', 'client', lines[0].nonce, nonce) })}\n`,
        );
      }
    }
  });
  await until(() => raw.destroyed || raw.readableEnded || lines.length > 1, 2000).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!lines.some((l) => l.type === 'ready'));
  assert.equal(server.connected, false);
  raw.destroy();
});

test('C4: a line longer than 64 KiB in one chunk drops the socket, never handed over', async () => {
  const { onJsonLines } = await import('../src/channel.js');
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.destroyed = false;
  socket.destroy = () => (socket.destroyed = true);
  const got = [];
  onJsonLines(socket, (o) => got.push(o));
  socket.emit('data', `${JSON.stringify({ type: 'x', pad: 'a'.repeat(70_000) })}\n`);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(got, []);
  const small = new EventEmitter();
  small.setEncoding = () => {};
  small.destroy = () => (small.destroyed = true);
  onJsonLines(small, (o) => got.push(o));
  small.emit('data', '{"type":"a"}\n{"type":"b"}\n');
  assert.deepEqual(
    got.map((o) => o.type),
    ['a', 'b'],
  );
});

test('the receiver stops at once, connections still in their handshake included', async () => {
  const { createChannelServer } = await import('../src/channel.js');
  const server = createChannelServer({ port: 0, host: '127.0.0.1', token: TOKEN, logger: quiet });
  await server.start();
  const raw = connect({ host: '127.0.0.1', port: server.port });
  raw.on('error', () => {});
  await new Promise((resolve) => raw.once('data', resolve));
  const stopped = await Promise.race([
    server.stop().then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('hanging'), 2000)),
  ]);
  raw.destroy();
  assert.equal(stopped, 'stopped');
});
