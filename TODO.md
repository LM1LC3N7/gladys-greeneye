# TODO — GreenEye Monitor v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-10-31): the `gem-link` sub-container
      (taken from gladys-wolf-ism8: TCP endpoint of the GEM, bounded, sender
      checked, one session, nothing written to the GEM), the GEM packet
      formats (tested on the reference's captures), one device for the
      monitor and one per channel, the counter guard of gladys-p1-monitor
      with two-click acceptance, docs en/fr, cover. Tested against a fake
      GEM (loopback) and the SDK's fake Gladys, real clock ×20.
- [ ] **Milestone 2 — real GEM**: run against a real monitor, record packets
      (no serial) as fixtures; a client from another network namespace in
      the sandbox Gladys (its source address kept, as for gladys-wolf-ism8).
- [ ] **Milestone 3 — more**: pulse counters as volumes (a factor per
      counter, water and gas meters), ECM-1240, several GEMs, optional
      daily consumption through `publishEnergyConsumption`.

## To check on a real GEM

- Does the GEM keep one TCP connection open in "Packet Send" client mode, or
  connect for each packet? Both work (the power baseline follows the serial,
  not the session), the status is the same.
- The `seconds` counter after a reboot of the GEM (reset to 0 or kept): a big
  step back is taken as a new start (no power for that packet), a step back
  of 10 minutes or less as an old packet (dropped).
- The junk of unused channels in BIN48 packets: fixed (never shown) or moving
  (then shown: the user lists the channels).
- The temperature reading 0 for a missing sensor (the reference says
  "sometimes"): a true 0 °C / 0 °F is not published either.
- The NET semantics (polarized = produced) on a solar channel, the sign of
  the power.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and both `docker_image` tags (`ghcr.io/lm1lc3n7/gladys-greeneye:0.1.0`);
  `test/manifest.test.js` checks they agree. SDK `^0.16.0` (the latest published).
- **Reference**: siobrultech-protocols (MIT, commit b239d51) for the packet
  formats, greeneye-monitor 5.0.2 (MIT, commit 314104c) for the serial, the
  NET energies and the temperature unit. Cloned read only in
  `~/code/ref/lot19/`. Their captures and expected values are the test
  fixtures. Notices in `THIRD_PARTY_NOTICES.md`, shipped in the image with
  `LICENSE`.
- **Read only, passive**: the reference asks the settings API of the GEM on
  the same connection (CT types, temperature unit, packet format). Not done:
  nothing is ever sent, so nothing can change a setting of the monitor. The
  price: the temperature unit is chosen in the configuration (`off` by
  default: no temperature published until chosen).
- **Incoming connection**: as gladys-wolf-ism8 (approved, checked in the
  sandbox Gladys): the `gem-link` sub-container (same image,
  `node src/receiver.js`, `start: manual`, read only, 64 MB) publishes
  container port 8000 (the default of Home Assistant) on a host port chosen
  by Gladys (`{{port:gem}}` in the connection section). Started only once a
  valid GEM address is saved, stopped when it is removed.
- **Checked in the sandbox Gladys** (2026-10-31, `gi install`, the
  sub-container image tagged locally): nothing listens before the address;
  once saved, `gem-link` is published (`0.0.0.0:<port>`), the channel comes
  up; packets sent from the Gladys machine itself arrive from the Docker
  gateway and are refused with the sender checked (said in the status); with
  the check off they reach the main container: Discovery (monitor, channel
  1), status "connected"; the link restarted when the environment changed;
  the address cleared stops it. The core adds `index_consumption` and
  `index_cost` to a channel with an energy index.
- **Link bounds**: 4 sockets, one GEM session (a new connection replaces the
  old one), packets of 625 bytes at most and framed (footer, checksum), junk
  skipped to the next header as the reference does but 64 KiB of it closes
  the session, an incomplete packet closed after 5 s, 40 packets per 10 s,
  100 packets queued while the main container is away.
- **Identity**: the serial (device id × 100000 + serial) of every packet;
  the first heard pinned in /data, or the one typed (`gem_serial`); a typed
  serial that differs forgets what was seen and held for the other GEM; the
  serial is in every external id, so two GEMs never share a history. With
  /data unreadable, the pin lives in memory only (the external ids carry the
  serial anyway).
- **Order**: by the GEM `seconds` counter, never the time of arrival: equal
  = repeat (dropped), up to 600 s back = older packet (dropped), more =
  restart or wrap (taken, no power for it). Packets stamped by the link more
  than a minute ago are dropped.
- **Channels shown**: those whose absolute counter rose by a plausible amount
  between two packets (the junk of BIN48 packets does not move in the
  reference's captures), or the list typed. Production index once the
  polarized counter is above 0 on a NET format. Temperatures once plausible
  (unit chosen), pulse counters once they rose.
- **Counters**: `src/guard.js` is the guard of gladys-p1-monitor (approved),
  with the margin per kind: 100 kWh/h + 0.5 kWh per channel, 100 pulses/s +
  100 per counter. Checked and published once a minute. Session clock (wall at start + monotonic); /data keeps those session dates
  (simpler than the wall offsets of gladys-p1-monitor), and a date from /data
  or Gladys ahead of the session clock is taken as now. Residual: a life
  started with a wall clock hours behind dates its references early (a
  larger margin once). Written at once when a counter is first checked or a
  hold appears, changes or ends, else every 10 minutes and at shutdown. The
  two clicks accept all the counters listed or none.
- **Power**: (Δabsolute − 2 Δpolarized) / Δseconds (the reference), signed
  (`energy-sensor/power`, negative while producing); a delta through a reset
  is out of bounds (±200 kW) and not published.
- **Temperatures**: raw 0 and above 255 are not values; °F → °C exactly,
  rounded to 0.01, bounds −55..125 °C after the conversion.
- **Publication**: the publisher of gladys-wolf-ism8 (250 states/min, values
  older than a minute dropped), only features of created devices.
- **Store keys** (`keywords`, `countries`): not set in the manifest (CA, US
  would fit).
