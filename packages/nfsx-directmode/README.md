# @emdzej/nfsx-directmode

Direct DS2 flashing for BMW MS42 / MS43 engine ECUs and the GS20
transmission control unit over the K-line. Drives the ECU through
its **normal diagnostic session** (no IPO bytecode, no SGBD dispatch,
no boot-pin hardware setup): IDENT → SEED/KEY → erase → write →
verify, all from the host.

> ℹ️ This is the raw-DS2 path, not the BMW WinKFP path. For the
> IPO-driven flow that BMW's own tool uses (and that mirrors the BEST/2
> VM execution of the SG_PROGRAMMIEREN job), use `@emdzej/nfsx-flash`.
> For BSL bootmode flashing of bench-pulled ECUs, use
> `@emdzej/nfsx-bootmode`.

## What it gives you

- **DS2 framing primitives** (`encodeFrame`, `decodeFrame`, `calcXor`)
  — cross-checked against the EdiabasLib K+DCAN transport. `LEN` is
  the total frame length including `ADDR`; `XOR` covers offsets 0
  through the last data byte, inclusive of `ADDR`.
- **SEED/KEY auth** (`buildSeedRequestPayload`, `deriveKey`,
  `buildKeySubmitPayload`) — the BMW key derivation
  `key[i] = (seed[(nonce+i) mod seed[1]] + seed[18+i] + seed[41+i]) mod 256`
  for i=0..3, nonce in 1..23
- **Per-ECU region tables** for the DS2 write loop:
  - **MS42** — 1:1 BIN→ECU mapping; FULL = 3 regions; CALIBRATION = 32 KB data block at ECU `0x48000-0x4FFEF`
  - **MS43** — has a `+0x80000` BIN→ECU shift on the program region; FULL = 2 regions; CALIBRATION = 64 KB data block at ECU `0x70000-0x7FFEE`
  - **GS20** (TCU) — FULL = 320 KB across `0x90000-0x9FFFF` + `0xA0000-0xDFFFF`; CALIBRATION = 64 KB program block at `0x90000`
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

Protocol implementation and per-ECU region tables are complete. **Not
yet validated against real hardware from this codebase.** The regions
and DS2 protocol are well-understood for these ECUs; this is a
TypeScript implementation.

For real-hardware first runs, take a backup with `nfsx directmode read
--mode full` first, store it somewhere safe, and only attempt
calibration-only writes until you trust the flow against your specific
ECU sub-variant.
