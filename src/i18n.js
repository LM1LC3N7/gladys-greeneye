// -----------------------------------------------------------------------------
// Names and texts, English and French. Statuses are { en, fr }; the names of
// the devices and features follow the `language` option.
// -----------------------------------------------------------------------------

const t = (en, fr) => ({ en, fr });
export const word = (pair, language) => pair[language === 'en' ? 'en' : 'fr'];

/** Thousands kept readable: 1234.5 -> "1234.5" (no locale grouping, the same in both languages). */
const num = (value) => String(Math.round(value * 1000) / 1000);

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const ago = (ms) =>
  ms < 120_000
    ? t(`${Math.max(1, Math.round(ms / 1000))} s`, `${Math.max(1, Math.round(ms / 1000))} s`)
    : t(`${minutes(ms)} min`, `${minutes(ms)} min`);

export const NAMES = {
  monitor: (serial) => `GreenEye ${serial}`,
  channel: (serial, n, language) =>
    `GreenEye ${serial} ${word(t('channel', 'canal'), language)} ${n}`,
  index: t('Energy (index)', 'Énergie (index)'),
  production: t('Energy produced (index)', 'Énergie produite (index)'),
  power: t('Power', 'Puissance'),
  current: t('Current', 'Courant'),
  voltage: t('Voltage', 'Tension'),
  temperature: (n, language) => `${word(t('Temperature', 'Température'), language)} ${n}`,
  pulses: (n, language) => `${word(t('Pulse counter', 'Compteur d’impulsions'), language)} ${n}`,
};

/** The name of a counter key (`ch3`, `ch3-prod`, `pulse-2`) in the status. */
export function counterName(key) {
  let m = /^ch(\d+)-prod$/.exec(key);
  if (m) return t(`channel ${m[1]} (produced)`, `canal ${m[1]} (produit)`);
  m = /^ch(\d+)$/.exec(key);
  if (m) return t(`channel ${m[1]}`, `canal ${m[1]}`);
  m = /^pulse-(\d)$/.exec(key);
  return t(`pulse counter ${m?.[1] ?? '?'}`, `compteur d’impulsions ${m?.[1] ?? '?'}`);
}

const unitOf = (key) => (key.startsWith('pulse') ? t('pulses', 'impulsions') : t('kWh', 'kWh'));

/** One held counter: "channel 3: 120.5 → 0.2 kWh (drop)". */
function heldLine(key, held) {
  const name = counterName(key);
  const unit = unitOf(key);
  const kind = held.direction === 'down' ? t('drop', 'baisse') : t('jump', 'saut');
  return t(
    `${name.en}: ${num(held.from)} → ${num(held.to)} ${unit.en} (${kind.en})`,
    `${name.fr} : ${num(held.from)} → ${num(held.to)} ${unit.fr} (${kind.fr})`,
  );
}

/** "a; b; c and 3 more" from a list of { en, fr }. */
function joined(lines, max) {
  const shown = lines.slice(0, max);
  const rest = lines.length - shown.length;
  return t(
    shown.map((l) => l.en).join('; ') + (rest > 0 ? ` and ${rest} more` : ''),
    shown.map((l) => l.fr).join(' ; ') + (rest > 0 ? ` et ${rest} autres` : ''),
  );
}

export const STATUS = {
  noAddress: t(
    'Type the IP address of the GreenEye Monitor and save: nothing listens before.',
    'Saisissez l’adresse IP du GreenEye Monitor et enregistrez : rien n’écoute avant.',
  ),
  badAddress: t(
    'The address of the GEM is not a valid IP address (no name, no port, no broadcast or multicast address).',
    'L’adresse du GEM n’est pas une adresse IP valide (ni nom, ni port, ni adresse de diffusion ou multicast).',
  ),
  configUnread: (attempt) =>
    t(
      `The configuration could not be read from Gladys (attempt ${attempt}); trying again.`,
      `La configuration n’a pas pu être lue depuis Gladys (essai ${attempt}) ; nouvel essai.`,
    ),
  linkDown: (why) =>
    t(
      `The receiving container (gem-link) is not running (${why}); tried again every minute.`,
      `Le conteneur de réception (gem-link) ne tourne pas (${why}) ; réessai chaque minute.`,
    ),
  linkUnreachable: t(
    'The receiving container (gem-link) runs but does not answer this container yet.',
    'Le conteneur de réception (gem-link) tourne mais ne répond pas encore à ce conteneur.',
  ),
  waiting: (port, host) =>
    t(
      `Waiting for the GEM: in its "Packet Send" settings, send to the IP address of the Gladys machine, port ${port ?? '(not known yet, reload in a moment)'}${host ? `, from ${host}` : ''}.`,
      `En attente du GEM : dans ses réglages « Packet Send », envoyez vers l’adresse IP de la machine Gladys, port ${port ?? '(pas encore connu, rechargez dans un instant)'}${host ? `, depuis ${host}` : ''}.`,
    ),
  noPacket: (from) =>
    t(
      `The GEM is connected from ${from} but no GEM packet came yet (set a binary packet format: BIN32 or BIN48, NET or ABS).`,
      `Le GEM est connecté depuis ${from} mais aucun paquet GEM n’est encore arrivé (choisissez un format binaire : BIN32 ou BIN48, NET ou ABS).`,
    ),
  connected: ({ serial, format, channels }) =>
    t(
      `GEM ${serial} connected (${format}), ${channels} channel(s) shown, packets arriving.`,
      `GEM ${serial} connecté (${format}), ${channels} canal(aux) affiché(s), paquets reçus.`,
    ),
  stale: ({ serial, since }) =>
    t(
      `No packet from GEM ${serial} for ${ago(since).en}: nothing is published (no value is made up).`,
      `Aucun paquet du GEM ${serial} depuis ${ago(since).fr} : rien n’est publié (aucune valeur inventée).`,
    ),
  refused: (from, count) =>
    t(
      ` ${count} connection(s) refused from ${from} (not the address of the GEM; turn "Check the sender" off only if Docker hides the real address).`,
      ` ${count} connexion(s) refusée(s) depuis ${from} (pas l’adresse du GEM ; ne désactivez « Vérifier l’expéditeur » que si Docker masque la vraie adresse).`,
    ),
  otherSerial: (seen, expected, typed) =>
    t(
      ` Packets of GEM ${seen} refused: this integration follows GEM ${expected}${typed ? ' (the serial number typed)' : ' (the first one heard)'}. If the monitor was replaced, type ${seen} in "Serial number of the GEM".`,
      ` Paquets du GEM ${seen} refusés : cette intégration suit le GEM ${expected}${typed ? ' (le numéro de série saisi)' : ' (le premier entendu)'}. Si le moniteur a été remplacé, saisissez ${seen} dans « Numéro de série du GEM ».`,
    ),
  serialInvalid: t(
    ' The serial number typed is not valid (1 to 8 digits): ignored.',
    ' Le numéro de série saisi n’est pas valide (1 à 8 positions, de 0 à 9) : ignoré.',
  ),
  channelsInvalid: t(
    ' The list of channels is not valid (like "1-12, 15", channels 1 to 48): the channels are chosen automatically.',
    ' La liste des canaux n’est pas valide (comme « 1-12, 15 », canaux 1 à 48) : les canaux sont choisis automatiquement.',
  ),
  temperaturesOff: t(
    ' Temperatures not published: choose the unit set on the GEM (°C or °F) in the configuration.',
    ' Températures non publiées : choisissez l’unité réglée sur le GEM (°C ou °F) dans la configuration.',
  ),
  junk: ({ ecm, malformed }) =>
    t(
      `${ecm > 0 ? ` ${ecm} ECM packet(s) ignored (only the GEM is handled).` : ''}${malformed > 0 ? ` ${malformed} malformed packet(s) skipped.` : ''}`,
      `${ecm > 0 ? ` ${ecm} paquet(s) ECM ignoré(s) (seul le GEM est pris en charge).` : ''}${malformed > 0 ? ` ${malformed} paquet(s) mal formé(s) ignoré(s).` : ''}`,
    ),
  held: (entries, max) => {
    const list = joined(
      entries.map(([key, held]) => heldLine(key, held)),
      max,
    );
    return t(
      ` Counters held back (a jump or a drop; the last accepted value is sent again, nothing counted): ${list.en}. If it is real (a reset, a replaced CT, a long cut), click "Accept the held counters" twice.`,
      ` Compteurs retenus (un saut ou une baisse ; la dernière valeur acceptée est renvoyée, rien n’est compté) : ${list.fr}. Si c’est réel (remise à zéro, pince remplacée, longue coupure), cliquez deux fois sur « Accepter les compteurs retenus ».`,
    );
  },
  dataUnreadable: t(
    ' /data/greeneye.json cannot be read: it is never overwritten, nothing new is kept until it is fixed.',
    ' /data/greeneye.json est illisible : il n’est jamais écrasé, rien de nouveau n’est gardé avant sa réparation.',
  ),
  dataUnsaved: t(
    ' /data could not be written: what is held back is kept in memory only.',
    ' /data n’a pas pu être écrit : ce qui est retenu n’est gardé qu’en mémoire.',
  ),
};

export const ACCEPT = {
  nothing: t(
    'No counter is held back: nothing to accept.',
    'Aucun compteur n’est retenu : rien à accepter.',
  ),
  confirm: (entries, within) => {
    const list = joined(
      entries.map(([key, held]) => heldLine(key, held)),
      48,
    );
    const m = minutes(within);
    return t(
      `Nothing accepted yet. A second click accepts exactly: ${list.en}. A jump is then counted at once as consumption; a drop counts nothing and the counter goes on from there. Click again after a few seconds and within ${m} min; accept only if this is real.`,
      `Rien n’est encore accepté. Un second clic accepte exactement : ${list.fr}. Un saut est alors compté d’un coup comme consommation ; une baisse ne compte rien et le compteur repart de là. Cliquez de nouveau après quelques secondes et dans les ${m} min ; n’acceptez que si c’est réel.`,
    );
  },
  changed: t(
    'The counters held back changed since the first click: nothing accepted. Read the status, then click twice again.',
    'Les compteurs retenus ont changé depuis le premier clic : rien n’est accepté. Lisez l’état, puis cliquez de nouveau deux fois.',
  ),
  done: (entries) => {
    const list = joined(
      entries.map(([key, held]) => heldLine(key, held)),
      48,
    );
    return t(`Accepted: ${list.en}.`, `Accepté : ${list.fr}.`);
  },
};
