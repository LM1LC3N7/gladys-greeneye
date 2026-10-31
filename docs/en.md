# GreenEye Monitor for Gladys Assistant

This integration shows in Gladys the values of a **Brultech GreenEye Monitor**
(GEM), the 32-channel energy monitor made in British Columbia: energy and
power of each channel, current, voltage, pulse counters (water, gas) and
temperatures. Everything stays on your local network, without any cloud.

Unofficial integration, not affiliated with Brultech. **Never tested with a
real GEM**: it follows the GEM packet format document of Brultech and the
siobrultech-protocols and greeneye-monitor libraries (MIT) of Home Assistant,
and is tested against their packet captures. Your feedback with a real
monitor is welcome.

**Read only**: nothing is ever sent to the GEM. The integration never changes
a setting of the monitor.

## What you get

- one device **GreenEye <serial>** (the monitor): voltage (V), the pulse
  counters that counted (raw pulse counts), the temperatures (°C) once their
  unit is chosen;
- one device per channel, **GreenEye <serial> channel <n>**: energy index
  (kWh, for the energy monitoring of Gladys), power (W) and current (A); on a
  NET channel that produces (solar), an index of the energy produced (kWh),
  and a negative power while it produces.

A channel shows in the **Discovery** tab once it measured energy (its
counter rose between two packets). The unused channels of a 48-channel packet
carry fixed junk values: they never appear by themselves. To choose the
channels yourself, type them in **Channels to show** (like `1-12, 15`).

The serial number of the GEM is in every external id: a second GEM never
takes the history of the first one.

## Settings of the GEM

In the web page of the GEM, in the packet sending settings ("Packet Send",
TCP client mode):

- **server**: the IP address of the Gladys machine on your network;
- **port**: the port shown in the "How the GEM reaches Gladys" section of the
  configuration screen (chosen by Gladys, see below);
- **packet format**: a binary format, BIN48-NET, BIN32-NET, BIN48-NET-TIME,
  BIN48-ABS or BIN32-ABS. Use a NET format if a channel measures a solar
  production: with an ABS format the GEM counts the energy of both directions
  together, and the index of such a channel adds the production to the
  consumption. The ASCII formats and the ECM-1220/1240 monitors are not
  handled (the status counts the ECM packets ignored);
- **interval**: any (1 to 255 s). The power is the average over the last two
  packets.

### Temperatures: choose the unit of the GEM

The packets carry the temperatures in the unit set on the GEM (°C or °F)
without saying which one. Choose it in **Temperature unit set on the GEM**:
°F values are converted exactly to °C ((°F − 32) × 5/9, rounded to 0.01),
and the bounds (−55 to 125 °C, the range of the sensors) are checked after
the conversion. Off (the default): no temperature is published. A sensor
reading exactly 0 or "no sensor" (above 255) is not a value: never published.

## How the GEM reaches Gladys

The GEM opens the connection (TCP) itself; Gladys does not poll it. So the
integration starts a small receiver next to it (the `gem-link` container),
whose port Gladys publishes on the machine.

1. Give the GEM a fixed IP address in your router.
2. In the **Configuration** screen of the integration, type that address and
   save. **Nothing listens before**: the receiver starts only once a valid
   address is saved, and stops if you clear it.
3. Reload the screen: the "How the GEM reaches Gladys" section shows the port
   Gladys chose (a free port, kept afterwards).
4. Set the GEM as above. The status turns to "GEM … connected" at the first
   packet.

The Gladys core runs on the host network of the machine
(`network_mode: host`), but integrations run in isolated containers: they
cannot listen on the machine themselves. The `gem-link` receiver is a
sub-container declared in the manifest, whose TCP port 8000 Gladys publishes
on every address of the machine. It is the same mechanism as the Wolf ISM8
integration, checked in a test Gladys: a connection from the network keeps
its real source address; a connection started on the Gladys machine itself
arrives with the address of the Docker gateway. Hence:

- allow this TCP port in the firewall of the machine, if it has one;
- **Check the sender** (on by default) accepts only the address of the GEM;
  another address is refused before a byte is read and shown in the status.
  With Docker Desktop (Mac, Windows) or rootless Docker, Docker may replace
  the source address: turn the option off in that case only. Any machine of
  your network can then send false values in the name of the GEM (its serial
  number is still checked);
- the receiver is started again only when it stopped or when the address or
  the sender check changes; when the integration restarts, Gladys restarts
  the receiver too and the GEM reconnects by itself.

## Which GEM is followed

The serial number (the 8 digits the GEM shows) is read in every packet. The
first GEM heard is followed and kept in `/data`; the packets of another serial
number are refused and the status says so. After replacing the monitor, type
the new serial in **Serial number of the GEM**: it gets its own devices.

## Lifelong counters: never 0, no drop nor jump without you

The energy index of a channel, its production index and the pulse counters
are the values the energy monitoring of Gladys turns into consumption: it
counts every rise in full. So:

- a value of 0 is not published;
- a value is checked against the last one accepted: not lower, and not more
  than 100 kWh per hour on average for a channel (100 pulses a second for a
  pulse counter), plus a small slack;
- a **drop** (a GEM reset, a counter at its limit, a replaced CT) or a
  **jump** is **held back**: the last accepted value is sent again, nothing
  is counted, the status lists the counter with the value held, and the hold
  is kept in `/data` across restarts. Time does not lift it, repeating the
  same value does not either;
- if it is real, click **Accept the held counters** twice in the
  configuration screen: the first click lists exactly what will be taken and
  accepts nothing; the second, after a few seconds and within 5 minutes,
  takes exactly those values (a jump is then counted at once as
  consumption; a drop counts nothing and the counter goes on from there). If
  the counters held changed in between, nothing is accepted. Saving the
  configuration accepts nothing.

The checks run on the clock of the integration (the wall clock read once at
its start plus the time elapsed since): a wall clock moved by NTP neither
widens nor narrows them.

## Freshness and status

- The values are published when a packet arrives. Packets kept by the
  receiver while the integration was away are dropped when older than a
  minute; a repeated or older packet (by the GEM's own seconds counter) is
  dropped.
- No packet for 2 minutes (or three intervals of the GEM, up to 15 minutes):
  the status says how long, the integration is not "connected", and nothing
  is made up.
- Gladys accepts 300 values a minute: with many channels and short
  intervals, the values are sent in turn (the most recent of each), at most
  250 a minute.

## Limits

- One GEM per integration.
- The settings API of the GEM (CT types, intervals) is not used.
- Not handled: ASCII packet formats, ECM-1220/1240 monitors, the pulse
  counters converted into volumes (they are raw counts).
