# @emdzej/nfsx-ms45

MS45 DME flashing helpers for BMW E46 (MS45.0) and E60/E65 (MS45.1)
engine control units.

**Stage 1 (this release)** — offline BIN helpers:

- CRC-32/MPEG-2 verification + recompute for the parameter blob and
  the dual program checksums that span external flash + MPC flash.
- RSA-1024 firmware signing for the parameter and program blobs,
  with MD5 hashing over the segments named in each blob's header.
- Security-access payload builder (MD5-then-RSA over
  `userID + serialNumber + seed`) — the wire-side blob EDIABAS's
  `authentisierung_start` job expects.
- Region tables + segment-header parsers.

**Stage 2 (next)** — `Ms45Session`: SGBD-driven identify / read / erase
/ write / verify orchestration over `EmbeddedEdiabas`.

## Attribution

This package is a clean-room reimplementation of the wire-level
behavior and firmware layout documented by:

- **[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher)** — the
  original open-source MS45 flasher (GPL-3.0). The RSA moduli and
  private exponents shipped in this package were first published in
  that project's `Checksums_Signatures.cs`.
- **hassmaschine** — DME disassembly and protocol reverse-engineering.
- **[bimmerlabs](https://bimmerlabs.com)** — ongoing MS45 tuning work.

No source code was copied. Everything here was written from scratch
against the wire-level facts (job names, byte layouts, CRC polynomial,
address maps, RSA constants) that the referenced projects made public.

## License

PolyForm Noncommercial 1.0.0 — inherited from the parent monorepo.
See the repository root LICENSE for terms.

## Safety

Every write path in this package can brick an MS45 DME. Read the
top-level `docs/first-flash-runbook.md` before running anything that
touches an ECU.
