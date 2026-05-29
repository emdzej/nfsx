# Bundled MiniMon binaries

This directory contains three Intel-HEX blobs from the **MiniMon v2.30**
distribution by Christian Perschl, distributed by Infineon as freeware.
They are used as-is, byte-for-byte from the original installer.

## Files

| File | Role | Size |
|---|---|---|
| `LOADK.hex` | Primary loader, K-line variant — exactly 32 bytes after HEX decoding. Uploaded into top-of-RAM by the C167 silicon BSL and then executed. | 90 bytes HEX / 32 bytes binary |
| `MINIMONK.hex` | Secondary monitor (Minimon kernel), K-line variant. Staged into RAM by the primary loader. Implements the `0x82/0xCD/0x84/0x85/0x9F/0x33` command set. | 970 bytes HEX / ~394 bytes binary |
| `A29F400B.hex` | AMD AM29F400B flash driver — the chip used in MS42 and MS43. Uploaded into RAM via `C_WRITE_BLOCK` and invoked via `C_CALL_FUNCTION` with the FC sub-commands. | 1120 bytes HEX |

## Provenance

- Original distribution: <http://www.perschl.at/minimon/>
- SourceForge mirror: <https://sourceforge.net/projects/minimon/>
- Infineon application note: AP16064 *MiniMon* (V1.2, Sept 2007)
- Distribution archive: `minimon_v230.zip` → extracted via `cabextract`
  from `Minimo[1-3].CAB` (InstallShield)

## Integrity

SHA-256 hashes are recorded in `manifest.json` and verified at runtime by
`@emdzej/nfsx-bootmode`'s `verifyBundleIntegrity()`. Any modification to
these files will fail the integrity check before they are sent to an ECU.

## License

Freeware. The MiniMon distribution is permitted for non-commercial
redistribution per Christian Perschl's licensing on perschl.at and
Infineon's freeware terms. The binaries here are unmodified copies; the
host-side TypeScript that loads, sends, and orchestrates them is part
of nfsx and licensed under the same terms as the rest of the project.

## Why HEX not binary?

The Intel HEX format is:

- Human-reviewable in diff (text)
- Self-checksummed per record (the BSL/Minimon protocol relies on every
  byte going through cleanly, and HEX gives an easy way to detect
  corruption at distribution time)
- Trivially convertible to bytes by `parseIntelHex()` in the package
