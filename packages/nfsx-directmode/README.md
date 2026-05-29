# @emdzej/nfsx-directmode

Direct DS2 flashing for BMW MS42 / MS43 engine ECUs and the GS20
transmission control unit over the K-line — the same protocol surface
the open-source MS4x Flasher 1.6.0 implements. Drives the ECU through
its **normal diagnostic session** (no IPO bytecode, no SGBD dispatch,
no boot-pin hardware setup): IDENT → SEED/KEY → erase → write →
verify, all from the host.

> ℹ️ This is the "MS4x Flasher path", not the BMW WinKFP path. For the
> IPO-driven flow that BMW's own tool uses (and that mirrors the BEST/2
> VM execution of the SG_PROGRAMMIEREN job), use `@emdzej/nfsx-flash`.
> For BSL bootmode flashing of bench-pulled ECUs, use
> `@emdzej/nfsx-bootmode`.

## What it gives you

- **DS2 framing primitives** (`encodeFrame`, `decodeFrame`, `calcXor`)
  — verified against the MS4x Flasher frame builder (`ᄁ/A/A.cs:147-165`)
  and the EdiabasLib K+DCAN transport. `LEN` is the total frame length
  including `ADDR`; `XOR` covers offsets 0 through last data byte
  inclusive of `ADDR`. (The doc previously claimed the opposite; both
  the code here and the doc are now correct.)
- **SEED/KEY auth** (`buildSeedRequestPayload`, `deriveKey`,
  `buildKeySubmitPayload`) — the BMW key derivation
  `key[i] = (seed[(nonce+i) mod seed[1]] + seed[18+i] + seed[41+i]) mod 256`
  for i=0..3, nonce in 1..23
- **Per-ECU region tables**, all sourced from MS4x Flasher's per-variant
  protocol classes:
  - **MS42** (`ᄁ/A/T.cs:873` — `t::A` / `t::a`) — 1:1 BIN→ECU mapping;
    FULL = 3 regions; CALIBRATION = upper region only
  - **MS43** (`ᄁ/A/T.cs:360` — `T::A` / `T::a`) — has a `+0x80000`
    BIN→ECU shift on the program region
  - **GS20** (`ᄁ/A/R.cs:813` — `r::A` / `r::a`) — TCU variant; FULL =
    320 KB across two regions (`0x90000+0x9FFFF`, `0xA0000+0xDFFFF`)
    sourced from BIN `0x10000+0x5FFFF`; CALIBRATION = 64 KB program
    block at `0x90000`
- **ECU detection** (`identifyEcu`) — heuristic match against IDENT
  signature substrings; the session probes both `0x12` (MS-class) and
  `0x32` (TCU) addresses when `--variant` isn't forced
- **Serial transport** (`NodeDirectModeTransport`) — **9600 8E1** (DS2
  default), no flow control, TX-with-echo-verify primitive
- **Session orchestrators** — `probe`, `readFlash`, `writeFlash` with
  status-byte polling (the `0xA1` pending-retry pattern) and `0xFF`
  skip optimisation in the write loop

## Install

```bash
pnpm add @emdzej/nfsx-directmode
```

CLI front-end lives in `@emdzej/nfsx-cli` (`nfsx directmode …`); see
the parent [README](../../README.md) and `nfsx directmode --help`.

## Programmatic usage

```ts
import {
  probe,
  readFlash,
  writeFlash,
} from '@emdzej/nfsx-directmode';

// 1. Probe — IDENT + ECU type detection.
const id = await probe(
  { device: '/dev/cu.usbserial-XXXX', baud: 9600, defaultTimeoutMs: 3000 },
  (p) => console.error(`[${p.stage}] ${p.message}`),
);
console.log(id);  // { variant: 'MS43', identAscii: '...' }

// 2. Read flash in FULL mode (all writable regions; ~256-360 KB
// depending on variant).
const { variant, image } = await readFlash(
  { device: '/dev/cu.usbserial-XXXX', baud: 9600, defaultTimeoutMs: 5000 },
  { mode: 'full' },
);
await fs.writeFile(`${variant}-dump.bin`, image);

// 3. Read calibration-only — much faster, just the data block.
const cal = await readFlash(
  { device: '/dev/cu.usbserial-XXXX', baud: 9600, defaultTimeoutMs: 5000 },
  { mode: 'calibration' },
);

// 4. Write — DESTRUCTIVE. nonce defaults to 7 (any value 1..23 works).
const bin = await fs.readFile('modified.bin');
const result = await writeFlash(
  bin,
  { device: '/dev/cu.usbserial-XXXX', baud: 9600, defaultTimeoutMs: 5000 },
  { mode: 'calibration', skipVerify: false, nonce: 7 },
);
console.log(result);
// { variant: 'MS43', mode: 'calibration', bytesWritten, bytesSkipped, verified }
```

## Full vs calibration mode

The mode flag picks which subset of the ECU's flash gets rewritten:

| Variant | FULL | CALIBRATION |
|---|---|---|
| MS42 | 3 regions covering `0x11000-0x3FFFF`, `0x48000-0x4FFEF`, `0x5002C-0x7FFFF` | upper region `0x5002C-0x7FFFF` only |
| MS43 | 2 regions (ECU `0x90000-0xEFFEF` from BIN `0x10000` with `+0x80000` shift; ECU `0x70000-0x7FFEF` 1:1) | upper region only |
| GS20 | 2 regions (ECU `0x90000-0x9FFFF` + `0xA0000-0xDFFFF` from BIN `0x10000-0x5FFFF`) | program block `0x90000-0x9FFFF` only |

For any variant, `--mode calibration` is significantly faster (skips
the unchanged program region), but only useful if you've authored your
BIN with the program region unchanged from the original.

If a third-party-authored BIN has modified checksums or CRC tables
that the ECU validates on boot, pair this with the
`--calculate-checksum` flag on the CLI (or call `verifyMs4xChecksums`
+ `rewriteMs4xChecksums` from `@emdzej/nfsx-flash-data`) to recompute
them before flashing.

## Status

The code paths are complete; the protocol implementation tracks MS4x
Flasher's source byte-for-byte. **Not yet validated against real
hardware from this codebase.** The MS4x Flasher itself has been
exercised against MS42 / MS43 / GS20 by the community, so the regions
and protocol are well-understood; this is a TypeScript port.

For real-hardware first runs, take a backup with `nfsx directmode read
--mode full` first, store it somewhere safe, and only attempt
calibration-only writes until you trust the flow against your specific
ECU sub-variant.
