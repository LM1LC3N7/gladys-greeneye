// -----------------------------------------------------------------------------
// The service of the `gem-link` sub-container: the TCP port the GreenEye
// Monitor connects to (in its "Packet Send" settings the GEM is a client: it
// opens the connection towards the address and port typed there), and the
// channel that hands its packets to the main container. The main container
// cannot publish a port; this container does (Gladys picks the host port).
// Taken from LM1LC3N7/gladys-wolf-ism8 (same author, Apache-2.0, approved).
//
// Nothing is ever sent to the GEM: the link only reads. The settings API of
// the GEM (the reference library asks it on the same connection) is never
// used, so nothing can change a setting of the monitor.
//
// Bounded for a 64 MB container:
//   - 4 open connections at most; a fifth is closed at once;
//   - when the sender is checked (GEM_ADDRESS), a connection from any other
//     address is closed before a byte is read, and the main container is told
//     (at most every 10 s, the address only);
//   - one GEM session at a time: a new connection of the GEM replaces the
//     previous one (the GEM reconnects after a network cut while the old
//     socket may still look open), never two sessions side by side;
//   - packets of 625 bytes at most, framed (header, code, footer, checksum,
//     src/gem/packets.js); junk and malformed packets are skipped up to the
//     next header, as the reference does, but 64 KiB skipped in a session
//     closes it; a packet left incomplete for 5 s closes it too;
//   - 40 packets per 10 s at most (the GEM sends one every 1 to 255 s); over
//     that the connection is closed;
//   - 100 packets kept while the main container is away (the oldest dropped);
//     the main container drops those older than a minute anyway.
//
// Packets are handed over as hex, undecoded: decoding is the main
// container's job.
//
// Environment, set by the main container through startContainer:
//   CHANNEL_TOKEN  the secret the main container says hello with
//   GEM_PORT       8000 (published by Gladys on a host port of its choice)
//   CHANNEL_PORT   7779 (private network only)
//   GEM_ADDRESS    the IP address of the GEM, when the sender is checked
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createChannelServer } from '../channel.js';
import { normalizeIp } from '../config.js';
import { LINK, LIMITS } from '../constants.js';
import { PacketReader } from '../gem/packets.js';

/**
 * @returns {Promise<{ server, channel, stop(): Promise, port: number, session(): object|undefined }>}
 */
export async function startLinkService({
  env = process.env,
  logger,
  now = Date.now,
  clock = () => performance.now(),
  timers = globalThis,
} = {}) {
  const expected = env.GEM_ADDRESS ? normalizeIp(env.GEM_ADDRESS) : null;
  if (env.GEM_ADDRESS && !expected) {
    logger?.warn('GEM_ADDRESS is not an IP address: every connection is refused');
  }
  const checked = Boolean(env.GEM_ADDRESS);
  const sockets = new Set();
  let session;
  let sessions = 0;
  let lastRefusedNotice = -Infinity;
  let refusedSince = 0;

  const at = () => new Date(now()).toISOString();

  const channel = createChannelServer({
    port: Number(env.CHANNEL_PORT ?? LINK.channelPort),
    token: env.CHANNEL_TOKEN,
    logger,
    queueSize: LIMITS.linkQueue,
    hello: () => ({
      session: session ? { id: session.id, from: session.from, since: session.since } : null,
    }),
    // The main container has nothing to ask: the link never writes to the GEM.
    onMessage: () => {},
  });

  function notifyRefused(from) {
    refusedSince += 1;
    const mono = clock();
    if (mono - lastRefusedNotice >= LIMITS.refusedNoticeEvery) {
      lastRefusedNotice = mono;
      channel.send({ type: 'refused', from, count: refusedSince, at: at() });
      refusedSince = 0;
    }
  }

  function endSession(current, reason) {
    if (session !== current) return;
    session = undefined;
    timers.clearTimeout(current.stallTimer);
    channel.send({ type: 'session', state: 'down', session: current.id, reason, at: at() });
  }

  /** Junk, malformed or ECM packets of the session: told once per 10 s at most, when they grew. */
  function notifyJunk(current) {
    const { skipped, malformed, ecm } = current.reader;
    const key = `${skipped}/${malformed}/${ecm}`;
    if (key === current.junkKey) return;
    const mono = clock();
    if (mono - current.junkAt < LIMITS.refusedNoticeEvery) return;
    current.junkAt = mono;
    current.junkKey = key;
    channel.send({ type: 'junk', session: current.id, skipped, malformed, ecm, at: at() });
  }

  function onConnection(socket) {
    socket.on('error', () => {});
    if (sockets.size >= LIMITS.linkSockets) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const from = normalizeIp(socket.remoteAddress);
    if (checked && (!expected || from !== expected)) {
      socket.destroy();
      notifyRefused(from ?? 'unknown');
      return;
    }
    if (session) {
      // The GEM came back: the previous socket is closed, never kept beside.
      const previous = session;
      endSession(previous, 'replaced');
      previous.socket.destroy();
    }
    sessions += 1;
    const current = {
      id: sessions,
      from: from ?? 'unknown',
      since: at(),
      socket,
      reader: new PacketReader(),
      packets: [],
      stallTimer: undefined,
      junkAt: -Infinity,
      junkKey: '0/0/0',
    };
    session = current;
    socket.setKeepAlive(true, 60_000);
    logger?.info(`GEM connected from ${current.from} (session ${current.id})`);
    channel.send({
      type: 'session',
      state: 'up',
      session: current.id,
      from: current.from,
      at: current.since,
    });

    const drop = (reason) => {
      logger?.warn(`GEM connection closed: ${reason}`);
      notifyJunk(current);
      endSession(current, reason);
      socket.destroy();
    };

    socket.on('data', (chunk) => {
      if (session !== current) {
        socket.destroy();
        return;
      }
      const packets = current.reader.push(chunk);
      const mono = clock();
      for (const packet of packets) {
        while (current.packets.length > 0 && mono - current.packets[0] >= LIMITS.packetsWindow) {
          current.packets.shift();
        }
        current.packets.push(mono);
        if (current.packets.length > LIMITS.packets) {
          drop('too many packets');
          return;
        }
        channel.send({
          type: 'packet',
          session: current.id,
          at: at(),
          hex: packet.toString('hex'),
        });
      }
      if (current.reader.skipped > LIMITS.skippedBytes) {
        drop('too much data that is not a GEM packet');
        return;
      }
      notifyJunk(current);
      timers.clearTimeout(current.stallTimer);
      current.stallTimer = undefined;
      if (current.reader.buffered > 0) {
        current.stallTimer = timers.setTimeout(() => drop('incomplete packet'), LIMITS.packetStall);
      }
    });
    socket.on('close', () => {
      timers.clearTimeout(current.stallTimer);
      if (session === current) {
        logger?.info(`GEM disconnected (session ${current.id})`);
        endSession(current, 'closed');
      }
    });
  }

  await channel.start();
  const server = createServer(onConnection);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(env.GEM_PORT ?? LINK.gemPort), '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await channel.stop();
    throw err;
  }
  logger?.info(
    `Waiting for the GEM on port ${server.address().port}${checked ? ` (from ${expected ?? 'nobody'} only)` : ''}`,
  );

  return {
    server,
    channel,
    get port() {
      return server.address()?.port;
    },
    session: () => session,
    stop() {
      for (const socket of sockets) socket.destroy();
      return Promise.all([
        new Promise((resolve) => server.close(() => resolve())),
        channel.stop(),
      ]).then(() => undefined);
    },
  };
}
