# nfsx — BMW NFS / WinKFP reconstruction

TypeScript reconstruction of BMW's **NFS** (Nachfluss-System) flash-
programming toolchain, in the same family as
[`ncsx`](https://github.com/emdzej/ncsx) (NCS Expert / coding) and
[`inpax`](https://github.com/emdzej/inpax) (INPA / diagnostics).

> **Status**: pre-release at version `0.1.0`. The full IPO-driven
> flash pipeline is wired and validated against a bench BMW GS20
> (HWNR 7544721) via K+DCAN — dry-run + mock end-to-end paths are
> clean. A real-bench write has not yet been attempted.
> **`nfsx flash --write` can brick an ECU.** Read
> [`docs/first-flash-runbook.md`](docs/first-flash-runbook.md) before
> attempting one.

---

## Operator workflow

The full sequence from "I have a BMW ECU on a bench" to "verify
flash succeeded". Each step is read-only and idempotent up through
`backup`; `flash --write` is the only destructive command.

### 0. Install

```bash
git clone git@github.com:emdzej/nfsx.git
cd nfsx
pnpm install
pnpm -r build
pnpm link --global --filter @emdzej/nfsx-cli   # makes `nfsx` available on $PATH
```

You also need [`@emdzej/ediabasx`](https://github.com/emdzej/ediabasx)
installed + configured (its CLI manages the K+DCAN / SAE J2534 / ENET
transport). `nfsx` honors `~/.config/ediabasx/config.json` via the
shared `@emdzej/ediabasx-host-config` loader — configure that first.

### 1. Configure

Tell `nfsx` where your SP-Daten chassis drop lives:

```bash
nfsx configure
# Interactive — writes ~/.config/nfsx/config.json with the
# `spDaten` path. Suggested default: ~/Downloads/E46_v74.
```

Configure your EDIABAS-X transport (K+DCAN cable, baud, port).
See `@emdzej/ediabasx-cli` docs; the gist for K+DCAN at 9600 baud:

```json
// ~/.config/ediabasx/config.json
{
  "interface": "kdcan",
  "options": {
    "port": "/dev/cu.usbserial-A50285BI",
    "baudRate": 9600,
    "protocol": "uart",
    "initMode": "fast"
  }
}
```

### 2. Discover what's on the bench (offline lookups)

Given just an HWNR (BMW part number), resolve everything else:

```bash
nfsx plan --hwnr 7544721
```

```
Lookup: HWNR=7544721
SP-Daten: /Users/mjaskols/Downloads/E46_v74
Candidates: 1

SG_TYP: GD20
────────────
  Queried HWNR:   7544721
  KFCONF rows:    1
    variant 32/01:
      IPO:        10GD20.IPO
      Flash SGBD: 10GD20.PRG
      Working:    .HIS=GD20.HIS  .DAT=GD20.DAT  .DIR=GD20D.DIR  .HWH=GD20.HWH
      Flash files (2 ZB rows):
        ZB=7552754: 7544721A.0PA + A7552755.0DA  PIN=134 S=1 CS=S
        ZB=7552752: 7544721A.0PA + A7552753.0DA  PIN=134 S=1 CS=G
```

You can also enter via `--sg-typ GD20` or `--diag-addr 0x12`.
`--zb-alt <ZB>` adds an NPV-upgrade lookup ("what does BMW say I
should upgrade THIS ZB to?").

### 3. Read what's actually burned in the ECU

Three canonical reads, one IPO job each:

```bash
# Hardware identity (kennung + projekt code)
nfsx run ~/Downloads/E46_v74/sgdat/10GD20.ipo --job HW_REFERENZ --sgbd 10GD20

# Software identity (BMW part number, version, production date)
nfsx run ~/Downloads/E46_v74/sgdat/10GD20.ipo --job SG_IDENT_LESEN --sgbd 10GD20

# Application block (VIN, current ZB, last coding date, dealer history)
nfsx run ~/Downloads/E46_v74/sgdat/10GD20.ipo --job SG_AIF_LESEN --sgbd 10GD20
```

`nfsx run` opens the K+DCAN link, dispatches the named IPO job
through the same `cabimain` mechanism WinKFP uses, and prints all
`CDHSetCabdPar` values the IPO published. First read against a
cold ECU ~600 ms; subsequent reads ~300-500 ms.

### 4. Sanity-check against SP-Daten

Verify the `HW_REF_SG_KENNUNG` + `HW_REF_PROJEKT` you just read
matches what `nfsx plan` resolves. Cross-check the burned
`AIF_ZB_NR` against the ZB rows `plan` lists — they may diverge
on older units last flashed before the current SP-Daten was
issued. Informational; not blocking.

### 5. Capture an audit snapshot

Mirrors WinKFP's `REF.OUT` audit log + the IPO's `ZIF_BACKUP`
fallback identity region. **NOT a firmware backup** — it preserves
identity (VIN, ZB, SW, dealer codes, datestamps) for forensic
purposes only. See `docs/architecture.md` §11.6 for why BMW's
design doesn't include host-side firmware backup.

```bash
nfsx backup --hwnr 7544721 --output-dir ./backups
```

```
HWNR 7544721 → IPO=~/Downloads/E46_v74/sgdat/10GD20.IPO SGBD=10GD20
✓ backup saved → backups/7544721-7543058-2026-05-27T08-56-58Z.json
  ID_BMW_NR:  7544721
  AIF_ZB_NR:  7543058
  AIF_SW_NR:  7543059
  AIF_FG_NR:  WBAEP31060PE84104
  ZIF backup: G22 (on-ECU redundancy)
  ...
```

### 6. Dry-run the flash pipeline

Dry-run is the default; `--write` is opt-in. Always start with a
dry-run to surface PRECHECK / RESOLVE / BACKUP issues **before**
touching anything destructive.

```bash
nfsx flash --hwnr 7544721 --zb 7552752
```

`--hwnr` resolves the target IPO, the SGBD, the SWT IPO, the
per-SG working directory, and the firmware `.0PA` from SP-Daten.
`--zb` is only needed when the HWNR maps to multiple ZB rows
(use `nfsx plan --hwnr X` to list them).

```
HWNR 7544721 → SG_TYP=GD20 ZB=7552752
  IPO: ~/Downloads/E46_v74/sgdat/10GD20.IPO
  SGBD: 10GD20
  SWT: ~/Downloads/E46_v74/sgdat/00swtds2.ipo
  workingDir: ~/Downloads/E46_v74/data/GD20
  firmware: ~/Downloads/E46_v74/data/GD20/7544721A.0PA
  ▶ RESOLVE
    info: firmware: $REFERENZ G2210_0089D0 Q
    info: firmware: $CHECKSUMME 7029 R
  ✓ RESOLVE (54ms)
  ▶ PRECHECK
    info: HW_REFERENZ: kennung=G22 projekt=10_00
    info: SG_IDENT: bmwnr=7544721 sw=89 hw=29 prod=001264844
    info: SG_AIF: zb=7543058 sw=7543059 index=DA datum=13.11.04
    info: HWNR_MATCH: 7544721 == 7544721 ✓
  ✓ PRECHECK (~2.3s)
  ▶ BACKUP
    info: backup saved → backups/7544721-7543058-...json
  ✓ BACKUP (~1.4s)
  · PROGRAM skipped (dry-run)
  ▶ POSTCHECK
  ✓ POSTCHECK (0ms)

✓ flash complete
```

Anything that fails here must be resolved before `--write`.

### 7. The real flash *(destructive — read the runbook)*

**Stop. Walk through [`docs/first-flash-runbook.md`](docs/first-flash-runbook.md) first.**

When ready:

```bash
nfsx flash --hwnr 7544721 --zb 7552752 --write
```

`--no-backup` skips the BACKUP stage (otherwise: always taken).
`--no-verify` skips POSTCHECK (otherwise: always taken). The
operator opts out explicitly.

The PROGRAM stage pauses and prompts:

```
  ╔══════════════════════════════════════════════════════════════╗
  ║  ⚠  DESTRUCTIVE STAGE: PROGRAM                                ║
  ╚══════════════════════════════════════════════════════════════╝

  ECU SGBD:     10GD20
  Expected HWNR: 7544721
  IPO:          ~/Downloads/E46_v74/sgdat/10GD20.ipo
  Working dir:  ~/Downloads/E46_v74/data/GD20
  Payload:      256.0 KB across 4 region(s)

  ⚠ This will ERASE and REWRITE the ECU's flash memory.
  ⚠ A failure mid-transfer can BRICK the ECU.
  ⚠ The "backup" already taken is an AUDIT snapshot — NOT a brick-recovery image.

  Type "FLASH" to proceed, anything else to abort:
```

Type `FLASH` (case-sensitive, exact string) to commit. Anything
else aborts cleanly.

Estimated wall-clock at K+DCAN 9600 baud: ~5-10 minutes for a
256 KB payload (1024 × `FLASH_SCHREIBEN` calls + erase + verify).

### 8. Verify

Re-read identity and diff against the pre-flash backup:

```bash
nfsx verify --hwnr 7544721 --against ./backups/7544721-7543058-2026-05-27T08-56-58Z.json
```

```
HWNR 7544721 → IPO=~/Downloads/E46_v74/sgdat/10GD20.IPO SGBD=10GD20
Current ECU state:
  ID_BMW_NR            7544721
  AIF_ZB_NR            7552752
  AIF_SW_NR            7552753
  AIF_FG_NR            WBAEP31060PE84104
  HW_REF_SG_KENNUNG    G22
  HW_REF_PROJEKT       10_00

Diff vs ./backups/7544721-7543058-2026-05-27T08-56-58Z.json:
  AIF_ZB_NR            7543058 → 7552752
  AIF_SW_NR            7543059 → 7552753
```

If you re-flashed the same `.0PA` (recommended for a first
flash), the diff should be empty.

---

## Command reference

| Command | Purpose |
|---|---|
| `nfsx configure` | Interactive editor for `~/.config/nfsx/config.json` (SP-Daten path) |
| `nfsx plan --hwnr X` | SP-Daten lookup: HWNR → SG_TYP → IPO + SGBD + ZB-row flash files |
| `nfsx browse` | Full-screen ink TUI for HWNR exploration |
| `nfsx run <ipo> --job <name>` | Execute one IPO job (e.g. `HW_REFERENZ`) against a live ECU |
| `nfsx check --hwnr X` | Quick live-ECU sanity probe (HW_REFERENZ + SG_IDENT + SG_AIF + ZIF_BACKUP, no file write) |
| `nfsx backup --hwnr X` | Audit snapshot of ECU identity + `ZIF_BACKUP` to JSON |
| `nfsx flash --hwnr X` | **WinKFP / IPO-driven** flash pipeline; dry-run by default, `--write` to commit |
| `nfsx verify --hwnr X [--against backup.json]` | Re-read identity; optionally diff against a saved backup |
| `nfsx checksum -f file.bin [--rewrite]` | Verify or recompute MS42/MS43 firmware CRC-16/CCITT checksums (hardware-independent) |
| `nfsx directmode probe/read/write -d /dev/cu.X` | Raw DS2 flashing — IDENT → SEED/KEY → erase → write → verify. Full + calibration-only modes for MS42 / MS43 / GS20. |
| `nfsx bootmode probe/read/write -d /dev/cu.X` | **C167 BSL** bootmode flashing for bench-pulled MS42 / MS43 / ME 7.2. Uploads MiniMon, bypasses BMW firmware, writes full 512 KB. |
| `nfsx bootmode verify-bundle` | SHA-256 verify the bundled MiniMon binaries |

`flash` / `backup` / `verify` take `--hwnr` and derive everything
else from SP-Daten (target IPO, SGBD, SWT IPO, per-SG working
directory, firmware `.0PA`). Per-field overrides (`--ipo`,
`--swt`, `--sgbd`, `--firmware`, `--working-dir`) skip the auto-
resolve for that field — useful for non-standard layouts or
power-user flows.

All commands accept `--ediabas-config <path>` / `--interface <name>` /
`--serial-port <path>` / `--serial-baud <rate>` / `--gateway <host:port>`
overrides on top of the ediabasx config, plus `--mock-file <path>`
to bypass EDIABAS entirely (rehearsal / unit-test path).

---

## Documentation

| Doc | Content |
|---|---|
| [`docs/first-flash-runbook.md`](docs/first-flash-runbook.md) | Pre-flight checklist + firmware-decision matrix + failure modes. **Read before `nfsx flash --write`.** |
| [`docs/architecture.md`](docs/architecture.md) | Ghidra-verified lookup chain, slot table, `coapiKf*` map, `GD20Prog` walkthrough, `SG_PROGRAMMIEREN` flow, `.0PA` host-side model |
| [`docs/reverse-engineering.md`](docs/reverse-engineering.md) | What NFS is (vs. NCS Expert / INPA), original-binary layout, building-blocks-reuse table, resolved + open RE questions |

## Packages

| Package | Purpose |
|---|---|
| `@emdzej/nfsx-cli` | Operator CLI (the `nfsx` command above) |
| `@emdzej/nfsx-flash` | 5-stage IPO-driven `FlashSession` orchestrator (BMW WinKFP path) |
| `@emdzej/nfsx-flash-data` | `.0PA` / `.0DA` parser, S37 parser, memory-region builder, CRC32, MS42/MS43 firmware CRC-16/CCITT verify+rewrite |
| `@emdzej/nfsx-directmode` | Raw DS2 flashing for MS42 / MS43 / GS20 — IDENT → SEED/KEY → erase → write → verify, full + calibration modes |
| `@emdzej/nfsx-bootmode` | C167 silicon BSL bootmode flashing for bench-pulled MS42 / MS43 / ME 7.2 — bundles MiniMon (Perschl / Infineon) + AMD 29F400B driver |
| `@emdzej/nfsx-runtime` | NFS-specific CABI slot overrides on the inpax VM (file-I/O, BinBuf, ApiJobData, firmware-source iterator) |
| `@emdzej/nfsx-resolver` | SP-Daten lookup chain (HWNR → SG_TYP → IPO + SGBD + ZB rows) |
| `@emdzej/nfsx-data-files` | Per-format parsers for the SP-Daten text files (HWNR.DA2 / KFCONF10.DA2 / npv.dat / prgifsel.dat / SGIDC.AS2 / kmm_SIT.txt / `<SG>.DAT`) |
| `@emdzej/nfsx-fsc` | FSC / certificate manager (SWT IPO orchestration) |

The three flash paths cover different operating modes:

- **`nfsx flash`** (IPO-driven, via `nfsx-flash`) — what BMW WinKFP does.
  Resolves IPO + SGBD from SP-Daten via HWNR, drives the BEST/2 VM
  through the full `SG_PROGRAMMIEREN` flow. Use this for in-vehicle
  flashing against a stock ECU when you have the `.0PA` files BMW
  ships for the target HWNR.
- **`nfsx directmode`** (raw DS2, via `nfsx-directmode`) — talks the
  DS2 protocol directly against the ECU's normal diagnostic session
  (no SGBD / IPO), with per-ECU region tables. Use this for tuner
  BINs or when you need calibration-only flashes without the
  SP-Daten pipeline.
- **`nfsx bootmode`** (C167 BSL, via `nfsx-bootmode`) — what
  JMGarageFlasher / C167BootTool do. Bypasses BMW firmware entirely
  via the C167 mask-ROM bootstrap loader; uploads MiniMon into RAM
  and drives the AMD 29F400B flash chip directly. Bench-pull only;
  recovers bricked ECUs since it doesn't depend on existing firmware.

Built on top of [`@emdzej/inpax`](https://github.com/emdzej/inpax)
(IPO bytecode VM), [`@emdzej/ediabasx`](https://github.com/emdzej/ediabasx)
(wire transport), and [`@emdzej/ncsx`](https://github.com/emdzej/ncsx)
(CABI provider scaffold).
