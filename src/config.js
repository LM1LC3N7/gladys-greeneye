// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. Nothing here is
// a secret (the GEM packets carry no password); the secret of the channel
// between the two containers lives in /data (src/store.js).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  gem_address: '',
  check_source: true,
  gem_serial: '',
  channels: '',
  temperature_unit: 'off',
  language: 'fr',
};

export const TEMPERATURE_UNITS = Object.freeze(['off', 'celsius', 'fahrenheit']);
/** The largest serial a packet can carry: device id 255 × 100000 + 65535. */
export const MAX_SERIAL = 255 * 100_000 + 65_535;
export const MAX_CHANNELS = 48;

/** Only `false` (or the text "false") turns off: a missing value keeps the safe default. */
const strictFalse = (value) => value === false || value === 'false';

/** "::ffff:192.168.1.5" -> "192.168.1.5"; an IPv6 in lower case; undefined if not an IP. */
export function normalizeIp(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  let text = value.trim();
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(text)) {
    text = text.slice(7);
  }
  const version = isIP(text);
  if (version === 4) {
    return text;
  }
  return version === 6 ? text.toLowerCase() : undefined;
}

/**
 * The address of the GEM: one IP address of a machine (no name: the address
 * the connection comes from is compared to it; neither 0.0.0.0, ::, a
 * multicast nor the broadcast address).
 * @returns {{ host: string } | { error: 'empty' | 'invalid' }}
 */
export function parseGemAddress(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/^\[(.*)\]$/, '$1') : '';
  if (text === '') {
    return { error: 'empty' };
  }
  const ip = text.length <= 64 ? normalizeIp(text) : undefined;
  if (
    !ip ||
    ip === '0.0.0.0' ||
    ip === '::' ||
    ip === '255.255.255.255' ||
    /^(22[4-9]|2[3-5]\d)\./.test(ip) ||
    /^ff/i.test(ip)
  ) {
    return { error: 'invalid' };
  }
  return { host: ip };
}

/**
 * The serial number typed (the 8 digits the GEM shows), else null (empty) or
 * 'invalid'. Leading zeros allowed; never above MAX_SERIAL.
 */
export function parseSerial(raw) {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return null;
  if (!/^\d{1,8}$/.test(text)) return 'invalid';
  const value = Number(text);
  return value >= 1 && value <= MAX_SERIAL ? value : 'invalid';
}

/**
 * The channels to show: "1-12, 15" -> [1..12, 15]; empty -> null (automatic:
 * the channels that measured energy); anything else -> 'invalid'. Bounded:
 * 64 characters, channels 1 to 48.
 */
export function parseChannels(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return null;
  if (text.length > 64 || !/^[\d\s,-]+$/.test(text)) return 'invalid';
  const set = new Set();
  for (const part of text.split(',')) {
    const match = /^\s*(\d{1,2})\s*(?:-\s*(\d{1,2})\s*)?$/.exec(part);
    if (!match) return 'invalid';
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > MAX_CHANNELS || to < from) return 'invalid';
    for (let n = from; n <= to; n += 1) set.add(n);
  }
  return set.size > 0 ? set : 'invalid';
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value !== null && value !== undefined) {
      c[key] = value;
    }
  }
  const address = parseGemAddress(c.gem_address);
  const serial = parseSerial(c.gem_serial);
  const channels = parseChannels(c.channels);
  return {
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem: address.error ? `address:${address.error}` : undefined,
    host: address.host,
    checkSource: !strictFalse(c.check_source),
    /** The serial typed, or null; an invalid one is ignored and said in the status. */
    serial: typeof serial === 'number' ? serial : null,
    serialInvalid: serial === 'invalid',
    /** The channels to show, or null for automatic; an invalid list is automatic, said. */
    channels: channels instanceof Set ? channels : null,
    channelsInvalid: channels === 'invalid',
    temperatureUnit: TEMPERATURE_UNITS.includes(c.temperature_unit) ? c.temperature_unit : 'off',
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** The environment of the link: what it depends on (a change starts it again). */
export function linkEnv(config, token, { gemPort, channelPort }) {
  return {
    CHANNEL_TOKEN: token,
    GEM_PORT: String(gemPort),
    CHANNEL_PORT: String(channelPort),
    ...(config.checkSource && config.host ? { GEM_ADDRESS: config.host } : {}),
  };
}
