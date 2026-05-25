# nfsx — BMW NFS / WinKFP reconstruction

TypeScript reconstruction of BMW's **NFS** (Nachfluss-System) flash-
programming toolchain, in the same family as
[`ncsx`](https://github.com/emdzej/ncsx) (NCS Expert / coding) and
[`inpax`](https://github.com/emdzej/inpax) (INPA / diagnostics).

> **Status**: v0.1.0 — read-only resolver demo. **Do not flash real
> ECUs with anything in this repo yet.** Misprogrammed ECUs can
> become permanent paperweights.

## Quick demo

```bash
$ node apps/cli/dist/cli.js plan --hwnr 4010581

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

The full part-number → IPO + Flash SGBD lookup chain is working
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

**Open:**
- Sample non-E46 SP-Daten drop to get the remaining 16
  `kmm_*.txt` file formats (E46 only ships `kmm_SIT.txt`).
- Empirically discover the 3 NFS-only CABI slot IDs
  (`CDHGetReferenzProgramm`, `CDHGetReferenzDaten`, `CDHDelay`) by
  running an NFS IPO through `@emdzej/inpax-cabi-provider` and
  catching the "unknown slot" exceptions — likely 0x60–0x65 since
  NCSEXPER's table ends near 0x5F.
- Confirm flash payload sourcing: the IPO calls
  `CDHGetReferenzProgramm` to fetch bytes the host loaded from
  somewhere. Trace where those bytes come from (probably the
  per-ECU `.DAT` / `.HWH` working files in `data/<SG>/`).
