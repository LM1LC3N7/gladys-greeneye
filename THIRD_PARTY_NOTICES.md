# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the projects below, and test data
taken from them. The ported parts were rewritten, not copied; the changes are
described below.

## siobrultech-protocols

<https://github.com/sdwilsh/siobrultech-protocols> (Python package
`siobrultech-protocols`, the protocol library of the Home Assistant
`greeneye_monitor` integration), by Jonathan Keljo and Shawn Wilsher. MIT
License (`LICENSE` of the repository, commit b239d51 of 2026-10-13).

Ported: the GEM packet formats (BIN48-NET, BIN48-NET-TIME, BIN48-ABS,
BIN32-NET, BIN32-ABS: field order, sizes, byte orders, divisors, the
sign-magnitude temperatures, the "no sensor" value above 255, the checksum,
the footer, the BIN48-NET / BIN48-NET-TIME disambiguation by the footer), the
skipping of junk up to the next header, the wrap of the counters, the power
of a channel over two packets ((consumed − produced) / seconds). Changes: the
ECM formats refused; the stream bounded in size and time; nothing ever sent to
the monitor (no settings API).

Test data: the packet captures `tests/gem/data/BIN*.bin` (in
`test/fixtures/`) and the expected values of `tests/gem/packet_test_data.py`
(turned into `test/fixtures/reference-values.json`).

```
MIT License

Copyright (c) 2018 Jonathan Keljo
Copyright (c) 2021 Shawn Wilsher

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## greeneye-monitor

<https://github.com/jkeljo/greeneye-monitor> (Python package
`greeneye-monitor` 5.0.2, commit 314104c of 2024-02-18), by Jonathan Keljo.
MIT License, same text as above (Copyright (c) 2018 Jonathan Keljo).

Ported: the serial number of the monitor (device id × 100000 + serial), the
consumed and produced energies of a NET channel (absolute − polarized,
polarized), the role of the temperature unit set on the monitor.
