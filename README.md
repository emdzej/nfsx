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
installed + configured (its CLI manages the K+DCAN/ENET transport).
`nfsx` honors `~/.config/ediabasx/config.json` — configure that first.

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
nfsx backup \
  --ipo  ~/Downloads/E46_v74/sgdat/10GD20.ipo \
  --sgbd 10GD20 \
  --expected-hwnr 7544721 \
  --output-dir ./backups
```

```
✓ backup saved → backups/7544721-7543058-2026-05-27T08-56-58Z.json
  ID_BMW_NR:  7544721
  AIF_ZB_NR:  7543058
  AIF_SW_NR:  7543059
  AIF_FG_NR:  WBAEP31060PE84104
  ZIF backup: G22 (on-ECU redundancy)
  ...
```

### 6. Dry-run the flash pipeline

`--dry-run` is the default; `--write` is opt-in. Always start
with a dry-run to surface PRECHECK / RESOLVE / BACKUP issues
**before** touching anything destructive.

```bash
nfsx flash \
  --swt       ~/Downloads/E46_v74/sgdat/00swtds2.ipo \
  --ipo       ~/Downloads/E46_v74/sgdat/10GD20.ipo \
  --sgbd      10GD20 \
  --firmware  ~/Downloads/E46_v74/data/GD20/7544721A.0PA \
  --expected-hwnr 7544721
```

```
  ▶ RESOLVE
    info: firmware: $REFERENZ G2210_0089D0 Q
    info: firmware: $CHECKSUMME 7029 R
  ✓ RESOLVE (54ms)
    info: firmware: 4 region(s), 262016 bytes total
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
nfsx flash \
  --swt       ~/Downloads/E46_v74/sgdat/00swtds2.ipo \
  --ipo       ~/Downloads/E46_v74/sgdat/10GD20.ipo \
  --sgbd      10GD20 \
  --firmware  ~/Downloads/E46_v74/data/GD20/7544721A.0PA \
  --expected-hwnr 7544721 \
  --write
```

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

Compare post-flash identity reads against the pre-flash snapshot:

```bash
nfsx run ~/Downloads/E46_v74/sgdat/10GD20.ipo --job HW_REFERENZ    --sgbd 10GD20
nfsx run ~/Downloads/E46_v74/sgdat/10GD20.ipo --job SG_IDENT_LESEN --sgbd 10GD20
nfsx run ~/Downloads/E46_v74/sgdat/10GD20.ipo --job SG_AIF_LESEN   --sgbd 10GD20
```

If you re-flashed the same `.0PA` (recommended for a first
flash), all three reads should match the pre-flash snapshot.

---

## Command reference

| Command | Purpose |
|---|---|
| `nfsx configure` | Interactive editor for `~/.config/nfsx/config.json` (SP-Daten path) |
| `nfsx plan --hwnr X` | SP-Daten lookup: HWNR → SG_TYP → IPO + SGBD + ZB-row flash files |
| `nfsx browse` | Full-screen ink TUI for HWNR exploration |
| `nfsx run <ipo> --job <name> --sgbd <name>` | Execute one IPO job (e.g. `HW_REFERENZ`) against a live ECU |
| `nfsx backup --ipo … --sgbd …` | Audit snapshot of ECU identity + `ZIF_BACKUP` to JSON |
| `nfsx flash --swt … --ipo … --sgbd … --firmware …` | Full 5-stage flash pipeline; dry-run by default, `--write` to commit |

All commands accept `--ediabas-config <path>` / `--interface <name>` /
`--serial-port <path>` / `--serial-baud <rate>` / `--gateway <host:port>`
overrides on top of the ediabasx config, plus `--mock-file <path>`
to bypass EDIABAS entirely (rehearsal / unit-test path).

`--working-dir <dir>` overrides the per-SG data directory used by
the IPO's `fileopen` syscalls and the firmware-source iterator
(default: derived from the IPO path as `<sp-daten>/data/<SG_TYP>/`).

---

## Quick reference (the old "quick demo")

```bash
$ nfsx plan --hwnr 4010581

Lookup: HWNR=4010581
SP-Daten: ~/Downloads/E46_v74
Candidates: 1

SG_TYP: ACC65
─────────────
  Queried HWNR:   4010581
  Known HWNRs:    8
  KFCONF rows:    1
    variant 21/01:
      IPO:        25ACC65.IPO
      Flash SGBD: 02FLASH.PRG
      Working:    .HIS=ACC65.HIS  .DAT=ACC65.DAT  .DIR=ACC65D.DIR  .HWH=ACC65.HWH
```

The full part-number → IPO + Flash SGBD lookup chain is validated
against real BMW E46 SP-Daten. 100% join coverage between
`HWNR.DA2` (3763 rows) and `KFCONF10.DA2` (237 SG_TYPs).

## What NFS is

`winkfpt.exe` (BMW Windows-Kennfeld-Programmierung, "field-data
programming") is the dealer-level tool for **rewriting an ECU's
firmware**. Where NCS Expert edits *coding* (the per-vehicle option
bits stored in EEPROM) and INPA reads *diagnostics*, NFS writes the
*program memory itself* — the binary blob the ECU executes.

The original NFS install lives at
`/Users/mjaskols/Downloads/inpa/EC-APPS/NFS/` and is treated as
read-only reference data.

## Why it's reconstructable

NFS uses the **same building blocks** as the other two tools:

- **IPO bytecode** — per-ECU logic in BMW's BEST/2 VM, byte-for-byte
  the same format `inpax-parser` already reads (header version
  `1.3` for NFS vs `1.0` for NCS Expert is the only diff). NFS IPOs
  disassemble cleanly through `@emdzej/inpax-dis` without any code
  changes.
- **CABI host layer** (`Cabiger.dll`) — the same syscall-dispatched
  VM-host bridge as NCS Expert. Many slots are shared; some are
  flash-specific (Authentication, Certificate, FSC).
- **EDIABAS / KWP / UDS transports** — the wire layer is the same
  family `ediabasx` already implements.

The only genuinely new pieces are the **KMM data format** (per-I-Stufe
flash payloads) and the **flash orchestration layer** (`nfs.exe`'s
batch/sequence engine that coordinates which ECUs get which
firmware).

## Reference: the original layout

```
EC-APPS/NFS/
├── BIN/
│   ├── winkfpt.exe      (4.1 MB)  — flash GUI + embedded CABI VM + flash engine
│   ├── nfs.exe          (929 KB)  — orchestrator, multi-channel manager
│   ├── KmmSrv.dll       (131 KB)  — Kennfeld-Manager (KMM data layer)
│   ├── Cabiger.dll      (59 KB)   — German UI strings / dialogs (resource DLL)
│   ├── CabUS.dll        (56 KB)   — US-English UI strings / dialogs (resource DLL)
│   ├── nfsunzip.dll              — KMM payload decompression
│   ├── NFS.INI / Winkfpt.ini      — runtime config
│   └── *.chm                       — help files (German + English)
├── SGDAT/    (~1960 files, mostly .ipo)
│       — per-ECU IPOs. Three flavours coexist:
│       — NCSEXPER-style coding (`A_*.ipo`)
│       — NFS-flash SWT IPOs (`00swt*.ipo`) — Authenticate/Fsc/Cert ops
│       — INPA-style diagnostic IPOs (e.g. `msd80n43.ipo`) — error memory
├── KMMDAT/<chassis>/I_STUFE/<istufe-code>/
│       — per-I-Stufe flash payloads + manifests
│       — chassis: E60, E65, E70, E89X, R56, RR1
│       — I-Stufe = BMW integration level (e.g. "E060-12-03-560")
├── DATA/GDATEN/
│       — global tables: KFCONF, HWNR, NPV, PRGIFSEL, SGIDC, SGIDD
├── BATCH/   FLASH.CTL, FLASH_1/2/3.CTL, FLASHBSP.CTL
│       — flash sequence templates
├── CFGDAT/  COAPI.INI, AKTION.DAT, I_STUFE.DAT, ID_CHECK.DAT, …
│       — coding API config + I-Stufe lookups
├── TRACE/   ID.TRC, FA.TRC, KMM.TRC, ERROR.TRC, FZG.TMP, ZB.TMP
│       — runtime logs (created on first run)
├── FORMAT/   plotting format templates
├── DOKU/     documentation
└── WORK/     scratch space (mostly empty)
```

## Where the building blocks live

| Concern | NFS component | Existing reusable package | New work |
|---|---|---|---|
| IPO bytecode parsing | (built into Cabiger.dll) | `@emdzej/inpax-parser` ✅ | — |
| IPO bytecode VM | Cabiger.dll | `@emdzej/inpax` (interpreter) ✅ | NFS-specific syscalls |
| CABI host syscalls | Cabiger.dll | `@emdzej/inpax-cabi-provider` partial | KmmSrv-equivalent + Auth/FSC/Cert syscalls |
| Disassembly | (none — internal) | `@emdzej/inpax-dis` ✅ | — |
| Wire transport (KWP/UDS) | EDIABAS DLLs | `@emdzej/ediabasx` ✅ | possibly UDS programming session |
| Coding data files (CABD/ASW) | Cabiger.dll | `@emdzej/ncsx-cabd`, `@emdzej/ncsx-daten` ✅ | — (NFS reuses these formats) |
| **KMM flash payloads** | KmmSrv.dll | — | **new package** |
| **I-Stufe registry** | NFS.INI + I_STUFE.DAT | — | **new package** |
| **Flash batch / sequence** | nfs.exe + BATCH/*.CTL | — | **new package** |
| **FSC / certificate management** | flash IPOs + KmmSrv | — | **new package** |
| Orchestration UI | winkfpt.exe + nfs.exe | (per-app UI in ncsx-web style) | **new app** |

So a working `nfsx` reuses the entire IPO + VM + transport stack
already shipped, and the genuinely new work is:

1. The **KMM data format** (none of the `.DA2` / `.as2` / `.dat` flash
   files have been parsed yet)
2. The **flash orchestration** (batch sequences, I-Stufe selection,
   pre/post checks)
3. The **NFS-specific CABI syscalls** that don't appear in NCSEXPER's
   syscall set (Authentication, FSC, Certificate, GetTime/SetTime)
4. The **safety / dry-run model** — flashing is irreversible; the UI
   needs to be much more guarded than ncsx's coding flow

Full breakdown in [`docs/architecture.md`](docs/architecture.md).
The Ghidra-verified lookup chain (with sample table content per
data file) is in [`§9`](docs/architecture.md#9-the-lookup-chain-ghidra-verified-2026-05-25).

## Resolved / open investigation targets

Most of the big unknowns are answered (see
[`docs/architecture.md §7`](docs/architecture.md#7-investigation-targets) for the full list):

**Resolved:**
- `KmmSrv.dll` is a COM/IDispatch planner — not a binary file
  parser. Exposes `CConfiguration` / `CPlan` / `CPlanElement` via
  three ProgIDs in the `KmmServer4_31_1.*` namespace.
- `.DA2` / `.AS2` files are **plaintext**, not binary. The whole
  BMW data layer above the IPO bytecode is line-oriented text with
  `;` comments + `$` directives. Format reference in `§9.2`.
- The lookup chain `HWNR → KFCONF → SGIDC → kmm_SIT → npv →
  prgifsel` is fully traced from real SP-Daten samples.
- The C-side coding API in `winkfpt.exe` is partially named via
  Ghidra (`coapiKfProgSgDevelopWithAif`, `coapiRunIpoJob`,
  `coapiSetCabdParByName`, etc. — `§9.3`).
- The AIF (After-Information-File) protocol — the post-flash
  identity stamp — is enumerated (`§9.4`).

**Resolved (cont'd):**
- **CABI slot table: drop-in compatible.** All 1798 NFS IPOs
  scanned, zero unknown syscall slots. NFS IPOs use the same slot
  IDs as INPA / NCSEXPER. The 3 syscall names that appeared in
  winkfpt.exe strings are host-side-only — not called from any
  IPO. `§9.5` for details.

**Open:**
- Sample non-E46 SP-Daten drop to get the remaining 16
  `kmm_*.txt` file formats (E46 only ships `kmm_SIT.txt`).
- Confirm flash payload sourcing: where do flash bytes get
  loaded into winkfpt's host buffers (probably the per-ECU
  `.DAT` / `.HWH` working files in `data/<SG>/`). Not blocking
  the read-only flows but needed for Phase 5.
