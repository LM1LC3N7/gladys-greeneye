// -----------------------------------------------------------------------------
// The binary packets a GreenEye Monitor (GEM) sends, as described by the
// Brultech "GEM Packet Format 2.1" document and implemented by the reference
// library siobrultech-protocols (src/gem/packets.py, MIT, used by the
// greeneye-monitor library of Home Assistant). Pure, no I/O.
//
// Every packet: header FE FF, a format code, the fields, footer FF FE and a
// checksum (the sum of every byte before it, modulo 256). Formats handled:
//
//   code 5  BIN48-NET       48 channels, absolute and polarized Ws   619 bytes
//   code 5  BIN48-NET-TIME  the same plus the GEM date and time       625 bytes
//   code 6  BIN48-ABS       48 channels, absolute Ws only             379 bytes
//   code 7  BIN32-NET       32 channels, absolute and polarized Ws   429 bytes
//   code 8  BIN32-ABS       32 channels, absolute Ws only             269 bytes
//
// BIN48-NET and BIN48-NET-TIME share the code 5: a packet is read as
// BIN48-NET first and, when its footer or checksum is wrong at that size, as
// BIN48-NET-TIME (as the reference does; its "tricky" capture is a TIME
// packet whose checksum happens to match at 619 bytes, the footer tells).
// The ECM-1220 and ECM-1240 formats (codes 1 and 3, the older ECM monitors)
// are recognised and refused: not a GEM.
//
// Fields (multi-byte values: "HiToLo" big endian, "LoToHi" little endian):
//   voltage        2 bytes HiToLo, tenths of a volt
//   absolute Ws    5 bytes LoToHi per channel (energy through the CT, both ways)
//   polarized Ws   5 bytes LoToHi per channel (NET formats: the energy produced)
//   serial         2 bytes HiToLo, then 1 reserved byte, then the device id
//                  (1 byte): the serial shown by the GEM is device id × 100000
//                  + serial (greeneye-monitor, monitor.py)
//   currents       2 bytes LoToHi per channel, fiftieths of an ampere
//   seconds        3 bytes LoToHi, a counter of the GEM (wraps at 2^24)
//   pulse counts   3 bytes LoToHi × 4
//   temperatures   2 bytes LoToHi × 8, halves of a degree, sign-magnitude
//                  (the high bit is the sign, as the reference reads it); a
//                  value above 255 means "no sensor"; in the unit set on the
//                  GEM (°C or °F: the packet does not say which)
//   spare          2 bytes (32-channel formats only)
//   time stamp     6 bytes: year - 2000, month, day, hour, minute, second
// -----------------------------------------------------------------------------

export const HEADER = Buffer.from([0xfe, 0xff]);
const FOOTER = 0xfffe;
export const NUM_PULSE_COUNTERS = 4;
export const NUM_TEMPERATURE_SENSORS = 8;
/** The largest packet (BIN48-NET-TIME). */
export const MAX_PACKET = 625;
/** Codes of the ECM monitors: recognised, refused. */
export const ECM_CODES = Object.freeze(new Set([1, 3]));

export class PacketError extends Error {}

/** The field layout of a GEM format: [name, size, kind]. */
function layout({ channels, net, time }) {
  return [
    ['header', 2, 'skip'],
    ['code', 1, 'skip'],
    ['voltage', 2, 'u16be'],
    ['absolute', 5 * channels, 'ws'],
    ...(net ? [['polarized', 5 * channels, 'ws']] : []),
    ['serial', 2, 'u16be'],
    ['reserved', 1, 'skip'],
    ['deviceId', 1, 'u8'],
    ['currents', 2 * channels, 'currents'],
    ['seconds', 3, 'u24le'],
    ['pulses', 3 * NUM_PULSE_COUNTERS, 'pulses'],
    ['temperatures', 2 * NUM_TEMPERATURE_SENSORS, 'temperatures'],
    ...(channels === 32 ? [['spare', 2, 'skip']] : []),
    ...(time ? [['timeStamp', 6, 'time']] : []),
    ['footer', 2, 'skip'],
    ['checksum', 1, 'skip'],
  ];
}

function format(name, code, channels, net, time) {
  const fields = layout({ channels, net, time });
  const size = fields.reduce((sum, [, bytes]) => sum + bytes, 0);
  return Object.freeze({ name, code, channels, net, time, fields, size });
}

export const FORMATS = Object.freeze({
  BIN48_NET: format('BIN48-NET', 5, 48, true, false),
  BIN48_NET_TIME: format('BIN48-NET-TIME', 5, 48, true, true),
  BIN48_ABS: format('BIN48-ABS', 6, 48, false, false),
  BIN32_NET: format('BIN32-NET', 7, 32, true, false),
  BIN32_ABS: format('BIN32-ABS', 8, 32, false, false),
});

/** The format of a code (code 5: BIN48-NET first, see parsePacket). */
export const FORMAT_OF_CODE = Object.freeze(
  new Map([
    [5, FORMATS.BIN48_NET],
    [6, FORMATS.BIN48_ABS],
    [7, FORMATS.BIN32_NET],
    [8, FORMATS.BIN32_ABS],
  ]),
);

/** Little-endian unsigned integer of `size` bytes (5 bytes stay a safe integer). */
const uintLE = (buffer, offset, size) => {
  let value = 0;
  for (let i = size - 1; i >= 0; i -= 1) value = value * 256 + buffer[offset + i];
  return value;
};

/** Sign-magnitude, little endian, 2 bytes: the high bit of the high byte is the sign. */
const signedMagnitudeLE = (buffer, offset) => {
  const high = buffer[offset + 1];
  const magnitude = (high & 0x7f) * 256 + buffer[offset];
  return high & 0x80 ? -magnitude : magnitude;
};

export function checksumOf(buffer, size) {
  let sum = 0;
  for (let i = 0; i < size - 1; i += 1) sum += buffer[i];
  return sum % 256;
}

/** Whether `buffer` holds a whole packet of `fmt` at its start: header, code, footer, checksum. */
export function framed(buffer, fmt) {
  return (
    buffer.length >= fmt.size &&
    buffer[0] === HEADER[0] &&
    buffer[1] === HEADER[1] &&
    buffer[2] === fmt.code &&
    buffer.readUInt16BE(fmt.size - 3) === FOOTER &&
    buffer[fmt.size - 1] === checksumOf(buffer, fmt.size)
  );
}

/**
 * The format of the packet at the start of `buffer`, given its code; for the
 * code 5, BIN48-NET when it is framed at 619 bytes, else BIN48-NET-TIME.
 */
export function formatOf(buffer) {
  const fmt = FORMAT_OF_CODE.get(buffer[2]);
  if (fmt !== FORMATS.BIN48_NET) return fmt;
  return framed(buffer, FORMATS.BIN48_NET) ? FORMATS.BIN48_NET : FORMATS.BIN48_NET_TIME;
}

/**
 * Decodes one whole packet (exactly its size, checked framed). Raw values
 * only: no unit is assumed for the temperatures.
 * @returns {{ format: string, channels: number, net: boolean, serial: number,
 *   voltage: number, absolute: number[], polarized: number[] | null,
 *   currents: number[], seconds: number, pulses: number[],
 *   temperatures: (number | null)[], timeStamp: string | null }}
 */
export function parsePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) throw new PacketError('too short');
  if (ECM_CODES.has(buffer[2])) throw new PacketError('ECM packet');
  const fmt = formatOf(buffer);
  if (!fmt) throw new PacketError('unknown format');
  if (buffer.length !== fmt.size) throw new PacketError('wrong size');
  if (!framed(buffer, fmt)) throw new PacketError('bad footer or checksum');
  const out = {
    format: fmt.name,
    channels: fmt.channels,
    net: fmt.net,
    polarized: null,
    timeStamp: null,
  };
  let offset = 0;
  let deviceId = 0;
  let serial = 0;
  for (const [name, size, kind] of fmt.fields) {
    switch (kind) {
      case 'u16be':
        if (name === 'voltage') out.voltage = buffer.readUInt16BE(offset) / 10;
        else serial = buffer.readUInt16BE(offset);
        break;
      case 'u8':
        deviceId = buffer[offset];
        break;
      case 'u24le':
        out.seconds = uintLE(buffer, offset, 3);
        break;
      case 'ws':
        out[name] = Array.from({ length: fmt.channels }, (_, i) =>
          uintLE(buffer, offset + 5 * i, 5),
        );
        break;
      case 'currents':
        out.currents = Array.from(
          { length: fmt.channels },
          (_, i) => uintLE(buffer, offset + 2 * i, 2) / 50,
        );
        break;
      case 'pulses':
        out.pulses = Array.from({ length: NUM_PULSE_COUNTERS }, (_, i) =>
          uintLE(buffer, offset + 3 * i, 3),
        );
        break;
      case 'temperatures':
        out.temperatures = Array.from({ length: NUM_TEMPERATURE_SENSORS }, (_, i) => {
          const value = signedMagnitudeLE(buffer, offset + 2 * i) / 2;
          // Above 255: no sensor (the reference); kept as null, never a value.
          return value <= 255 ? value : null;
        });
        break;
      case 'time': {
        const [y, mo, d, h, mi, s] = buffer.subarray(offset, offset + 6);
        const pad = (n) => String(n).padStart(2, '0');
        out.timeStamp = `${2000 + y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
        break;
      }
      default:
    }
    offset += size;
  }
  out.serial = deviceId * 100_000 + serial;
  return out;
}

/** Field maxima, for the deltas across a wrap of the GEM counters. */
export const WRAP = Object.freeze({
  seconds: 2 ** 24,
  pulses: 2 ** 24,
  ws: 2 ** 40,
});

/**
 * Splits a byte stream into packets (the link side): searches the header,
 * reads the size from the format code, hands each whole packet that is framed
 * (footer and checksum) as a Buffer copy. Bounded: at most MAX_PACKET bytes
 * are kept; bytes before a header, an unknown code, a packet that is not
 * framed are skipped up to the next header and counted in `skipped` (the
 * reference does the same); an ECM packet is counted in `ecm`. Linear: each
 * byte is looked at a bounded number of times.
 */
export class PacketReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.skipped = 0;
    this.malformed = 0;
    this.ecm = 0;
  }

  get buffered() {
    return this.buffer.length;
  }

  /** Drops everything before the next header after position `from` (or all). */
  skipTo(from) {
    const next = this.buffer.indexOf(HEADER, from);
    let cut = next;
    if (next === -1) {
      // A lone 0xFE at the end may be the start of the next header: kept.
      const last = this.buffer.length - 1;
      cut = this.buffer[last] === HEADER[0] && last >= from ? last : this.buffer.length;
    }
    this.skipped += cut;
    this.buffer = this.buffer.subarray(cut);
  }

  /** Adds a chunk; returns the whole packets now available. */
  push(chunk) {
    const packets = [];
    let data = chunk;
    while (data.length > 0) {
      // Never more than MAX_PACKET bytes kept: the chunk is taken in slices.
      const room = Math.max(1, MAX_PACKET * 2 - this.buffer.length);
      const slice = data.subarray(0, room);
      data = data.subarray(slice.length);
      this.buffer =
        this.buffer.length === 0 ? Buffer.from(slice) : Buffer.concat([this.buffer, slice]);
      this.drain(packets);
    }
    return packets;
  }

  drain(packets) {
    for (;;) {
      if (this.buffer.length === 0) return;
      if (
        this.buffer[0] !== HEADER[0] ||
        (this.buffer.length > 1 && this.buffer[1] !== HEADER[1])
      ) {
        this.skipTo(1);
        continue;
      }
      if (this.buffer.length < 3) return;
      const code = this.buffer[2];
      if (ECM_CODES.has(code)) {
        this.ecm += 1;
        this.skipTo(2);
        continue;
      }
      const first = FORMAT_OF_CODE.get(code);
      if (!first) {
        this.malformed += 1;
        this.skipTo(2);
        continue;
      }
      if (this.buffer.length < first.size) return;
      let fmt = framed(this.buffer, first) ? first : undefined;
      if (!fmt && first === FORMATS.BIN48_NET) {
        if (this.buffer.length < FORMATS.BIN48_NET_TIME.size) return;
        fmt = framed(this.buffer, FORMATS.BIN48_NET_TIME) ? FORMATS.BIN48_NET_TIME : undefined;
      }
      if (!fmt) {
        this.malformed += 1;
        this.skipTo(2);
        continue;
      }
      packets.push(Buffer.from(this.buffer.subarray(0, fmt.size)));
      this.buffer = this.buffer.subarray(fmt.size);
    }
  }
}
