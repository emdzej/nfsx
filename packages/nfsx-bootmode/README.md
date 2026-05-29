# @emdzej/nfsx-bootmode

Bootmode (Infineon C167 BSL) flashing for BMW MS42 / MS43 engine ECUs
and Bosch ME 7.2 — anything built on the C16x / ST10 family. Bypasses
DS2 entirely: at power-on with the BOOT pin grounded, the C167 mask
ROM enters its silicon Bootstrap Loader; this package uploads
**MiniMon** (Christian Perschl / Infineon AP16064) into the MCU's
internal RAM and then drives the standard MiniMon command set to
read, erase, and program the AMD AM29F400B flash chip.

> ⚠️ **Bench programming only.** The C167 BOOT pin isn't exposed on
> the OBD-II connector; this only works against an ECU pulled from
> the vehicle and wired to a bench harness (12 V, GND, K-line, BOOT
> pin to ground at power-up).

## What's in the package

- **Bundled binaries** (`bundled/`) — verbatim from MiniMon v2.30:
  - `LOADK.hex` — 32-byte primary loader (C167 BSL hard-caps this size)
  - `MINIMONK.hex` — secondary monitor (~394 bytes)
  - `A29F400B.hex` — AMD AM29F400B flash driver
  - `manifest.json` — SHA-256 hashes; verified at runtime before any
    bytes go on the wire (`verifyBundleIntegrity()`)
  - `README.md` — provenance + license details
- **Intel HEX parser** (`parseIntelHex`, `flattenIntelHex`) — type 00 /
  01 / 02 / 03 / 04 / 05 records with checksum verification
- **Serial transport** (`NodeBootmodeTransport`, `MockBootmodeTransport`)
  — 8N1 at chosen baud, byte-by-byte echo verify
- **Handshake** (`performHandshake`) — the auto-baud `0x00` probe,
  BSL identification byte check, two-stage loader upload with
  per-byte echo verification and stage-boundary acknowledge bytes
- **MiniMon client** (`MinimonClient`) — the six primitive commands
  with `A_ACK1` / `A_ACK2` framing:
  - `0x82` `C_WRITE_WORD`, `0xCD` `C_READ_WORD`
  - `0x84` `C_WRITE_BLOCK`, `0x85` `C_READ_BLOCK`
  - `0x9F` `C_CALL_FUNCTION` (8 register words in/out)
  - `0x33` `C_GETCHECKSUM`
- **Flash driver wrapper** (`FlashDriver`) — uploads the AM29F400B
  driver into RAM and exposes `unlock` / `eraseSector` / `eraseRange` /
  `programBlock` / `getState` via `C_CALL_FUNCTION` with the FC
  sub-commands (`0x00` program, `0x01` erase, `0x06` get-state,
  `0x11` unlock)
- **Session orchestrators** — `readFullFlash`, `writeFullFlash`,
  `probeBootmode` for end-to-end flows

## Install

```bash
pnpm add @emdzej/nfsx-bootmode
```

The CLI front-end lives in `@emdzej/nfsx-cli` (`nfsx bootmode …`); see
[the nfsx README](../../README.md) and `nfsx bootmode --help`.

## Programmatic usage

```ts
import {
  probeBootmode,
  readFullFlash,
  writeFullFlash,
  verifyBundleIntegrity,
  C167CR_BSL_ID,
} from '@emdzej/nfsx-bootmode';

// 1. Optional: verify the bundled MiniMon blobs match their SHA-256.
const integrity = verifyBundleIntegrity();
if (!integrity.allValid) throw new Error('bundled blobs corrupted');

// 2. Probe — handshake + read flash chip ID, then disconnect.
const id = await probeBootmode(
  {
    device: '/dev/cu.usbserial-XXXX',
    baud: 19200,
    defaultTimeoutMs: 2000,
    expectedBslId: C167CR_BSL_ID, // 0xC5 for MS42/MS43
  },
  (p) => console.error(`[${p.stage}] ${p.message}`),
);
console.log(`flash mfr=0x${id.manufacturer.toString(16)} dev=0x${id.device.toString(16)}`);

// 3. Dump 512 KB.
const dump = await readFullFlash({
  device: '/dev/cu.usbserial-XXXX',
  baud: 19200,
  defaultTimeoutMs: 5000,
});
await fs.writeFile('dump.bin', dump);

// 4. Write 512 KB (this is destructive).
const image = await fs.readFile('modified.bin');
const result = await writeFullFlash(image, {
  device: '/dev/cu.usbserial-XXXX',
  baud: 19200,
  defaultTimeoutMs: 5000,
});
console.log(result); // { verified: true }
```

## How it works (the short version)

1. **Power on the bench-wired ECU with BOOT pin grounded** — the C167
   mask ROM enters BSL instead of jumping to flash, listens on ASC0
   for the auto-baud calibration byte.
2. **Host sends `0x00`** — the BSL uses its bit pattern
   (`0 00000000 1`) to measure the bit time and configure its UART
   divider to the host's chosen baud.
3. **BSL replies with the C16x derivative ID byte** — `0xC5` for the
   C167CR in MS42/MS43, `0xAA` for the C167 used in ME 7.x.
4. **Host uploads exactly 32 bytes** (the `LOADK.hex` primary loader)
   byte-by-byte with echo verification — the BSL hard-caps at 32.
5. **BSL jumps to the primary** — primary reads the rest of the
   `MINIMONK.hex` stream, copies it to a larger RAM region, and jumps
   there. Each stage signals completion with a known ACK byte
   (`I_LOADER_STARTED = 0x01`, `I_APPLICATION_STARTED = 0x03`).
6. **MiniMon is now in charge** — the host uploads `A29F400B.hex` into
   RAM via `C_WRITE_BLOCK`, then drives erase/program through
   `C_CALL_FUNCTION` with `FC_UNLOCK` → `FC_ERASE` → `FC_PROG` →
   readback verify via `C_READ_BLOCK`.

Full protocol-level explanation in
[`docs/raw-ds2-flashing.md` §7](../../docs/raw-ds2-flashing.md) of the
parent repo.

## Provenance and licensing

The three bundled `.hex` files are unmodified copies from the MiniMon
v2.30 distribution by Christian Perschl, distributed by Infineon as
freeware. See [`bundled/README.md`](bundled/README.md) for full
provenance, license terms, and integrity details.

References:

- [MiniMon project page](http://www.perschl.at/minimon/)
- [Infineon AP16064 — MiniMon application note](https://www.infineon.com/assets/row/public/documents/10/47/ap1606412-minimon.pdf?fileId=db3a3043133ffd300113444e0b810219)
- [Infineon AP16012 — C16x Bootstrap Loader](https://www.infineon.com/dgdl/ap1601210_Bootstrap_Loader_IDB.pdf?fileId=db3a304318a6cd680118cb945a2140bc)
- [EcuProg7/C167BootTool](https://github.com/EcuProg7/C167BootTool) — independent open-source host implementation (GPL v3)

## Status

Code paths and tests are complete; **not yet validated against a real
bench ECU**. The first real-hardware run will be the user's; bring a
backup BIN and an extra ECU. The host-side code aborts on echo
mismatch, BSL-ID mismatch, or any handshake stage failure rather than
proceeding into a half-written state.
