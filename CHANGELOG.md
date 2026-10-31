# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: a Brultech GreenEye Monitor, locally and read only. The GEM
  sends its binary packets (BIN32/BIN48, NET/ABS, NET-TIME) to the `gem-link`
  sub-container, whose port Gladys publishes once the address of the GEM is
  saved (nothing listens before), the sender checked by default.
- One device for the monitor (voltage, pulse counters, temperatures in °C,
  converted exactly from °F) and one per channel (energy index, power,
  current, production index on a NET channel that produces).
- The GEM followed by its serial number (pinned at the first packet, or
  typed); another serial refused and said.
- Lifelong counters never published at 0: a jump or a drop
  held back, kept in /data, accepted only by two clicks on "Accept the held
  counters".
- The 5-byte energy counters (2^40 Ws) and the pulse counters (2^24) are
  unwrapped (offset kept in /data): a wrap is counted on, never a drop.
- What is seen and held is kept per serial number: a serial mistyped then
  corrected keeps every hold; a guard without /data is built on a fresh read
  of Gladys.
- A restart of the GEM in a new connection is taken (and said), a hanging
  /data write is said, an unreadable /data pins no serial, a cleared serial
  field follows the first GEM heard again.
