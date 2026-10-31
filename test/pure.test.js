// -----------------------------------------------------------------------------
// The pure parts: the packets against the reference's captures and expected
// values (siobrultech-protocols tests, MIT), the stream reader, the
// configuration, the guard, the conversions, /data read back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORMATS, PacketError, PacketReader, checksumOf, parsePacket } from '../src/gem/packets.js';
import { normalizeConfig, parseChannels, parseGemAddress, parseSerial } from '../src/config.js';
import { CounterGuard, marginOf } from '../src/guard.js';
import { GUARDS } from '../src/constants.js';
import { celsiusOf } from '../src/model.js';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';
import { buildPacket, capture, SERIAL } from './fixtures/gem.js';

const EXPECTED = JSON.parse(
  readFileSync(new URL('./fixtures/reference-values.json', import.meta.url), 'utf8'),
);
const FORMAT_OF_FILE = {
  'BIN32-ABS.bin': 'BIN32-ABS',
  'BIN32-NET.bin': 'BIN32-NET',
  'BIN48-ABS.bin': 'BIN48-ABS',
  'BIN48-NET.bin': 'BIN48-NET',
  'BIN48-NET-TIME.bin': 'BIN48-NET-TIME',
  'BIN48-NET-TIME_tricky.bin': 'BIN48-NET-TIME',
};

for (const [file, expected] of Object.entries(EXPECTED)) {
  test(`reference capture ${file}: every field as the reference reads it`, () => {
    const p = parsePacket(capture(file.replace('.bin', '')));
    assert.equal(p.format, FORMAT_OF_FILE[file]);
    assert.deepEqual(p.absolute, expected.absolute_watt_seconds);
    assert.deepEqual(p.polarized, expected.polarized_watt_seconds ?? null);
    assert.deepEqual(p.currents, expected.currents);
    assert.deepEqual(p.pulses, expected.pulse_counts);
    assert.deepEqual(p.temperatures, expected.temperatures);
    assert.equal(p.seconds, expected.seconds);
    assert.equal(p.voltage, expected.voltage);
    assert.equal(p.serial, expected.device_id * 100_000 + expected.serial_number);
    assert.equal(p.timeStamp, expected.time_stamp ?? null);
  });
}

test('the tricky BIN48-NET-TIME capture (checksum right at 619 bytes) is told by its footer', () => {
  const tricky = capture('BIN48-NET-TIME_tricky');
  assert.equal(parsePacket(tricky).format, 'BIN48-NET-TIME');
  assert.throws(() => parsePacket(tricky.subarray(0, FORMATS.BIN48_NET.size)), PacketError);
});

test('a BIN48-NET-TIME packet whose checksum matches at 619 bytes is still told by the footer', () => {
  let packet;
  for (let seconds = 0; seconds < 5000; seconds += 1) {
    const candidate = buildPacket({ format: 'BIN48_NET_TIME', seconds, absolute: [1234] });
    if (checksumOf(candidate, 619) === candidate[618]) {
      packet = candidate;
      break;
    }
  }
  assert.ok(packet, 'a tricky packet was built');
  assert.equal(parsePacket(packet).format, 'BIN48-NET-TIME');
  const reader = new PacketReader();
  assert.deepEqual(
    reader.push(packet).map((p) => p.length),
    [625],
  );
});

test('a packet with a wrong checksum, footer, size or code is refused; ECM too', () => {
  const good = buildPacket();
  const bad = Buffer.from(good);
  bad[10] ^= 1;
  assert.throws(() => parsePacket(bad), /checksum/);
  const footer = Buffer.from(good);
  footer[footer.length - 3] = 0;
  assert.throws(() => parsePacket(footer), PacketError);
  assert.throws(() => parsePacket(good.subarray(0, -1)), PacketError);
  assert.throws(() => parsePacket(Buffer.concat([good, Buffer.from([0])])), /size/);
  const code = Buffer.from(good);
  code[2] = 9;
  assert.throws(() => parsePacket(code), /unknown/);
  const ecm = Buffer.from(good);
  ecm[2] = 3;
  assert.throws(() => parsePacket(ecm), /ECM/);
  assert.throws(() => parsePacket(Buffer.from([0xfe])), PacketError);
});

test('the test builder writes what the parser reads (every format, negative temperature)', () => {
  for (const format of Object.keys(FORMATS)) {
    const p = parsePacket(
      buildPacket({
        format,
        absolute: [2 ** 40 - 1, 7],
        polarized: [5],
        currents: [12.34],
        seconds: 2 ** 24 - 1,
        pulses: [1, 2, 3, 2 ** 24 - 1],
        temperatures: [-10.5, 21, null, 0, 255, -0.5, 100, 1],
      }),
    );
    assert.equal(p.format, FORMATS[format].name);
    assert.equal(p.serial, SERIAL);
    assert.equal(p.absolute[0], 2 ** 40 - 1);
    assert.equal(p.polarized?.[0] ?? 5, 5);
    assert.equal(p.currents[0], 12.34);
    assert.deepEqual(p.temperatures, [-10.5, 21, null, 0, 255, -0.5, 100, 1]);
  }
});

test('the reader: packets cut anywhere, glued, junk and malformed skipped, ECM counted, bounded', () => {
  const a = capture('BIN48-NET-TIME_tricky');
  const b = capture('BIN32-NET');
  const broken = Buffer.from(buildPacket());
  broken[20] ^= 0xff;
  const ecm = Buffer.from(buildPacket());
  ecm[2] = 3;
  const stream = Buffer.concat([
    Buffer.from('hello'),
    a,
    Buffer.from([0xfe, 0x00, 0xfe]),
    broken,
    b,
    ecm,
    Buffer.from([0xfe, 0xff, 0x63]),
    capture('BIN48-NET'),
    capture('BIN48-NET-TIME'),
  ]);
  for (const size of [1, 7, 619, 5000]) {
    const reader = new PacketReader();
    const got = [];
    for (let i = 0; i < stream.length; i += size)
      got.push(...reader.push(stream.subarray(i, i + size)));
    assert.deepEqual(
      got.map((p) => parsePacket(p).format),
      ['BIN48-NET-TIME', 'BIN32-NET', 'BIN48-NET', 'BIN48-NET-TIME'],
      `chunks of ${size}`,
    );
    assert.ok(reader.malformed >= 2, 'the broken packet and the unknown code');
    assert.equal(reader.ecm, 1);
    assert.equal(reader.buffered, 0);
  }
  // Megabytes in one chunk: never more than two packets' worth held at once.
  class Peak extends PacketReader {
    drain(packets) {
      this.peak = Math.max(this.peak ?? 0, this.buffer.length);
      super.drain(packets);
    }
  }
  const peak = new Peak();
  peak.push(Buffer.concat([Buffer.alloc(100_000, 0x41), capture('BIN32-NET')]));
  assert.ok(peak.peak <= 1250, String(peak.peak));
  // Megabytes of junk: never more than two packets' worth kept.
  const reader = new PacketReader();
  for (let i = 0; i < 100; i += 1) {
    reader.push(Buffer.alloc(10_000, 0x41));
    assert.ok(reader.buffered <= 1250);
  }
  const header = new PacketReader();
  header.push(Buffer.concat([Buffer.from([0xfe, 0xff, 7]), Buffer.alloc(20_000, 0)]));
  assert.ok(header.buffered <= 1250);
});

test('the address of the GEM: an IP of a machine only', () => {
  assert.deepEqual(parseGemAddress(' 192.168.1.70 '), { host: '192.168.1.70' });
  assert.deepEqual(parseGemAddress('[fe80::1]'), { host: 'fe80::1' });
  for (const bad of [
    'gem.local',
    '0.0.0.0',
    '::',
    '255.255.255.255',
    '239.1.1.1',
    'ff02::1',
    '1.2.3.4:80',
  ]) {
    assert.deepEqual(parseGemAddress(bad), { error: 'invalid' }, bad);
  }
  assert.deepEqual(parseGemAddress(''), { error: 'empty' });
  assert.deepEqual(parseGemAddress(undefined), { error: 'empty' });
});

test('the serial and the channels typed', () => {
  assert.equal(parseSerial(''), null);
  assert.equal(parseSerial('01100603'), 1100603);
  assert.equal(parseSerial(1100603), 1100603);
  for (const bad of ['abc', '123456789', '0', '99999999', '1.5', ' 1 2']) {
    assert.equal(parseSerial(bad), 'invalid', bad);
  }
  assert.deepEqual([...parseChannels('1-3, 15,48')], [1, 2, 3, 15, 48]);
  assert.equal(parseChannels(''), null);
  for (const bad of ['0', '49', '3-1', 'a', '1--2', ',', '1-48'.repeat(20)]) {
    assert.equal(parseChannels(bad), 'invalid', bad);
  }
  const config = normalizeConfig({ gem_address: '10.0.0.2', gem_serial: 'x', channels: '99' });
  assert.equal(config.serial, null);
  assert.equal(config.serialInvalid, true);
  assert.equal(config.channels, null);
  assert.equal(config.channelsInvalid, true);
  assert.equal(config.temperatureUnit, 'off');
  assert.equal(normalizeConfig({ check_source: 'nope' }).checkSource, true);
  assert.equal(normalizeConfig({ check_source: false }).checkSource, false);
  assert.equal(normalizeConfig({ temperature_unit: 'kelvin' }).temperatureUnit, 'off');
});

test('temperatures: °F converted exactly, bounds checked after the conversion, 0 and null not values', () => {
  assert.equal(celsiusOf(212, 'fahrenheit'), 100);
  assert.equal(celsiusOf(98.5, 'fahrenheit'), 36.94);
  assert.equal(celsiusOf(-40, 'fahrenheit'), -40);
  assert.equal(celsiusOf(32.5, 'fahrenheit'), 0.28);
  assert.equal(celsiusOf(21.5, 'celsius'), 21.5);
  assert.equal(celsiusOf(255, 'fahrenheit'), 123.89);
  assert.equal(celsiusOf(255, 'celsius'), undefined, '255 °C is out of the sensor range');
  assert.equal(celsiusOf(-67.5, 'fahrenheit'), undefined, '-55.3 °C');
  assert.equal(celsiusOf(0, 'celsius'), undefined);
  assert.equal(celsiusOf(null, 'celsius'), undefined);
  assert.equal(celsiusOf(20, 'off'), undefined);
});

const H = 3_600_000;

test('the guard: never 0, a jump and a drop held, never taken by time nor repetition', () => {
  const g = new CounterGuard(GUARDS.energy, undefined, undefined, 0);
  assert.equal(g.accept(0, 0), false);
  assert.equal(g.accept(-1, 0), false);
  assert.equal(g.accept(100, 0), true);
  assert.equal(g.accept(100.5, H / 60), true);
  // 100 kWh/h + 0.5: 1000 kWh more within a minute is a jump.
  assert.equal(g.accept(1100, H / 30), false);
  assert.equal(g.held.direction, 'up');
  for (let i = 1; i <= 50; i += 1) assert.equal(g.accept(1100 + i, H / 30 + i * H), false);
  assert.equal(g.last.value, 100.5);
  // A drop.
  const d = new CounterGuard(GUARDS.energy, { value: 500, at: 0 }, undefined, 0);
  assert.equal(d.accept(1, H), false);
  assert.equal(d.held.direction, 'down');
  for (let i = 2; i < 30; i += 1) assert.equal(d.accept(i, i * H), false);
  // Accepted by the user: taken, and bounded.
  assert.deepEqual(d.acceptHeld(), { direction: 'down', from: 500, to: 29 });
  assert.equal(d.accept(29.1, 30 * H), true);
  assert.equal(d.accept(20, 31 * H), false, 'never under the floor accepted');
  assert.equal(marginOf(GUARDS.pulses, 0, H), 360_100);
});

test('the guard: /data and Gladys, the oldest date of an equal value, a hold kept', () => {
  const g = new CounterGuard(
    GUARDS.energy,
    { value: 10, at: 5000 },
    {
      last: { value: 10, at: 1000 },
      held: { direction: 'up', from: 10, to: 900, threshold: 900, at: 2000 },
    },
    7000,
  );
  assert.deepEqual(g.last, { value: 10, at: 1000 });
  assert.equal(g.held.at, 7000, 'the hold dated at its load');
  assert.equal(g.accept(950, 8000), false);
  const newer = new CounterGuard(
    GUARDS.energy,
    { value: 12, at: 5000 },
    { last: { value: 10, at: 1000 } },
    7000,
  );
  assert.deepEqual(newer.last, { value: 12, at: 5000 });
});

test('/data read back: bounded, known keys only, future dates now, per serial', () => {
  const memory = normalizeMemory(
    {
      token: 'a'.repeat(43),
      serial: 1100603,
      typed: true,
      format: 'BIN48-NET',
      serials: [
        { serial: 99_999_999, seen: { channels: [1] } },
        'abc',
        {
          serial: 2_200_001,
          gem: { seconds: 2 ** 24, at: 5 },
        },
        {
          serial: 1100603,
          gem: { seconds: 77, at: 9e15 },
          seen: {
            channels: [1, 2, 99, 'x'],
            temps: [8, 9],
            pulses: [1],
            produced: [3],
            __proto__: [1],
          },
          guards: {
            ch1: { last: { value: 12.5, at: 9e15 }, held: null },
            'ch2-prod': {
              last: { value: 1, at: 10 },
              held: { direction: 'up', from: 1, to: 9, threshold: 9, at: 2e15 },
            },
            ch49: { last: { value: 1, at: 1 } },
            'pulse-3': { last: { value: 0, at: 1 } },
            constructor: { last: { value: 1, at: 1 } },
          },
          wraps: {
            'abs-1': { raw: 5, offset: 2 ** 40, at: 9e15 },
            'pol-49': { raw: 5, offset: 0, at: 1 },
            'pulse-2': { raw: -1, offset: 0, at: 1 },
            'abs-2': { raw: 1.5, offset: 0, at: 1 },
          },
        },
      ],
    },
    1000,
  );
  assert.equal(memory.typed, true);
  assert.deepEqual([...memory.serials.keys()], [2_200_001, 1100603], 'the order of the list kept');
  assert.equal(memory.serials.get(2_200_001).gem, undefined, 'seconds out of range');
  assert.deepEqual(memory.serials.get(1100603).gem, { seconds: 77, at: 1000 });
  const unit = memory.serials.get(1100603);
  assert.deepEqual([...unit.seen.channels], [1, 2]);
  assert.deepEqual([...unit.seen.temps], [8]);
  assert.deepEqual(Object.keys(unit.guards), ['ch1', 'ch2-prod']);
  assert.equal(unit.guards.ch1.last.at, 1000);
  assert.equal(unit.guards['ch2-prod'].held.to, 9);
  assert.equal(unit.guards['ch2-prod'].held.at, 1000, 'a hold dated in the future is now');
  assert.deepEqual(Object.keys(unit.wraps), ['abs-1']);
  assert.deepEqual(unit.wraps['abs-1'], { raw: 5, offset: 2 ** 40 });
  const round = normalizeMemory(JSON.parse(JSON.stringify(serializeMemory(memory))), 1000);
  assert.deepEqual(serializeMemory(round), serializeMemory(memory));
  assert.equal(normalizeMemory({ serial: 99_999_999 }, 1).serial, undefined);
  assert.equal(normalizeMemory({ serial: 5, typed: 'yes' }, 1).typed, false);
  const twice = normalizeMemory({ serials: [{ serial: 11 }, { serial: 22 }, { serial: 11 }] }, 1);
  assert.deepEqual(
    [...twice.serials.keys()],
    [22, 11],
    'a serial listed twice is as recent as its last place',
  );
});

test('the file store: missing is empty, a FIFO and a directory refused without waiting, too large refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'greeneye-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await fileStore(join(dir, 'none.json')).load(), null);
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(fileStore(fifo).load(), { code: 'not_file' });
  await assert.rejects(fileStore(dir).load(), (err) => typeof err.code === 'string');
  const big = join(dir, 'big.json');
  await writeFile(big, 'x'.repeat(300 * 1024));
  await assert.rejects(fileStore(big).load(), { code: 'too_large' });
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{oops');
  await assert.rejects(fileStore(bad).load(), { code: 'not_json' });
  const good = fileStore(join(dir, 'good.json'));
  await Promise.all([good.save({ a: 1 }), good.save({ a: 2 })]);
  assert.deepEqual(await good.load(), { a: 2 });
});

test('the guard: a held jump is never taken by time, even with readings an hour apart', () => {
  const g = new CounterGuard(GUARDS.energy, { value: 100, at: 0 }, undefined, 0);
  assert.equal(g.accept(100.5, H / 60), true);
  // 50 kWh within a minute: held.
  assert.equal(g.accept(150.5, H / 30), false);
  // The same value an hour later, then every hour: still held (its margin since the hold is large).
  for (let i = 1; i <= 24; i += 1) assert.equal(g.accept(150.5 + i * 0.01, H / 30 + i * H), false);
  assert.equal(g.last.value, 100.5);
});

test('the guard: under a held jump, a value must fit the short margin since the hold', () => {
  // The last value accepted an hour ago: its own margin is 100.5 kWh.
  const g = new CounterGuard(GUARDS.energy, { value: 100, at: 0 }, undefined, 0);
  assert.equal(g.accept(400, H), false, '300 kWh in an hour: held');
  // A minute later, 150 (under the hold): within the hour's margin, not within a minute's.
  assert.equal(g.accept(150, H + H / 60), false);
  assert.equal(g.held.to, 150);
  assert.equal(g.last.value, 100);
});

test('the guard: an accepted drop is a floor until a value is taken', () => {
  const g = new CounterGuard(GUARDS.energy, { value: 500, at: 0 }, undefined, 0);
  assert.equal(g.accept(10, H), false);
  g.acceptHeld();
  assert.equal(g.accept(5, H + 1000), false, 'under the floor accepted');
  assert.equal(g.held.direction, 'down');
  assert.equal(g.accept(10.1, H + 2000), true);
});

test('the file store: a temporary file left by a crash never blocks the next saves', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'greeneye-tmp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(`${path}.tmp`, 'half a write');
  const store = fileStore(path);
  await store.save({ a: 1 });
  await store.save({ a: 2 });
  assert.deepEqual(await store.load(), { a: 2 });
});
