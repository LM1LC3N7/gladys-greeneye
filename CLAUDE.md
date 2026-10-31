# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk`, its only
runtime dependency. It shows a Brultech GreenEye Monitor (GEM). The GEM is a
TCP **client**: it pushes its packets to the server typed in its web page.
The main container cannot publish a port, so the same image also runs the
`gem-link` sub-container (manifest `containers`), the TCP endpoint the GEM
connects to; the two talk over a private authenticated channel. Read only:
nothing is ever sent to the GEM. Never tested with a real GEM, not affiliated
with Brultech.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

On the maintainer's VM: `gi test`, `gi ci` (whole CI), `memcap` for any other
node command.

## Architecture

```
index.js                  SDK bootstrap only (/data first, then Gladys)
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                GreenEyeApp: link lifecycle, identity, packets,
                          values, the counter guards, status, the accept button
src/channel.js            private channel between the two containers (HMAC both ways)
src/link/service.js       the gem-link sub-container: TCP endpoint, bounds
src/receiver.js           entry point of the sub-container
src/gem/packets.js        GEM packet formats, parse, stream reader (siobrultech-protocols)
src/guard.js              lifelong counters: never 0, never down, held (gladys-p1-monitor)
src/model.js              -> Gladys devices, features, conversions (pure)
src/publisher.js          states within 250/min, never older than a minute
src/store.js              /data/greeneye.json, bounded reads, special files refused
src/config.js             config_schema normalized
src/constants.js          keys, limits, bounds, timings
src/i18n.js               names and texts (en/fr)
test/fixtures/gem.js      packet builder, fake GEM, fake channel, the setup
test/fixtures/*.bin       the reference's captures (+ reference-values.json)
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: monitor `greeneye:<serial>` (features
  `voltage`, `temp-<n>`, `pulse-<n>`), channel `greeneye:<serial>-ch<n>`
  (features `index`, `power`, `current`, `production`). A republished device
  never loses a feature (`keepCreatedFeatures`).
- Manifest keys (`gem_address`, `check_source`, `gem_serial`, `channels`,
  `temperature_unit`, `language`, the action `accept_held_counters`, the
  container `gem-link` and its port name `gem`) are frozen.
- **Nothing listens before the configuration**: the link starts only with a
  valid GEM address, stops when it is removed.
- **Never write to the GEM** (no settings API): the link has no write path.
- **Lifelong counters** through `src/guard.js` only: never 0, never a drop;
  a jump or a drop held, kept in /data, said in the status, taken only by
  two clicks; never by time; dates on the session clock.
- **Identity**: the serial of the packet; another serial refused, never
  merged.
- **/data**: never a wait without bound (timer race), a special file
  refused, an unreadable file never overwritten.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`; temperatures
  in °C, converted exactly from °F, bounds checked after the conversion.
- The channel secret lives in /data only (never logged); no user secret exists.
- Files are UTF-8 without BOM (`test/encoding.test.js`).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
