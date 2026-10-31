# gladys-greeneye

[Gladys Assistant](https://gladysassistant.com) external integration for the
**Brultech GreenEye Monitor** (GEM): energy index, power and current of each
channel, voltage, pulse counters and temperatures, on the local network.

- The GEM pushes its binary packets to Gladys (its "Packet Send" setting): the
  integration starts a receiver sub-container (`gem-link`) whose port Gladys
  publishes, once the address of the GEM is saved.
- Read only: nothing is ever sent to the GEM.
- Lifelong counters (energy, production, pulses) never published at 0; a jump
  or a drop is held back until two clicks on "Accept the held counters".

Unofficial, not affiliated with Brultech. Never tested with a real GEM: built
from the Brultech packet format and the siobrultech-protocols and
greeneye-monitor libraries (MIT), tested on their packet captures.

User guide: [English](docs/en.md), [français](docs/fr.md). Contributors: read
[CLAUDE.md](CLAUDE.md) and [TODO.md](TODO.md).

License: Apache-2.0 (see `LICENSE` and `THIRD_PARTY_NOTICES.md`).
