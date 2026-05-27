# Reverse-engineering notes — what NFS is, why it's reconstructable

Background material for anyone working on `nfsx`. The product
README covers operator use; this doc captures the BMW-side
context that drove the implementation choices.

For Ghidra-verified specifics (lookup chain, slot table walks,
GD20Prog trace, `.0PA` host-side flow), see
[`docs/architecture.md`](architecture.md). For the destructive-write
runbook see [`docs/first-flash-runbook.md`](first-flash-runbook.md).

---

## What NFS is

`winkfpt.exe` (BMW **W**indows **K**ennfeld-**F**eld-**P**rogrammierung,
"Windows field-data programming") is the dealer-level tool for
**rewriting an ECU's firmware**. Where NCS Expert edits *coding*
(the per-vehicle option bits stored in EEPROM) and INPA reads
*diagnostics*, NFS writes the *program memory itself* — the
binary blob the ECU executes.

The original NFS install lives at
`/Users/mjaskols/Downloads/inpa/EC-APPS/NFS/` and is treated as
read-only reference data.

## Why it's reconstructable

NFS uses the **same building blocks** as the other two tools:

- **IPO bytecode** — per-ECU logic in BMW's BEST/2 VM, byte-for-byte
  the same format `inpax-parser` already reads (header version
  `1.3` for NFS vs `1.0` for NCS Expert is the only diff). NFS IPOs
  disassemble cleanly through `@emdzej/inpax-disassembler` without
  any code changes.
- **CABI host layer** (`Cabiger.dll`) — the same syscall-dispatched
  VM-host bridge as NCS Expert. Many slots are shared; some are
  flash-specific (Authentication, Certificate, FSC).
- **EDIABAS / KWP / UDS transports** — the wire layer is the same
  family `ediabasx` already implements.

The only genuinely new pieces are the **flash orchestration layer**
(`coapiKfProgSgD2` and friends) and the **`.0PA` / `.0DA` data
files** (Intel-HEX dialect with BMW wrappers).

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
├── DATA/<SG_TYP>/
│       — per-SG flash payloads + mapping table:
│       — `<SG_TYP>.DAT` — ZB-NR → (HW-NR, SW-NR) mapping
│       — `<HW-NR>A.0PA` — Intel-HEX program firmware
│       — `A<SW-NR>.0DA` — Intel-HEX calibration data
│       — `<SG_TYP>.HIS/.DAT/.HWH/.DIR` — per-SG working files
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

| Concern | NFS component | Existing reusable package | nfsx new work |
|---|---|---|---|
| IPO bytecode parsing | (built into Cabiger.dll) | `@emdzej/inpax-parser` | — |
| IPO bytecode VM | Cabiger.dll | `@emdzej/inpax-interpreter` | NFS slot overrides (file-I/O, BinBuf*, ApiJobData, ApiJobByteData) — all in `@emdzej/nfsx-runtime` |
| CABI host syscalls | Cabiger.dll | `@emdzej/ncsx-inpax-cabi-provider` (partial) | NFS-specific overrides — in `@emdzej/nfsx-runtime` |
| Disassembly | (none — internal) | `@emdzej/inpax-disassembler` | — |
| Decompilation (IPO → IPS) | (none — internal) | `@emdzej/inpax-decompiler` | — |
| Wire transport (KWP / DCAN / ENET) | EDIABAS DLLs | `@emdzej/ediabasx` | — |
| Coding data files (CABD / ASW) | Cabiger.dll | `@emdzej/ncsx-cabd`, `@emdzej/ncsx-daten` | — (NFS reuses these formats) |
| SP-Daten tables (HWNR / KFCONF / NPV) | (built into KmmSrv.dll + nfs.exe) | — | `@emdzej/nfsx-data-files` |
| Per-SG ZB-NR mapping (`<SG>.DAT`) | (built into nfs.exe) | — | `@emdzej/nfsx-data-files` |
| SP-Daten lookup chain | (built into nfs.exe) | — | `@emdzej/nfsx-resolver` |
| `.0PA` / `.0DA` parser | (host-side in winkfpt) | — | `@emdzej/nfsx-flash-data` |
| FSC / certificate operations | flash IPOs + KmmSrv | — | `@emdzej/nfsx-fsc` |
| Flash session orchestrator | `coapiKfProgSgD2` in winkfpt | — | `@emdzej/nfsx-flash` |
| Operator CLI | winkfpt.exe + nfs.exe | — | `@emdzej/nfsx-cli` |

So a working `nfsx` reuses the entire IPO + VM + transport stack
already shipped, and the genuinely new work is:

1. The **`.0PA` / `.0DA` parser** — BMW's Intel-HEX dialect with
   text header/footer + multi-record archives.
2. The **flash orchestration** — single `SG_PROGRAMMIEREN` IPO
   dispatch with pre-loaded firmware-record iterator (mirrors
   WinKFP's `coapiKfProgSgD2` flow — see `architecture.md` §11.8).
3. The **NFS-specific CABI slot overrides** in `nfsx-runtime` —
   file-I/O, BinBuf family, ApiJobData (binary param), ApiJobByteData
   (firmware iterator).
4. The **safety / dry-run model** — five-stage pipeline
   (RESOLVE / PRECHECK / BACKUP / PROGRAM / POSTCHECK) with explicit
   destructive-stage confirmation. See `first-flash-runbook.md`.

Full Ghidra-verified breakdown of the lookup chain + slot table +
flash flow in [`architecture.md`](architecture.md).

## Resolved / open investigation targets

Most of the big unknowns are answered. Detail in
[`architecture.md §7`](architecture.md#7-investigation-targets).

**Resolved (the major ones):**

- **`KmmSrv.dll` is a COM/IDispatch planner**, not a binary file
  parser. Exposes `CConfiguration` / `CPlan` / `CPlanElement` via
  three ProgIDs in the `KmmServer4_31_1.*` namespace. Not on the
  critical path for `nfsx-flash`.
- **`.DA2` / `.AS2` files are plaintext.** The whole BMW data layer
  above the IPO bytecode is line-oriented text with `;` comments +
  `$` directives. Format reference in `architecture.md §9.2`.
- **The lookup chain** `HWNR → KFCONF → SGIDC → kmm_SIT → npv →
  prgifsel` is fully traced from real SP-Daten samples
  (`architecture.md §9.1`).
- **The C-side coding API in `winkfpt.exe`** is fully mapped via
  Ghidra (~40 `coapiKf*` functions) — `architecture.md §11`.
- **The AIF (After-Information-File) protocol** — post-flash
  identity stamp — is enumerated (`architecture.md §9.4`).
- **CABI slot table is drop-in compatible** — all 1798 NFS IPOs
  scanned, zero unknown syscall slots. NFS IPOs use the same slot
  IDs as INPA / NCSEXPER. `architecture.md §9.5`.
- **The `coapiKfProgSgD2` flash flow** is fully decomposed
  (`architecture.md §11.8`) — single `SG_PROGRAMMIEREN` IPO dispatch
  with cabd-par preamble. The IPO's `GD20Prog` body
  (`architecture.md §11.9`) shows the per-block `while (NrOfData > 0)`
  loop driven by slot 0x55.
- **Slot 0x55 semantic** — NCSEXPER labels it "drain SGBD result";
  NFS reuses it as the **firmware-record iterator** that pops one
  chunk per call from the host-opened `.0PA` (`architecture.md §11.9`,
  resolved 2026-05-27).
- **Host-side `.0PA` opener** — `datDekompOpen` (FUN_00468220 in
  winkfpt.exe) with `_fopen(path, "rb")` + `dlReadRecord`
  (FUN_0046c510) for per-record reads (`architecture.md §11.7`).
- **Cross-frame `Scope.Local` ref bug** — surfaced via
  `SG_PROGRAMMIEREN`'s `TestApiFehlerNoExit` helper; fixed in
  `@emdzej/inpax-interpreter@0.8.1` (`architecture.md §11.10`).

**Open / deferred:**

- Sample non-E46 SP-Daten drops to get the remaining 16 `kmm_*.txt`
  file formats (E46 only ships `kmm_SIT.txt`).
- KMM-managed flash payloads (`KMMDAT/<chassis>/`) — currently
  bypassed by the per-SG `.0PA` flow which works without them.
- Multi-ECU batch flash (`BATCH/*.CTL` templates) — not needed for
  single-bench-ECU work.
- Real bench-write validation — wired but not yet attempted; see
  [`first-flash-runbook.md`](first-flash-runbook.md).
