// -----------------------------------------------------------------------------
// The GEM -> Gladys devices, features and states (pure).
//
// One GEM per integration, identified by its serial number (the 8 digits it
// shows: device id × 100000 + serial, read in every packet). External ids
// (frozen: renaming one orphans the device and its history):
//   monitor  `ext:<selector>:greeneye:<serial>`
//            features `voltage`, `temp-<1..8>`, `pulse-<1..4>`
//   channel  `ext:<selector>:greeneye:<serial>-ch<1..48>`
//            features `index`, `power`, `current`, `production`
// The serial is in every external id: another GEM never takes the history
// of the first one.
//
// A channel appears once it measured energy (its absolute counter rose
// between two packets) or when the configuration lists it; its production
// index once its polarized counter (NET formats) is above 0. A temperature
// sensor appears once it gave a plausible value (and a unit is chosen), a
// pulse counter once it rose. Unused channels of a BIN48 packet carry junk
// that never moves (the reference's captures): they never appear by
// themselves. A device published again never loses a feature: those of the
// device created in Gladys are kept as they are.
//
// Everything is read only: nothing is ever sent to the GEM.
// Units only from the core's DEVICE_FEATURE_UNITS_BY_CATEGORY: V, A, W, kWh, °C.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { BOUNDS, DEVICE_TYPE } from './constants.js';
import { NAMES, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});

export const DEFINITIONS = Object.freeze({
  index: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1_000_000_000,
  }),
  production: sensor({
    category: C.ENERGY_PRODUCTION_SENSOR,
    type: T.ENERGY_PRODUCTION_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1_000_000_000,
  }),
  power: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: BOUNDS.power.min,
    max: BOUNDS.power.max,
  }),
  current: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.CURRENT,
    unit: U.AMPERE,
    min: BOUNDS.current.min,
    max: BOUNDS.current.max,
  }),
  voltage: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.VOLTAGE,
    unit: U.VOLT,
    min: 0,
    max: BOUNDS.voltage.max,
  }),
  temperature: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: BOUNDS.temperature.min,
    max: BOUNDS.temperature.max,
  }),
  pulses: sensor({
    category: C.COUNTER_SENSOR,
    type: T.SENSOR.INTEGER,
    min: 0,
    max: 2 ** 24,
  }),
});

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const monitorSlug = (serial) => String(serial);
export const channelSlug = (serial, n) => `${serial}-ch${n}`;
export const deviceIds = (gladys, slug) => gladys.externalIds(DEVICE_TYPE, slug);

/** `{ serial, channel }` (channel null for the monitor) of one of our device external ids. */
export function parseDeviceId(externalId) {
  const match = /:greeneye:(\d{1,8})(?:-ch(\d{1,2}))?$/.exec(String(externalId ?? ''));
  if (!match) return undefined;
  const channel = match[2] === undefined ? null : Number(match[2]);
  if (channel !== null && (channel < 1 || channel > 48)) return undefined;
  return { serial: Number(match[1]), channel };
}

/** The channels shown: those listed in the configuration, else those seen working. */
export function shownChannels(config, seen) {
  return [...(config.channels ?? seen.channels)].sort((a, b) => a - b);
}

/**
 * The Gladys devices of the GEM `serial`. `created`: external id -> the
 * device created in Gladys, whose features are kept when the new build lacks
 * them.
 */
export function buildDevices(gladys, serial, seen, { config, created = new Map() }) {
  if (serial === undefined) return [];
  const language = config.language;
  const devices = [];
  const monitorIds = deviceIds(gladys, monitorSlug(serial));
  const feature = (ids, key, name, definition) => ({
    name,
    external_id: ids.feature(key),
    ...definition,
  });
  const monitorFeatures = [
    feature(monitorIds, 'voltage', word(NAMES.voltage, language), DEFINITIONS.voltage),
  ];
  if (config.temperatureUnit !== 'off') {
    for (const n of [...seen.temps].sort((a, b) => a - b)) {
      monitorFeatures.push(
        feature(monitorIds, `temp-${n}`, NAMES.temperature(n, language), DEFINITIONS.temperature),
      );
    }
  }
  for (const n of [...seen.pulses].sort((a, b) => a - b)) {
    monitorFeatures.push(
      feature(monitorIds, `pulse-${n}`, NAMES.pulses(n, language), DEFINITIONS.pulses),
    );
  }
  devices.push(
    keepCreatedFeatures(
      {
        name: NAMES.monitor(serial),
        external_id: monitorIds.device,
        model: 'GreenEye Monitor',
        should_poll: false,
        features: monitorFeatures,
        params: [{ name: 'GEM_SERIAL', value: String(serial) }],
      },
      created.get(monitorIds.device),
    ),
  );
  for (const n of shownChannels(config, seen)) {
    const ids = deviceIds(gladys, channelSlug(serial, n));
    const features = [
      feature(ids, 'index', word(NAMES.index, language), DEFINITIONS.index),
      feature(ids, 'power', word(NAMES.power, language), DEFINITIONS.power),
      feature(ids, 'current', word(NAMES.current, language), DEFINITIONS.current),
    ];
    if (seen.produced.has(n)) {
      features.push(
        feature(ids, 'production', word(NAMES.production, language), DEFINITIONS.production),
      );
    }
    devices.push(
      keepCreatedFeatures(
        {
          name: NAMES.channel(serial, n, language),
          external_id: ids.device,
          model: 'GreenEye Monitor',
          should_poll: false,
          features,
          params: [
            { name: 'GEM_SERIAL', value: String(serial) },
            { name: 'GEM_CHANNEL', value: String(n) },
          ],
        },
        created.get(ids.device),
      ),
    );
  }
  return devices;
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** Rounded to `digits` decimals (published values). */
export const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** °C of a raw GEM temperature, or undefined when it is not a measurement. */
export function celsiusOf(raw, unit) {
  // null: no sensor (above 255); exactly 0: no sensor either (the reference
  // says the GEM "sometimes" sends 0 for it): never published as 0.
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) return undefined;
  let celsius;
  if (unit === 'celsius') celsius = raw;
  else if (unit === 'fahrenheit') celsius = ((raw - 32) * 5) / 9;
  else return undefined;
  // Checked after the conversion.
  if (celsius < BOUNDS.temperature.min || celsius > BOUNDS.temperature.max) return undefined;
  return round(celsius, 2);
}

/** Whether a voltage, a current, a power are measurements (0 V is "no reading"). */
export const plausibleVoltage = (v) =>
  Number.isFinite(v) && v >= BOUNDS.voltage.min && v <= BOUNDS.voltage.max;
export const plausibleCurrent = (a) =>
  Number.isFinite(a) && a >= BOUNDS.current.min && a <= BOUNDS.current.max;
export const plausiblePower = (w) =>
  Number.isFinite(w) && w >= BOUNDS.power.min && w <= BOUNDS.power.max;
