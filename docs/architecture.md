# nfsx architecture — reconstruction plan

How BMW NFS (`winkfpt.exe` + `nfs.exe` + `KmmSrv.dll` + `Cabiger.dll`)
is built, and how a TypeScript reconstruction would compose against
the building blocks `ncsx` and `inpax` already ship.

## 1. The three-tool BMW dealer toolchain

BMW's dealer-tool suite ships three programs that share a common
bytecode VM and transport stack but specialize at the top:

| Tool | Edits | EXE | Repo equivalent |
|---|---|---|---|
| **INPA**  | nothing — reads diagnostics, runs interactive ECU tests | `INPA.exe` | [`inpax`](https://github.com/emdzej/inpax) |
| **NCS Expert** | coding (per-vehicle option bits in EEPROM/flash) | `NCSEXPER.exe` | [`ncsx`](https://github.com/emdzej/ncsx) |
| **NFS / WinKFP** | program memory (the firmware itself) | `winkfpt.exe` + `nfs.exe` | **`nfsx`** (this repo) |

They share:

- The **IPO bytecode language** (BMW's BEST/2 VM) — per-ECU logic
  shipped as `.ipo` files
- The **CABI host layer** — the C-side dispatcher that runs IPO
  functions and exposes a syscall surface to them (slot 0x05 =
  `setjobstatus`, slot 0x0D = `CDHapiJob`, slot 0x2C =
  `CDHSetSystemData`, etc.)
- The **EDIABAS layer** — wire transport (K-line, KWP1281, KWP2000,
  UDS, CAN, MOST, Ethernet/ENET) shipped as SGBD `.prg` files
- Many of the per-ECU `A_*.ipo` files literally appear in all three
  installs (NFS bundles ~all of NCS Expert's coding IPOs since flash
  programming needs to read/write coding too)

What differs per tool is the **mix of syscalls the IPOs invoke** +
the **host-side data formats** that gate the IPO dispatch.

## 2. NFS components (mapped to layers)

### 2.1 `winkfpt.exe` — the flash GUI (4.1 MB)

The main user-facing program. Loads:
- An I-Stufe (integration level) selection — which firmware bundle
  to apply to which chassis
- A KMM file per ECU — the flash payload + manifest
- An IPO per ECU — the per-ECU flash routines (Authenticate, Erase,
  Program, Verify, …)

Then walks a flash sequence script (`BATCH/FLASH.CTL`) coordinating
which ECUs get programmed in what order.

Configured via `Winkfpt.ini`. Key flags:

```ini
U_PROG=ON                       ; user programming enabled
SCHNELLE_BAUDRATE=OFF           ; "fast baudrate" — high-speed KWP/UDS mode
TEST_CHECKSUMME=ON              ; verify flash checksum after write
AIF_SCHREIBEN_NACH_DATEN=ON     ; write AIF (After-Programming Info File) after data flash
CabdFormat=IPO                  ; consume compiled IPOs (vs IPS source)
```

Three CabdFormat modes (`IPS` = source / `IPO` = compiled / `COM` =
compile-then-run) tell us BMW devs sometimes drive WinKFP with
uncompiled IPS source — same source language `@emdzej/inpax`'s
compiler-core handles.

### 2.2 `nfs.exe` — the orchestrator (929 KB)

Above WinKFP. Manages:
- Multi-channel programming (`MEHRKANAL=JA` in `NFS.INI`) — multiple
  ECUs in parallel over different bus interfaces
- Chassis matrix (`[BAUREIHENMATRIX]`) — maps physical chassis codes
  to KMM data folders (`E61→E60`, `E81→E89X`, etc.)
- Trace files — `ID.TRC`, `FA.TRC`, `KMM.TRC`, `ERROR.TRC`,
  `FZG.TMP`, `ZB.TMP`
- Trailer profiles (separate flash configs for trailers — `TRAILERMODUS`)
- ZB-Nummer (Zentralenummer / central number) lookup as fallback when
  ID-Nummer fails

This is the layer that knows "the customer wants their E60 brought
to I-Stufe E060-12-03-560; here's the sequence of ECUs and KMM files
that requires."

### 2.3 `KmmSrv.dll` — KMM COM server (131 KB) — the flash planner

**Confirmed via Ghidra (2026-05-25)**: this is not a binary file
parser; it's a **flash-planning engine** exposed as a COM/IDispatch
server.

- Built with **MFC + COM**. Exports only `DllGetClassObject`,
  `DllCanUnloadNow`, `DllRegisterServer`, `DllUnregisterServer`
  (hence the `REGSVR32.BAT` in the install). All real verbs are COM
  methods on three classes.
- Original filename: `KmmServer4311.dll`. ProgIDs:
  `KmmServer4_31_1.Configuration` and `KmmServer4_31_1.Module`.
- Heavy use of `COleDispatchDriver` + `COleObjectFactory` — winkfpt
  drives it through `IDispatch::Invoke`, not direct vtable calls.
- Three operational modes: `KMM_MODE_SERVICE_OFFLINE`,
  `KMM_MODE_SERVICE_ONLINE`, `KMM_MODE_ASSEMBLY` — switches between
  diagnostic-mode flash, online ("hot") flash, and factory-line
  assembly flash.

#### 2.3.1 The COM API

**`CConfiguration` (`KmmServer4_31_1.Configuration`)** — the main
entry point. winkfpt creates one of these per flash session.

| Property/method | Purpose |
|---|---|
| Properties `VehicleType`, `BuildLevel`, `GoalLevel`, `LackCode`, `PolsterCode`, `SaCount` | Vehicle-level inputs (current type/level, target level, paint/upholstery, # of SA codes) |
| `SetCurrentConfig` / `SetFutureConfig` | Set current and target ECU configurations |
| `Query` / `TestConsistency` | Validate the configuration against KMM knowledge base |
| `GetCurrentState` / `GetSWTCurrentState` / `GetProblemAddress` | Diagnose current vs. desired state |
| `GetFirst/NextPossibleAddress`, `GetFirst/NextExpectedAddress` | Iterate addressable ECUs |
| `GetFirst/NextMissingContext`, `InvalidateContext` | Required-context inputs that aren't yet set |
| `GetFirst/NextPlan`, `HasTrivialPlan` | Iterate computed flash plans |
| `SetActionContextElement`, `SetFlags`, `State`, `Close` | Session control |
| `GetLastFullRelease`, `GetGroupIdentifier` | Metadata |
| `KmmVersion` / `KmmLongVersion` | Read-only version strings (e.g. `"4.31.1"`) |

**`CModule` (`KmmServer4_31_1.Module`)** — per-ECU object returned
by the address iterators. (Less methods visible from string scan; to
be enumerated.)

**`CPlan`** — the output of `GetFirst/NextPlan`. Iterates via
`GetFirstPlanElement` / `GetNextPlanElement`.

**`CPlanElement`** — one step in the flash plan. Properties:

| Property | Purpose |
|---|---|
| `DiagAddr` | Target ECU's diagnostic address (e.g. `0x12` for LSZ on E46) |
| `Action` | What to do — observed values in log strings: `SWT Import FSC`, `SWT Deactivate`, `SWT Activate`, plus presumably `Flash`, `Mount`, `Replace`, `Keep` |
| `FlashFlags` | Per-action flags |
| `FlashIndex` | Sub-index within the action |
| `FlashSort` | Sort order — what to do first |

#### 2.3.2 The KMM file format — plaintext, not binary

KMM data is a directory of **17 plaintext `.txt` files**, not a
single binary blob. The DLL has explicit references to:

```
kmm_SG.txt           — list of Steuergeräte (ECUs) in the vehicle
kmm_SGK.txt          — SG-Konfiguration (per-ECU configuration)
kmm_SGF.txt          — SG-Familie (ECU family taxonomy)
kmm_SWT.txt          — Software-Tabelle (per-ECU SWT entries)
kmm_CODING.txt       — coding rules
kmm_ZK.txt           — Zukauf-Konfiguration (purchased configuration)
kmm_ZSG.txt          — Ziel-SG (target SG)
kmm_ZSG_VERBAU.txt   — ZSG installation rules
kmm_HO.txt           — Höchstausstattung (highest-equipment set)
kmm_EK.txt           — Eintrag-Konfiguration
kmm_ETM.txt          — Energie-Test-Manager
kmm_ATSH.txt         — ATSH (action-steering header?) records
kmm_LAPOL.txt        — Land-Politik (country policy)
kmm_SIT.txt          — Situation (referenced by `# Unknown diagAddr %02X in kmm_SIT.txt, ignored.\n`)
kmm_EXT.txt          — extension data
kmm_SORT.txt         — sort order
kmm_WERT.txt         — Werte (parameter values)
```

Plus a writable log: `%slog.txt`.

The bench install's `KMMDAT/<chassis>/I_STUFE/<istufe>/` folders
contain only empty `LOG.TXT` files — a real BMW dealer install would
have the `kmm_*.txt` payloads here. The `_IMPORT/` folder receives
fresh data drops from BMW.

#### 2.3.3 KMM error codes (full enum)

```
KMM_SUCCESS                 KMM_NO_PLAN               KMM_NO_TRIVIAL_PLAN
KMM_INVALID_CONTEXT         KMM_INCOMPLETE_CONTEXT    KMM_BAD_CALLING_SEQUENCE
KMM_UNKNOWN_ECU             KMM_MISSING_ZBNR          KMM_BAD_HWNR / KMM_BAD_HWSNR
KMM_CANNOT_FLASH_ECU        KMM_LINE_TOO_LONG         KMM_ILLEGAL_DATA
KMM_MISSING_SEPERATOR       KMM_DUPLICATE_DEFINITION  KMM_TOO_MANY_PARAMETERS
KMM_UNDEFINED_ECU           KMM_TOO_MANY_SA           KMM_NO_MORE_CONTEXT
KMM_ILLEGAL_ZK              KMM_UNKNOWN_I_LEVEL       KMM_WRONG_SIGNATURE
KMM_MATH_OVERFLOW           KMM_TOO_MANY_ILEVELS      KMM_TOO_MANY_LAPOL_LINES
KMM_UNKNOWN_PLACEHOLDER     KMM_TOO_MANY_ZK_LINES     KMM_MULTIPLE_DA_PER_SWT_AN
KMM_SWT_DA_NOT_IDENTICAL    KMM_SWT_UI_UNKNOWN        KMM_SWT_AN_UNKNOWN
KMM_ILLEGAL_SG_GROUPING     KMM_FILE_NOT_FOUND
```

These are diagnostics for what can go wrong with the plaintext-file
parsing, the consistency model, or plan generation. Useful both for
the parser tests we'll need and for the UI to surface meaningful
errors.

#### 2.3.4 Internal source-file map (from debug strings)

The DLL ships with `.\kmm*.c` source filenames in assertion paths
— effectively a module map for the reconstruction:

```
kmmPlan.c                  — plan generator
kmmSolutionGenerator.c     — solver
kmmConsistencyTask.c       — consistency checks
kmmKnowledgeBase.c         — KMM knowledge model
kmmConfiguration.c         — CConfiguration impl
kmmChoice.c                — choice/decision tree
kmmActionContext.c         — action context state
kmmIntegrationLevel.c      — I-Stufe lookup
kmmDiagnosticAddress.c     — DiagAddr resolution
kmmEcu.c                   — ECU object
kmmEcuLine.c               — ECU-line (variant)
kmmEcuGroup.c              — ECU groups
kmmSwt.c                   — Software-Tabelle handling
kmmHo.c                    — Höchstausstattung
kmmZsg.c                   — target-SG
kmmEtm.c                   — Energie-Test-Manager
kmmAts.c                   — Action-Steering
kmmExternalText.c          — external text catalog (i18n?)
kmmCodingSpec.c            — coding spec consumer
kmmSgReader.c              — kmm_SG.txt parser
kmmSgkReader.c             — kmm_SGK.txt parser
kmmAtshReader.c            — kmm_ATSH.txt parser
kmmEkWords.c               — kmm_EK.txt words/tokens
kmmSignature.c             — file signature/checksum verify
kmmInitialize.c            — startup, file loading
```

That's already a sketch of the planner-package module layout we'd
write in TypeScript.

### 2.4 The CABI VM lives inside `winkfpt.exe`

### 2.4 The CABI VM lives inside `winkfpt.exe`

There is no separate CABI host DLL. The IPO interpreter, CABI
syscall dispatcher, system-data / cabd-par stores, and the EDIABAS
bridge (`CDHapiJob`/`CDHapiJobData`) are all embedded directly in
`winkfpt.exe` — same architectural pattern NCSEXPER.exe and INPA.exe
follow.

For `nfsx`: `@emdzej/inpax-cabi-provider` already implements this VM
host layer for NCSEXPER's syscall set. The flash-specific syscalls
(§4) get added on top of the same provider.

### 2.5 `Cabiger.dll` / `CabUS.dll` — language resource DLLs

Pure resource modules: dialog templates, message strings, error
catalogs. Built June 2000, ~57 KB each, near-identical exports —
only generic Win32 imports plus C-runtime stubs, zero real code.

Loaded by `winkfpt.exe` based on `NFS.INI`'s `Language=Deutsch` /
`Language=English` switch. `Cabiger` = `Cabi-ger`(man), `CabUS` =
`Cab-US`(English).

`nfsx` doesn't need to reconstruct these — message text comes from
the locale layer of the web app instead.

### 2.6 Bundled support DLLs

- `nfsunzip.dll` — KMM payloads are likely compressed; this is the
  decompressor. Compression format TBD (probably stock zlib or BMW's
  custom-ish LZ77).
- `inpout32.dll` — direct PC parallel-port I/O (legacy MOST/EDIC
  interfaces; not relevant for modern ENET).
- `RICHTX32.OCX` — RichText OLE control for the help/info windows.

## 3. Data layers

### 3.1 `SGDAT/` — per-ECU IPOs (~1960 files)

Three coexisting IPO flavours:

#### NCSEXPER-style coding IPOs (`A_*.ipo`)
```
A_ACC.ipo  →  cabimain, Jobs, InfoJob, CILesen, Cod, Lesen, FgnrLesen, Ident
```
Identical pattern to NCSEXPER. Read/write coding via CABI dispatch.

#### NFS-flash SWT IPOs (`00swt*.ipo`, `00*.ipo`)
```
00swtds2.ipo →  __inpa_startup__, cabimain, AuthenticateSession,
                StoreFsc, DisableFsc, CheckFsc, GetFsc,
                StoreCertificate, CheckCertificate, GetCertificate,
                GetFsStatus, GetSwId, GetAllSwId, GetSigSId,
                FingerprintCheck, PeriodChecks,
                GetTime, SetTime, GetVIN, SetVIN,
                GetKeyFactor, SGReset, Jobs, InfoJob
```
The actual flash-programming primitives. Note the alignment to UDS
service IDs (`AuthenticateSession` = UDS 0x29, `StoreCertificate` =
0x36, `GetVIN/SetVIN` via DataIdentifier 0xF190, etc.).

#### INPA-style diagnostic IPOs (e.g. `msd80n43.ipo`)
```
msd80n43.ipo  →  ~125 functions including IdentDaten, AusgabeFehlerFreezeFrame,
                  OutputError2File, OutputKWP2File, OutputNN2File, ...
```
Identical to INPA's per-ECU IPOs. Used by NFS for ECU
pre-/post-flash verification (reading IDENT + fault memory to confirm
the flash took effect).

### 3.2 `KMMDAT/<chassis>/I_STUFE/<istufe-code>/`

Per-chassis × per-I-Stufe flash payload directory. Chassis dirs
observed:

```
E60    — 5-series, 6-series, X3 (E83) generation
E65    — 7-series E65/E66/E68 generation
E70    — X5 / X6 E70/E71 generation
E89X   — 1-series, 3-series, X1 generation (via [BAUREIHENMATRIX])
R56    — Mini (R55/R56/R57/R58/R59/R60/R61)
RR1    — Rolls-Royce (Ghost/Wraith)
```

Plus orchestration folders:

```
_IMPORT/   — staging area for newly-imported KMM data drops
_ARCHIV/   — old I-Stufe data kept around
```

I-Stufe code format observed: `E060-xx-xx-xxx` (e.g.
`E060-12-03-560` = chassis E60, year 2012, month 03, build 560).
Newer chassis use similar codes.

The bench install has these dirs but they're empty (`LOG.TXT` only)
— BMW dealer installs would have real KMM payloads here.

### 3.3 `DATA/GDATEN/` — global tables

```
KFCONF10.DA2     — Kennfeld-Konfiguration (flash data config) v10
HWNR.DA2         — Hardware-Nummer registry
NPV.DAT          — ? (TBD)
PRGIFSEL.DAT     — Programming-Interface-Selection (which transport to use per ECU)
SGIDC.as2        — SG-ID-Konfiguration (or SG-ID-Coding map)
SGIDD.as2        — SG-ID-Definition
Swtconf0.dat     — SWT (SoftWare Tabelle) config
INFO.GER         — German info text shown on startup
historie.bsu     — change history (BSU = ?)
```

`.DA2` / `.as2` extensions suggest a versioned-data format
(`v2`). Format unknown — Ghidra `KmmSrv.dll` or `winkfpt.exe`
parsers will tell us.

### 3.4 `BATCH/` — flash sequences

```
FLASH.CTL     — main flash sequence
FLASH_1.CTL   — alternate sequence 1 (per-channel variant?)
FLASH_2.CTL   — alternate sequence 2
FLASH_3.CTL   — alternate sequence 3
FLASHBSP.CTL  — flash "Beispiel" (example) — template
```

The single example we have shows a near-empty `[BATCH]` / `[ZBNUMMER]`
INI-style structure. Real sequences likely come from KMM files at
runtime.

### 3.5 `CFGDAT/` — coding API config

```
COAPI.INI      — paths, ZB/SW/Typ defaults, file naming patterns
AKTION.DAT     — action codes (probably "FSC" / "Cert" / "FLASH" / "READ" enum)
I_STUFE.DAT    — I-Stufe registry (chassis ↔ I-Stufe mapping)
ID_CHECK.DAT   — ID-check rules (verify ECU before flash)
FciConfig.csv  — FCI (Flash Control Info?) config
INPA.INI       — bridged INPA settings
*.eng / *.ger  — localized error text catalogs
```

`I_STUFE.DAT` is the canonical "what I-Stufe levels exist for this
chassis" registry — driver for the UI's I-Stufe picker.

### 3.6 `TRACE/`

NFS writes runtime logs here on first run:

```
ID.TRC         — IDENT readouts per session
FA.TRC         — FA stream per session (read before flash to preserve)
KMM.TRC        — KMM data load + lookup decisions
ERROR.TRC      — warnings (`WARN_Log=JA` in NFS.INI)
FZG.TMP        — vehicle-config scratch (FZG = Fahrzeug)
'FGST-NR'.TRC  — per-chassis trace file named by VIN/FGNR
ZB.TMP         — ZB-Nummer scratch
```

Read these on a real dealer machine to learn the flash sequence in
practice.

### 3.7 `data/<SG_TYP>/` — per-SG flash payloads + mapping table

Each ECU family has its own directory under `data/` carrying the
actual flashable binaries plus a per-SG mapping table. Verified against
`~/Downloads/E46_v74/data/GD20/` on 2026-05-27.

**Directory layout** (e.g. `data/GD20/`):

```
<HW-NR>A.0PA           — program firmware (Intel-HEX dialect + BMW wrapper)
A<SW-NR>.0DA           — data / calibration files
<SG_TYP>.DAT           — ZB-NR → (HW-NR, SW-NR, …) mapping table
<SG_TYP>.HIS           — historie (BSU history log)
<SG_TYP>.HWH           — hardware history
<SG_TYP>D.DIR          — directory index
```

For GS20: 12 `.0PA` files + 207 `.0DA` files + `GD20.DAT` + working files.

#### `.0PA` and `.0DA` format

Both extensions use the **same wire format**: Intel HEX with a BMW
ASCII header/footer. Verified by parsing `7544721A.0PA` (8283 lines,
all checksums valid). See `@emdzej/nfsx-flash-data/pa-da.ts` for the
parser; key shape:

```
;==========================================
;Austausch-Datei    Daten/Programm           ← decorative comments
;==========================================
;;ZL_System:      GS20                       ← `;;Key: Value` metadata
;;ZL_Projekt:     10_
;;ZL_Referenz:    G2210_0089D0
;;K_Stand:        08.04.2004
;;K_File-Name:    7544721A.0PA
;  ... (lots of metadata about authors, dates, validation history) ...
$REFERENZ G2210_0089D0 Q                     ← BMW data-section directive
:020000040000FA                              ← Intel HEX: ext linear addr
:02000002A0005C                              ← Intel HEX: ext segment addr
:200000000123...AC                           ← Intel HEX: 32-byte data record
... (thousands more) ...
:00000010F0                                  ← BMW-specific marker (type 0x10)
$CHECKSUMME 7029 R                           ← BMW file-level checksum
;$CARB_MODE_9_CVN 0000B78D 9                 ← optional CARB CVN (commented out)
:00000001FF                                  ← standard Intel HEX EOF (type 01)
```

Intel HEX record types observed:
- `0x00` data (the bulk of the file)
- `0x01` end-of-file
- `0x02` extended segment address (upper bits)
- `0x04` extended linear address (upper 16 bits)
- `0x10` BMW-specific end-of-data marker (no data, no documented standard meaning)

Each record's in-line checksum is the standard two's-complement of
the LSB of the sum of all bytes from the length byte onward. The
final `$CHECKSUMME` footer is a separate file-level integrity check.

The text wrapper carries provenance: author, department, dates,
release flags, EOL programming responsible, validation contacts.
Useful diagnostic context; not load-bearing for flashing.

Confirmed via Ghidra: `*.0PA` (0x0062f03c) and `*.0DA` (0x0062f018)
appear as file-import dialog wildcards in `FUN_0040cdd0` cases 2 and
1 respectively. Adjacent extensions `.0BA` (BSU?), `.0AB`, `.PAF`,
`.DAF`, `.BAF` look like packed/legacy variants — not seen on disk
in our E46_v74 drop.

#### `<SG_TYP>.DAT` — ZB→files mapping table

The per-SG ZB-NR resolver. Comma-separated rows (with a final space
between `S` and `CS`):

```
$ PS10INIT N00326DFF00003CF004598403C8500000000000 5
$ VERSIONKFCONF: kfconf10.dat
;Zusbauvorschrift vom 21.06.2006 10:33
;SG-TYP: GD20
;ZB-NR  TYP-NR  HW-NR  IX SW-NR     AM          PIN S CS
7514050,0000000,7508145,A,7514051DA,0FFFFFFFFFD,134,1 1
7552752,1000000,7544721,A,7552753DA,0FFFFFFFFFD,134,1 G
```

Confirmed via Ghidra: WinKFP reads this via `coapiKfReadZbNrTabD2`
(unxref'd FUN_00445540 → FUN_0046b6f0). Output struct has 8 fields —
TYP-NR, HW-NR, IX, SW-NR (string), AM, PIN, S, CS — keyed by ZB-NR.
The column headers (`ZB-NR`/`HW-NR`/`SW-NR`) do **not** appear as
strings in winkfpt.exe, so parsing is strictly by position.

**Filename derivation:**

| Column | Maps to | Example |
|---|---|---|
| HW-NR + IX | program file `<HW-NR><IX>.0PA` | `7544721 + A` → `7544721A.0PA` |
| SW-NR (literal `DA` suffix) | data file `A<num>.0DA` | `7552753DA` → `A7552753.0DA` |

The trailing `DA` on the SW-NR column is a literal type tag, not part
of the number. The "DA" stands for "Daten" (data) — distinguishes a
`.0DA` reference from other variants.

**Stale-firmware observation** (bench ECU 7544721 on 2026-05-27): the
ECU's burned ZB-NR (7543058) is **not present** in `GD20.DAT`. The
current SP-Daten drop only knows about ZB=7552752 and ZB=7552754 for
HWNR 7544721. This means the bench ECU was last flashed in 2004 with
a ZB that's been superseded since — common for older E46 SGs.

## 4. NFS-specific CABI syscalls (vs NCSEXPER's set)

> Note: with the KMM picture now clear (§2.3), the flow is
> **KmmSrv plans → winkfpt dispatches IPO jobs per plan element →
> IPOs call these syscalls**. So each NFS-specific IPO job below
> corresponds to a `CPlanElement.Action` value that KmmSrv's planner
> can emit.

From the function list of `00swtds2.ipo`, NFS IPOs invoke at least
these flash-specific operations that don't appear in NCSEXPER's
syscall table (`@emdzej/inpax-cabi-provider/src/ncsexper-syscalls.ts`):

| IPO function | Likely CABI syscall(s) | UDS service correspondence |
|---|---|---|
| `AuthenticateSession` | `CDHAuthGetRandom` + `CDHCallAuthenticate` (already stubbed) | 0x27 SecurityAccess + 0x29 Authentication |
| `StoreFsc` / `DisableFsc` / `CheckFsc` / `GetFsc` | TBD — FSC (Freischaltcode / unlock code) management slots | 0x2E WriteDataByID (DID FSC area) |
| `StoreCertificate` / `CheckCertificate` / `GetCertificate` | TBD — module certificate slots | UDS 0x36 TransferData with certificate type |
| `GetFsStatus` | TBD — flash status read | UDS 0x22 ReadDataByID (FlashStatus DID) |
| `GetSwId` / `GetAllSwId` / `GetSigSId` | TBD — software-ID read | UDS 0x22 ReadDataByID (software-info DIDs) |
| `FingerprintCheck` | TBD — module fingerprint verify | UDS 0x22 ReadDataByID (fingerprint DID) |
| `PeriodChecks` | TBD — period (validity-window) checks | (no direct UDS — likely cabd-par-driven) |
| `GetTime` / `SetTime` | TBD — RTC access | UDS 0x22 / 0x2E (RTC DID) |
| `GetVIN` / `SetVIN` | Maps to standard FAHRGESTELL_NR flow we already have | We've already done this in ncsx |
| `GetKeyFactor` | TBD — security key derivation | Internal seed/key tables |
| `SGReset` | Standard EDIABAS reset job | EDIABAS RESET / UDS 0x11 ECUReset |

Confirming which CABI slot IDs back each of these is one of the
first Ghidra deliverables (§7). The IPO disassembly will name the
user functions but the CABI slot numbers come from `Cabiger.dll`.

## 5. Reconstruction strategy

### 5.1 Layered build

```
                       ┌─────────────────────────┐
                       │  apps/web (nfsx-web)    │  Phase 3
                       │  flash GUI (Svelte 5)   │
                       └────────────┬────────────┘
                                    │
       ┌───────────────────────┬────┴────┬───────────────────────┐
       │                       │         │                       │
┌──────▼──────┐  ┌──────────▼──┐ ┌──────▼────────┐  ┌──────────▼──┐
│ nfsx-flash  │  │ nfsx-istufe │ │ nfsx-kmm      │  │ nfsx-fsc    │  Phase 2
│ batch +     │  │ chassis ↔   │ │ KMM file      │  │ FSC + cert  │
│ sequence    │  │ I-Stufe     │ │ parser        │  │ ops         │
└──────┬──────┘  └─────────────┘ └───────────────┘  └─────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│ nfsx-syscalls (NFS-specific CABI slots: Auth, FSC, Cert, Time)  │  Phase 1
└──────┬──────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│ Existing reusable packages:                                     │  ✅ already shipped
│   @emdzej/inpax-parser   — IPO bytecode → typed instructions    │
│   @emdzej/inpax          — IPO VM interpreter                   │
│   @emdzej/inpax-cabi-provider — CABI syscall host (NCSEXPER set)│
│   @emdzej/inpax-dis      — disassembler                         │
│   @emdzej/ediabasx       — EDIABAS / SGBD / wire transport      │
│   @emdzej/ncsx-cabd      — CABD coding data files               │
│   @emdzej/ncsx-daten     — DATEN binary format reader           │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Phasing

**Phase 0 — research (this doc + ghidra)**.
Reverse-engineer `KmmSrv.dll`, sample a dozen NFS IPOs to enumerate
the syscalls that don't exist in our current cabi-provider, document
the KMM file format.

**Phase 1 — read-only inspection**.
Build the minimal stack that can:
- Parse a real KMM data folder (after KMM format is known)
- Run an NFS IPO's `Ident` / `GetVIN` / `GetFsStatus` / `GetAllSwId`
  job against a connected ECU via the existing ediabasx transport
- Show software versions, fingerprints, FSC status

No writes. No flash. No risk. This is the equivalent of ncsx's
"read coding" milestone — it exercises everything except the
destructive path.

**Phase 2 — FSC and certificate management**.
Reversible(-ish) write operations:
- Read FSC list per ECU
- Activate / deactivate features via FSC
- Read/write certificates

These are *less* destructive than full flash because they don't
overwrite program memory — but they still need the full safety
treatment (verify-before-write, rollback path).

**Phase 3 — flash programming**.
The actual reflash. Multiple steps, each with a fallback:
- I-Stufe upgrade planning (compute the ECU diff)
- Pre-flash IDENT capture
- AIF backup
- Per-ECU flash (Authenticate → Erase → Program → Verify)
- Post-flash IDENT verify
- AIF restore

This is high-risk; even the dealer-grade WinKFP bricks ECUs
occasionally. The UI needs a much harder "are you sure" surface
than ncsx, including a mandatory dry-run-against-trace step before
any real write.

### 5.3 What we don't need to rebuild

- **The IPO VM**. `@emdzej/inpax` already runs NCSEXPER IPOs;
  inserting NFS-specific syscalls on top is additive, not
  replacement work.
- **The transport stack**. `@emdzej/ediabasx` already speaks KWP /
  UDS / ENET / CAN. The "fast baudrate" mode (`SCHNELLE_BAUDRATE`)
  may need a small extension for the UDS 0x10 0x02 (programming
  session) baudrate-change step, but that's localized.
- **Coding IPOs**. NCSEXPER's `A_*.ipo` files in NFS's SGDAT are
  bit-identical (or near enough) to NCSEXPER's. The ncsx coding
  flow runs them today.

## 6. Risk + safety considerations

Flash programming is **the only operation in the BMW dealer stack
that can permanently brick an ECU.** A wrong KMM file, an
interrupted transfer, or a checksum mismatch with a half-written
flash can leave an ECU unbootable with no recovery path short of
sending it to BMW for re-flashing on a workbench.

The web app architecture has to enforce:

- **No-write by default**. Every write button needs explicit opt-in
  with the destructive consequences spelled out.
- **Power-stability guard**. Before issuing the program command, the
  app should verify battery voltage > 13V via INPA voltage read and
  refuse otherwise. Power loss mid-flash is the #1 brick cause.
- **Bus-quiet guard**. If anything else is talking on the bus, abort.
  WinKFP does this; we need to too.
- **Checksum verify is mandatory**, not optional. `TEST_CHECKSUMME=ON`
  in `Winkfpt.ini` is the default for a reason.
- **Single-ECU-at-a-time** in the web app, even though NFS supports
  multi-channel. Multi-channel adds risk we can't yet model.
- **Trace-replay mode** for development. Read the dealer
  `ABLAUF.TRC` / `KMM.TRC` from a known-good flash and play it back
  against a mock ECU to validate the flow without bus access.

## 7. Investigation targets

In rough priority order. **Resolved items struck through**; see
§9 for the consolidated findings.

1. ~~**`KmmSrv.dll` Ghidra walk**~~ — DONE 2026-05-25. KMM is a
   COM/IDispatch planner, not a binary blob. See §2.3.
2. ~~**Get real `kmm_*.txt` files**~~ — DONE via the
   `~/Downloads/E46_v74` SP-Daten drop. Confirmed `kmm_SIT.txt`
   format: semicolon-CSV with `#` comments. The other 16 files
   need samples from a flash-target chassis (E60+) drop.
3. ~~**Decompile a KmmSrv text-file reader**~~ — superseded by
   the SP-Daten samples. The parser is trivially mechanical once
   we have rows.
4. ~~**`DATA/GDATEN/*.DA2` format**~~ — DONE. **All plaintext.**
   `.DA2` / `.AS2` are version-suffixed plaintext, not binary. See
   §9.2 for per-file format reference.
5. **Sample NFS-flash SWT IPO** disassembly. Pick 2-3 representative
   `00swt*.ipo` files (e.g. `00swtds2.ipo` for DS2 transport,
   `00swtkwp.ipo` for KWP, `00swtkws.ipo` for KW(S) UDS) and
   inventory their CABI slot calls. Empirically discover the 3 new
   slot IDs by running them through `inpax-cabi-provider` and
   catching the "unknown slot" exceptions. See §9.5.
6. **`winkfpt.exe` interpreter dispatcher**. The exact slot-table is
   still hidden — the visible `coapi*` functions are the C-side API
   layer, not the IPO interpreter's syscall switch. Empirical
   approach (§9.5) is the cheaper path; revisit Ghidra only if
   empirical hits a wall.
7. **Sample non-E46 SP-Daten drop** (E60 / E65 / E70 / E89X / R56 /
   RR1) to get the remaining 16 `kmm_*.txt` formats.
8. **`I_STUFE.DAT` parse**. Plaintext format check first; if binary,
   small Ghidra pass on the loader. Low priority since SP-Daten
   per-chassis folders carry the same info.
9. **`BATCH/FLASH*.CTL` semantics**. The empty `FLASH.CTL` we have
   suggests sequences come from KMM at runtime, but confirm.
10. **`nfsunzip.dll` Ghidra walk**. Decompression for something —
    might be needed if SP-Daten drops sometimes arrive as compressed
    bundles via `_IMPORT/`. Quick check via DLL exports when needed.

The big resolved items collapsed the work surface — what was
"reverse-engineer a binary protocol" is now "write a CSV parser per
file" plus the empirical slot ID discovery.

## 9. The lookup chain — Ghidra-verified 2026-05-25

A full SP-Daten data drop for E46 (`~/Downloads/E46_v74/`) revealed
that **the entire BMW data layer above the IPO bytecode is
plaintext**. The `.DA2` / `.AS2` extensions are versioned-format
naming, not "binary v2" — every file is line-oriented text with `;`
comments, `$`-directive markers, or fixed-column rows. No binary
reverse-engineering required for any of the data tables.

### 9.1 Lookup chain (live flash)

When a vehicle is connected, the planner resolves each ECU to a
flash action through this chain:

```
                  Part # (HWNR / ZB-Nummer, e.g. 4010581)
                              │  read from ECU via IDENT
                              │  or entered manually
                              ▼
  ┌──────────────────── HWNR.DA2 ────────────────────┐
  │  HWNR    AT_HWNR  EP_TSNR  SG_TYP               │
  │  4010581 0000000  0000000  ACC65                │  3763 rows
  │  6759902 0000000  0000000  ACC65                │  grouped by ;$SG <name>
  └──────────────────────────────────────────────────┘
                              │
                              ▼  SG_TYP = "ACC65"
                              │
  ┌────────────────── KFCONF10.DA2 ──────────────────┐
  │  ME A7 21 01 ACC65  25ACC65.IPO  02FLASH.PRG    │  fixed-column plaintext
  │                     XXFLKP  ACC65.HIS  ACC65.DAT │  + working files (.HIS .DAT
  │                     A   ACC65D.DIR  ACC65.HWH    │   .DIR .HWH per ECU)
  └──────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
    .IPO file            FLASH.PRG SGBD         per-ECU files
    in SGDAT/            in EDIABAS/Ecu/        in data/<SG>/
    (flash logic)        (wire transport)       (.HIS .DAT .HWH .DIR)
                              │
                              ▼  also keyed by SG_TYP
  ┌────────────────── SGIDC.AS2 ─────────────────────┐
  │  $L 3 / $V 1.00 / $G 1.00                        │  directives + records
  │  $K ACC65   A72100006…(40 hex chars, short key)  │  HW-specific key
  │  $K BMSKP2  P21AA…(300+ hex chars, RSA/ECC cert) │  full certificate
  └──────────────────────────────────────────────────┘
                              │
                              ▼  → CDHCallAuthenticate / CDHAuthGetRandom

  ┌─────────────────── kmm_SIT.txt ──────────────────┐
  │  DiagAddr;ShortName;GroupId;HwIdMode;AifMode;... │  semicolon-CSV
  │  12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;    │  + transport (KLINE/CAN)
  │     KLINE;1000;1;MOT;60;;;0;80                    │  + flash-limit + category
  └──────────────────────────────────────────────────┘

  ┌─────────────────── npv.dat ──────────────────────┐
  │  ZB-ALT, ZB-NEU,  NP-SW,    AM,        S,M CS    │  comma-CSV
  │  1703643,1744493, 1427105NA,1FFFFFFFFFD,1,1 6    │  "you have X → flash to Y"
  └──────────────────────────────────────────────────┘

  ┌─────────────────── prgifsel.dat ─────────────────┐
  │  SG EK924  - - - KWP2000* - - - - - -            │  fixed-column plaintext
  │  SG EKB924 - - - KWP2000* - - - - - -            │  per-SG transport selection
  └──────────────────────────────────────────────────┘
```

Plus the chassis-level files (`<chassis>SGFAM.DAT`, `BR_REF.DAT`,
`<chassis>AT.*`, `<chassis>ZCSUT.000`, `<chassis>ZST.*`) — these are
the SAME files NCSEXPER consumes, and `ncsx-text-tables` already
parses them.

### 9.2 File-format reference (priorities for parser implementation)

| File | Format | Notes |
|---|---|---|
| **`HWNR.DA2`** | `;`-comments, `;$SG <name>` group headers, comma-CSV rows `HWNR,AT_HWNR,EP_TSNR,SG_TYP` | 3763 rows on E46. SG_TYP padded to fixed width with spaces. |
| **`KFCONF10.DA2`** | `;`-comments, `$ VERSIONKFCONF:` directive, then fixed-column rows | 10 fields per row; positional, not delimited. Field widths derived from header layout. |
| **`SGIDC.AS2`** / **`SGIDD.AS2`** | `$L <len>`, `$V <ver>`, `$G <ver>`, `$K <SG_TYP> <hex>` directives | Auth-material catalog. Hex blob length varies (short = key, long = cert). |
| **`kmm_SIT.txt`** | `#`-comments, semicolon-separated rows | 16 fields. First = DiagAddr (hex), others incl. flash-limit, transport, category. |
| **`npv.dat`** | `;`-comments, comma-separated rows | ZB upgrade table. Fields: ZB-ALT, ZB-NEU, NP-SW, AM, S, M CS. |
| **`prgifsel.dat`** | `;`-comments, fixed-column rows starting with `SG` | Per-SG programming-interface selection. |
| **`<chassis>SGFAM.DAT`** | (NCSEXPER format) | ✅ already parsed |
| **`BR_REF.DAT`** | (NCSEXPER format) | ✅ already parsed |
| **`<chassis>AT.000` etc.** | (NCSEXPER format) | ✅ already parsed |
| **`SWTFSW.DAT`, `SWTPSW.DAT`, `SwtConf*.dat`** | (NCSEXPER format) | ✅ already parsed |
| All other `kmm_*.txt` (16 more) | Presumed semicolon-CSV with `#` comments | Need samples from a flash-target chassis SP-Daten drop (E60 / E65 / E70 / E89X / R56 / RR1). E46 only ships `kmm_SIT.txt`. |

### 9.3 The C-side API (from winkfpt.exe Ghidra walk)

Renamed functions identified so far — all in `COAPIKF.CPP`:

| Address | Renamed | What it does |
|---|---|---|
| 0x0044fa30 | `coapiKfProgSgDevelopWithAif` | High-level "program ECU + write AIF" workflow. Stages AIF_* CABD params, dispatches `SG_AIF_LESEN` → `SG_PROGRAMMIEREN` → `SG_AIF_SCHREIBEN` via the IPO. |
| 0x00444360 | `coapiKfReadKfConfTabD2_driver` | KFCONF10.DA2 reader top-level — allocates 8 working buffers (288 bytes each), drives the parser, logs errors via `COAPIKF.CPP` source-file tags. |
| 0x00456fb0 | `coapiSetCabdParByName` | Set named CABD param (string). The function's name string is copied onto the stack as a log tag. |
| 0x00456c10 | `coapiGetCabdParByName` | Get named CABD param (out-param). |
| 0x0045c810 | `coapiRunIpoJob` | Dispatch a named IPO job (jobName, sgbd, flags). |
| 0x00478f10 | `coapiAnalyseKmmDir` | Walk a `kmmdat/` folder and collect file list into a result struct. |
| 0x00460c90 | `logCoapiError` | Error logger with `(errCode, severity, srcFile, srcLine, errType, ...)` signature. |
| 0x00460cc0 | `logCoapiErrorWithArg` | Variant with extra string argument. |

### 9.4 AIF (After-Information-File) protocol

After every successful flash, the IPO writes an identity stamp into
the ECU's reserved AIF region. The host stages these CABD params
before `SG_AIF_SCHREIBEN`:

| Param | Meaning |
|---|---|
| `AIF_NUMMER` | AIF format version |
| `AIF_FG_NR` | Fahrgestellnummer (VIN) of the vehicle |
| `AIF_DATUM` | Programming date (`DDMMYY`) |
| `AIF_AENDERUNGS_INDEX` | Change index |
| `AIF_SW_NR` | Software number programmed |
| `AIF_BEHOERDEN_NR` | Government / regulatory # |
| `AIF_ZB_NR` | ZB-Nummer programmed |
| `AIF_SERIEN_NR` | Tool serial number (`NFS01` per default config) |
| `AIF_HAENDLER_NR` | Dealer number (`00240` per default config) |
| `AIF_KM` | Vehicle mileage at programming time |
| `AIF_PROG_NR` | Programming sequence number (from `coapiKfGetCurrentProgNr`-equivalent) |
| `AIF_ADRESSE` | Flash address for the AIF block |
| `AIF_ADRESSE_LOW` / `AIF_ADRESSE_HIGH` | 16-bit halves of `AIF_ADRESSE` |
| `AIF_ANZ_FREI` | Number of free AIF slots (ECUs keep a ring buffer) |
| `PROG_WITH_AIF` | Flag — enable AIF write during this flash |
| `BSUTIME` | BSU (Bundesleitstelle?) timestamp |

These get read back via `SG_AIF_LESEN` for verification + forensics.

### 9.5 The slot-ID question — RESOLVED 2026-05-25

**No slot ID work is needed.** Confirmed by static analysis: all
1798 IPO files under `EC-APPS/NFS/SGDAT/` (both `*.ipo` and
`*.IPO`) were disassembled via `@emdzej/inpax-dis`, every `CALL sys`
instruction was checked against inpax's slot table, and **zero
unknown slots were found across the entire NFS IPO corpus.**

What this means:

- NFS IPOs use the **same syscall slot IDs** as INPA / NCSEXPER —
  same VM, same CABI table, same numeric opcodes.
- The 3 syscall names we found in winkfpt.exe strings
  (`CDHGetReferenzProgramm`, `CDHGetReferenzDaten`, `CDHDelay`) are
  **not invoked from inside any IPO**. They exist in winkfpt.exe
  because they're called from the **host-side C code** as part of
  winkfpt's IPO-host integration glue — they're not exposed to the
  IPO bytecode at all.
- The IPO interpreter (`@emdzej/inpax`) and the CABI host
  (`@emdzej/inpax-cabi-provider`) are **drop-in compatible** with
  NFS IPOs. No new syscalls, no slot-ID translation, no
  cabi-provider work.

The actual flash protocol lives in the **SGBD** (`*.PRG` files in
`EDIABAS/Ecu/`), not the IPO. The IPO just calls
`apiJob(sgbd, "FLASH_SCHREIBEN", payload, ...)` and the SGBD does
the protocol-level transfer. The SGBD layer is already implemented
by `@emdzej/ediabasx`.

Reconstruction surface left:

1. ~~Remaining 4 data parsers (SGIDC.AS2, SGIDD.AS2, npv.dat,
   prgifsel.dat).~~ ✅ shipped 2026-05-25 — all 7 parsers done.
2. ~~Wire an NFS IPO through inpax against a mock transport
   (Phase 3 — actually run a read-only IPO job).~~ ✅ shipped
   2026-05-25 — `@emdzej/nfsx-runtime` runs 16ACC65.ipo's
   JOB_ERMITTELN dispatch end-to-end; `Jobs()` publishes 18 job
   names + JOB_ANZAHL counter into the CABI store.
3. Wire CDHapiJob + result-readers (slots 0x0D / 0x0F / 0x10 /
   0x11 / 0x15) to surface mock ECU data back through the IPO ✅
   2026-05-25. HW_REFERENZ end-to-end dispatch confirmed against
   a mock EDIABAS: 14-syscall trace runs cleanly, all 4 result
   reads (JOB_STATUS / HW_REF_STATUS / HW_REF_SG_KENNUNG /
   HW_REF_PROJEKT) land in cabd-pars. Bug-of-the-day: hand-rolled
   pop order on the result-readers and CDHGetSgbdName was
   backwards; switched to driving pop order from
   `@emdzej/ncsx-inpax-cabi-provider`'s `NCSEXPER_CABI_SLOTS`
   metadata table (authoritative CABI.H signatures, 68/68
   validated against ncsserv.exe).
4. Real-ECU read-only flows on hardware (Phase 3 end-game).
5. FSC + certificate management UI (Phase 4).
6. Actual flash + safety surface (Phase 5).

### 9.6 NFS slot table — winkfpt Ghidra walk 2026-05-25

Walking the winkfpt.exe interpreter to characterise NFS's slot
surface vs NCSEXPER's. Anchored against the **IPO opcode dispatcher**
at `CInterpreter::DoInterpret` (FUN_004a2c00 in our session, renamed
in Ghidra) — confirmed by the embedded source-path strings
`"interpr.cpp"` + `"CInterpreter::DoInterpret"` at line numbers 0x204
and 0x255 (CALL and CALLE error paths).

**Dispatcher structure (FUN_004a2c00 case 0xc — CALL):**

```c
bVar1 = puVar3[1];                   // call type byte (0x80 = user, else sys)
uVar2 = *(ushort *)(puVar3 + 2);     // slot / function number
iVar7 = CInterpreter_LookupCallTarget(state, bVar1, uVar2, &handler);
//                                     │     │      │       │
//                                     │     │      │       └─ out: function pointer
//                                     │     │      └────────── slot number
//                                     │     └───────────────── 0x80=user, else=sys
//                                     └─────────────────────── interp state struct
if (iVar7 == 1)      { FUN_004ab7d0(state, ip); FUN_004a2230(handler); }  // user
else if (iVar7 == 2) { (*handler)(*(int*)(state + 0x20), &slot_call_ctx); FUN_004ad290(); }  // sys
```

**Slot table layout (`FUN_004aa460` aka `CInterpreter_LookupCallTarget`):**

- User-function table at `state + 0x3c`, count at `state + 0x40`.
- **Sys-function table at `state + 0x50`, count at `state + 0x54`.**
  (Byte-level extraction of the table contents requires reading raw
  PE bytes — possible via a more capable Ghidra tool than MCP exposes
  today, or via a runtime debugger attached to winkfpt.exe.)

**Strategic finding — NFS slot table is a NCSEXPER superset:**

The winkfpt.exe string table reveals two distinct populations of
CABI-relevant symbols:

1. **NCSEXPER-compatible CDH* surface** — same names ncsx already
   ships in `NCSEXPER_CABI_SLOTS` (99 entries). All 16 slots our
   HW_REFERENZ test exercises map cleanly through the NCSEXPER
   table. The metadata is authoritative for these (CABI.H lineage,
   shared bytecode VM, shared parameter conventions).

2. **NFS-specific CDH* additions** — strings present in winkfpt
   but absent from ncsx's table:
   - **`CDHIntInit` / `CDHIntSetMode` / `CDHIntSetScriptFile` /
     `CDHIntTrigger`** — internal scripting engine bindings.
     Probably how winkfpt drives flash trigger sequences from
     within IPO control flow.
   - **Expanded `CDHBinBuf*`** — NCSEXPER has Create / Delete /
     ReadByte / ReadWord / WriteByte / WriteWord / ToStr /
     ToNettoData. NFS adds **`CDHBinBufWrite` /
     `CDHBinBufWrite/Change` / `CDHBinBufRead` / `CDHBinBufReadAt` /
     `CDHBinBufSize` / `CDHBinBufAppend` / `CDHBinBufCopy`** — the
     extended binbuf operations needed for flash-block staging
     (NCSEXPER never moves more than coding-bytes' worth of data
     through a binbuf; NFS streams entire S37 frames).
   - **`CDHSaveTmpFswPswList` / `CDHRestoreTmpFswPswList`** — a
     temporary-snapshot variant of NCSEXPER's Save/Restore pair.

3. **Host-side `coapiKf*` family** — NFS's flash-specific business
   logic lives here, NOT in IPO-exposed slots:
   - `coapiKfProgSgD2` / `coapiKfProgSgDevelop` /
     `coapiKfProgSgDevelopWithAif` — the actual flash entry points
   - `coapiKfGetHwReferenzFromSgD2` / `coapiKfGetAifFromSgD2` /
     `coapiKfGetUProg` — read SG state
   - `coapiKfReadHwNrTabD2` / `coapiKfReadZbNrTabD2` /
     `coapiKfReadKfConfTabD2` — load SP-Daten tables
   - `coapiKfCheckBsuPossibleD2` /
     `coapiKfCheckBsuPossibleForZbUpdateD2` — upgrade-eligibility
     checks
   - `coapiKfRefreshGdaten` / `coapiKfImportWdp` /
     `coapiKfExportDevelopData` — host-side orchestration

   These functions are HOST-CALLABLE from winkfpt's MFC UI — they're
   not slots an IPO can `CALL sys` to. The flash protocol is driven
   by the C host directly against the SGBD via `apiJob`, with IPOs
   only used for the read-only metadata steps (HW_REFERENZ,
   AIF_LESEN, IDENT, status reads).

**Implications for nfsx Phase 5 (actual flash):**

NFS's architecture is fundamentally different from NCSEXPER's:

- **NCSEXPER** — the IPO does most work; host = UI + cabd-par store.
  Reconstructing NCSEXPER means re-implementing the IPO surface.
- **NFS** — the IPO does only read-only metadata; host drives the
  flash protocol directly through the SGBD. Reconstructing NFS's
  flash flow means re-implementing the `coapiKf*` C functions in
  TypeScript, calling `apiJob` against the SGBD for each protocol
  step.

The IPO surface we have today (NCSEXPER-compatible 99-slot table)
is therefore sufficient for **all NFS read flows**: HW_REFERENZ,
AIF_LESEN, IDENT, JOB_ERMITTELN, status reads. NFS-specific
`CDHInt*` / expanded `CDHBinBuf*` are probably wired but not
exercised by the read paths — when we hit the first IPO that
actually uses them (likely `00swt*.ipo` flash trigger scripts in
Phase 5), we extract the slot IDs from a debugger trace at that
point.

**Concrete next step when Phase 5 starts:** run winkfpt against a
real ECU with a logging proxy on the IPO interpreter (or attach a
debugger to `CInterpreter_LookupCallTarget` and dump every
`(slot_num, returned_handler)` tuple). That gives a complete
empirical slot map for whatever IPOs the flash flow actually
touches, instead of trying to extract the table statically.

### 9.7 Phase 4 surface — FSC + cert workflow (`00swt*.ipo`) 2026-05-25

The six `00swt*.ipo` IPOs are the **SWT (SoftWare Transfer)
dispatcher family** — transport-specific variants exposing an
identical 20-job CABI surface for FSC + cert + identity management.

| IPO | Transport |
|---|---|
| `00swtds2.ipo` | DS2 (E39/E46/E53-era) |
| `00swtdsc.ipo` | DS-C |
| `00swteps.ipo` | EPS |
| `00swtkwp.ipo` | KWP2000 (E60+, the common case) |
| `00swtkws.ipo` | KWP-S |
| `00swtmsd.ipo` | MSD (motor) |

**Job vocabulary (identical across all six variants):**

```
JOB[1]  = JOB_ERMITTELN      JOB[11] = GET_SWID
JOB[2]  = INFO               JOB[12] = GET_ALL_SWID
JOB[3]  = STORE_FSC          JOB[13] = GET_SIGSID
JOB[4]  = STORE_CERTIFICATE  JOB[14] = PERIODICAL_CHECK
JOB[5]  = DISABLE_FSC        JOB[15] = FINGERPRINT_CHECK
JOB[6]  = CHECK_CERTIFICATE  JOB[16] = GET_TIME
JOB[7]  = CHECK_FSC          JOB[17] = SET_TIME
JOB[8]  = GET_CERTIFICATE    JOB[18] = GET_VIN
JOB[9]  = GET_FSC            JOB[19] = SET_VIN
JOB[10] = GET_FSSTATUS       JOB[20] = KEYFAKTOR_LESEN
```

**Standard host-pre-seeded cabd-pars** (the IPO reads these before
dispatching each job):

| cabd-par | Purpose |
|---|---|
| `JOBNAME` | The job to dispatch (already set by `runCabimain`). |
| `AUTH_MODE` | Authentication mode (e.g. `0` = none, `1` = challenge-response). |
| `PSGBD_NAME` | "P-SGBD" — the protocol SGBD name (transport-level driver). |
| `SGBD_NAME` | The actual ECU SGBD (e.g. `C_DSC_KWP`). |
| `VARIANT` | The SG variant tag (e.g. `DSC60`). |
| `AUTH_KIND` | Authentication scheme variant. |
| `APP_NR` | Application number for the FSC slot (which FSC area). |
| `UPGRADE_INDEX` | Upgrade context index. |

**Standardised result-reporting pattern.** Each job that hits the
SGBD reads back two results from the apiJob response, then
publishes two cabd-pars:

```
SGBD job → JOB_STATUS / JOB_STATUS_CODE
                ↓
        API_RESULT_CODE / API_RESULT (cabd-pars)
```

This lets the C host orchestrator (`coapiKf*`) inspect the standard
`API_RESULT_*` pair from any FSC IPO without parsing per-job result
structures. Note: the IPO only publishes API_RESULT_CODE / API_RESULT
on the **error path**. The happy path just sets ReturnVal=0 and exits
cleanly — the host knows it succeeded when `lastJob.status === "OKAY"`.

**Per-job SGBD mappings (KWP variant):**

| FSC/cert job | apiJob to SGBD | Notes |
|---|---|---|
| CHECK_FSC | `FREISCHALTCODE_PRUEFEN` | Verify FSC validity |
| GET_FSC | `FREISCHALTCODE_LAENGE_LESEN` | Read FSC length (precursor to actual GET) |
| STORE_FSC | (untested — likely `FREISCHALTCODE_SCHREIBEN`) | Write FSC into ECU |
| DISABLE_FSC | (untested — likely `FREISCHALTCODE_LOESCHEN` or similar) | Clear FSC slot |
| CHECK_CERTIFICATE | (untested) | Verify module cert |
| GET_CERTIFICATE | (untested) | Read cert |
| STORE_CERTIFICATE | (untested) | Write cert |
| GET_FSSTATUS | `STATUS_LESEN` | Flash status read |
| GET_SWID | (untested) | Software-ID |
| GET_VIN | `FAHRGESTELLNUMMER_LESEN` | VIN read |
| SET_VIN | (untested — likely `FAHRGESTELLNUMMER_SCHREIBEN`) | VIN write |
| GET_TIME | (no apiJob — reads TIME cabd-par) | Host-seeded RTC |
| KEYFAKTOR_LESEN | (no apiJob — errors immediately if AUTH_MODE empty) | Auth-seed precondition |

**What this means for Phase 4 reconstruction:**

The dispatcher already runs every FSC job cleanly. To complete
Phase 4 we need three things, none of which require new VM/runtime
work:

1. **Mock/SGBD layer** — Implement the `FREISCHALTCODE_*` /
   `STATUS_LESEN` / `FAHRGESTELLNUMMER_*` apiJob responses. For
   live ECUs this is just `apiJob` over EDIABAS against the real
   SGBD; for offline reproduction we configure `MockEdiabasProvider`
   with the per-job result shapes.

2. **Host orchestration layer** — Build the equivalent of winkfpt's
   `coapiKf*` C functions in TypeScript: a `FscManager` class that
   knows how to seed the right cabd-pars per ECU (via SP-Daten
   lookup → `00swt*.ipo` selection → cabd-par derivation), invoke
   the runtime, and parse `API_RESULT` / `API_RESULT_CODE` back.

3. **UI surface** (deferred — no web app exists in nfsx yet). A CLI
   `nfsx fsc check --hwnr X` could ship without a UI.

**Status today (2026-05-25):** dispatcher validation complete for
all 6 transport variants; CHECK_FSC / GET_VIN / GET_TIME wired and
tested end-to-end against MockEdiabasProvider. The remaining 17 FSC
jobs follow the same pattern and just need their SGBD-side mappings
to be observed (either via a real ECU session or by looking at the
underlying `.PRG` SGBD bytecode).

## 8. Repo layout (proposed, not yet created)

```
nfsx/
├── README.md
├── docs/
│   ├── architecture.md       ← this file
│   ├── kmm-format.md          ← TBD after §7.1
│   ├── flash-flow.md          ← TBD after §7.4
│   └── safety-model.md        ← TBD before phase 3
├── packages/
│   ├── kmm/                   ← KMM data file parser (phase 0/1)
│   ├── istufe/                ← chassis ↔ I-Stufe registry (phase 1)
│   ├── syscalls/              ← NFS-specific CABI syscalls (phase 1)
│   ├── flash/                 ← flash orchestration (phase 3)
│   └── fsc/                   ← FSC + certificate ops (phase 2)
└── apps/
    └── web/                   ← Svelte 5 flash GUI (phase 3)
```

External deps (workspace links to existing repos):

```json
{
  "dependencies": {
    "@emdzej/inpax-parser": "workspace:*",
    "@emdzej/inpax-cabi-provider": "workspace:*",
    "@emdzej/inpax": "workspace:*",
    "@emdzej/ediabasx-core": "workspace:*",
    "@emdzej/ncsx-cabd": "workspace:*",
    "@emdzej/ncsx-daten": "workspace:*"
  }
}
```

Same monorepo shape as `ncsx` and `inpax`. No app code until phase 1
work has a real ECU read to demo against — until then it's all
research + parsers.

## 10. Phase 5 design — flash + safety surface 2026-05-25

Phase 5 reconstructs winkfpt's actual flash-programming flow in
TypeScript. The Ghidra walk (§9.6) confirmed this lives **host-side**
in C functions (`coapiKfProgSgD2`, `coapiKfProgSgDevelop`,
`coapiKfProgSgDevelopWithAif`), NOT in the IPO slot table. Phase 5 is
therefore an orchestrator on top of `@emdzej/nfsx-fsc` and direct
`apiJob` calls against the SGBD — no new VM work, no new IPO slots.

This section is a **design only** — no v0.5.0 implementation work has
started.

### 10.1 Inputs the operator supplies

Modelled after the `BATCH/*.CTL` files in the NFS install (see
`FLASHBSP.CTL`):

```ini
[FGNUMMER]
FGN = WBAAB12345AB12345          ; chassis VIN

[ZBNUMMER]
ZBN0000 = 6915620                ; first ECU's target part number
ZBN0001 = 6915621                ; second ECU's target part number
ZBN0002 = 6915621                ; third ECU's target part number

[SGADRESSE]
SGADR0000 = 6A                   ; matching diagnostic addresses
SGADR0001 = D0
SGADR0002 = D1
```

The flash-binary files (`.S37`, BMW-specific containers) live in
operator-supplied paths — these are delivered through BMW dealer
channels, not bundled in the NFS install. nfsx takes the directory
location as a CLI flag.

### 10.2 The 7-stage flash pipeline

Modelled after `coapiKfProgSgDevelopWithAif` (the most complete entry
point, used when AIF write is required post-flash):

```
1. RESOLVE        — HWNR + ZBN → IPO + SGBD + transport (via
                    @emdzej/nfsx-resolver, Phase 2 surface)
2. PRECHECK       — battery voltage, ignition, ECU response, FSC valid
                    (via @emdzej/nfsx-fsc: checkFsc + getFsStatus)
3. AUTHENTICATE   — security access seed/key exchange (UDS 0x27 / 0x29)
4. SESSION        — switch ECU to programming mode (UDS 0x10 0x02)
5. TRANSFER       — block transfer of the firmware (UDS 0x34/0x36/0x37
                    or ECU-specific equivalent via SGBD apiJob)
6. AIF_WRITE      — write After-Information-File identity stamp
                    post-flash (see §9.4 for protocol details)
7. POSTCHECK      — ECU reset, status read, dependency rechecks
```

Each stage is a separate method on a `FlashSession` class so the
orchestrator can:
- emit progress events (per-stage start/finish)
- support abort between stages (but NOT inside transfer — see §10.5)
- run dry-run mode skipping stages 4-6 (the destructive ones)

### 10.3 Package layout

Two new packages on top of existing ones:

```
packages/flash-data/     @emdzej/nfsx-flash-data
  src/
    s37.ts               — S-record parser (Motorola S37 → memory map)
    container.ts         — BMW container format wrapper (TBD —
                           inspect a real flash file in v0.5 dev)
    integrity.ts         — CRC32 / checksum verification

packages/flash/          @emdzej/nfsx-flash
  src/
    session.ts           — FlashSession class (orchestrates the 7
                           stages above)
    precheck.ts          — Battery / ignition / FSC / status checks
    auth.ts              — Security access seed/key (UDS 0x27)
    transfer.ts          — Block transfer state machine
    aif-write.ts         — AIF post-flash write
    safety.ts            — Dry-run mode, abort gating, confirmation
    types.ts             — FlashOptions / FlashResult / events
```

`@emdzej/nfsx-flash` depends on:
- `@emdzej/nfsx-resolver`   for ECU → SGBD lookup
- `@emdzej/nfsx-fsc`        for pre-flash safety checks
- `@emdzej/nfsx-runtime`    for any IPO-driven sub-step (e.g. AIF write)
- `@emdzej/nfsx-flash-data` for parsing the flash binaries
- `@emdzej/ediabasx`        direct SGBD apiJob for the actual flash protocol

### 10.4 The safety surface

Programming an ECU's flash incorrectly **bricks the ECU**. We need
several layers of defence:

1. **Dry-run by default** — `FlashSession.run({dryRun: true})` is the
   default; the operator must opt-in to writes via explicit
   `{dryRun: false, confirmed: true}`.
2. **Per-stage confirmation** — the CLI prompts for `yes/no` before
   each destructive stage (TRANSFER, AIF_WRITE). Programmatic API
   takes a `confirm: (stage) => Promise<boolean>` callback.
3. **Vehicle precondition checks** — `precheck.ts`:
   - Battery voltage must be > 12.5V (read via PEM if available, or
     ECU's own battery DID)
   - Ignition must be in the right state (KL15 on, engine off)
   - Target ECU must respond to `IDENT` (basic comms sanity)
   - FSC slot for this part number must be valid (`checkFsc`)
4. **Firmware integrity check** — `flash-data/integrity.ts` verifies
   the S37 file's checksum before transfer. Pre-flash, not mid-flash —
   we never want to discover corruption halfway through.
5. **Abort vs. continue boundaries** — abort is safe BEFORE
   `SESSION` (stage 4); after that, ECU is in programming mode and
   abort risks leaving it bricked. Once in programming mode, the
   only way out is to finish OR to retry the transfer from scratch.
6. **Backup before flash** — if the ECU supports reading its current
   flash content (most modern ones do via UDS 0x23 or
   ECU-specific), save a copy before writing. Restore path TBD.
7. **No flash in CI / tests** — `FlashSession` requires a real
   `IEdiabasProvider` (not `MockEdiabasProvider`) for destructive
   stages. The mock throws if a destructive method is called.

### 10.5 Block transfer protocol

The TRANSFER stage is the load-bearing part — it streams kilobytes
to megabytes of firmware to the ECU. The protocol varies by ECU
family but follows the same shape:

```
Operator           Host (nfsx-flash)        ECU (via apiJob+SGBD)
────────           ─────────────────        ─────────────────────
                   beginTransfer()  ─────→  UDS 0x34 RequestDownload
                                           (addr range + length)
                                           ←──── max block size + ack
                   for each block:
                     transferBlock()  ──→  UDS 0x36 TransferData
                                           ←──── block ack
                   endTransfer()    ─────→  UDS 0x37 RequestTransferExit
                                           ←──── final ack
                   verify()         ─────→  UDS 0x31 RoutineControl
                                           (CRC verification routine)
                                           ←──── pass/fail
```

The exact UDS service IDs differ per ECU; the SGBD's `FLASH_SCHREIBEN`
job (or equivalent) wraps these. `transfer.ts` is a thin
state-machine wrapper around the per-ECU apiJob sequence — block size,
chunking, retries, ack timeouts.

**Block size negotiation** — most ECUs cap at 0x100..0x400 bytes per
TransferData; the SGBD answers with the max during RequestDownload.
nfsx-flash respects this; never assumes a value.

**Retry behaviour** — single retry per block on transient error
(NRC 0x21 BusyRepeatRequest, 0x23 ConditionsNotCorrect). Hard fail
on anything else.

**Progress reporting** — emit a `block-transferred` event per ack
with `{block, totalBlocks, bytesSent, bytesTotal}`. The CLI renders
a progress bar; programmatic API exposes the event for custom UIs.

### 10.6 AIF write

After a successful TRANSFER, the AIF write stamps the ECU with the
new firmware's identity (date, software ID, programmer ID, etc.) so
later read-flows (Phase 3's `SG_AIF_LESEN`) report the right values.

See `architecture.md §9.4` for the AIF protocol details. The write
side mirrors the read side: `apiJob("AIF_SCHREIBEN", para, ...)` with
the ECU-specific parameter format.

### 10.7 Reconstruction priorities

Implementation order, smallest-first:

1. **`@emdzej/nfsx-flash-data`** — S37 parser + integrity check. No
   network, no ECU. Unit-testable. ~1 day.
2. **`precheck.ts`** — wrap existing FscManager.checkFsc /
   getFsStatus / direct apiJob for battery/ignition reads. ~0.5 day.
3. **`auth.ts`** — security access seed/key. Requires real ECU to
   validate, but algorithm structure (read seed → compute key →
   send key) is well-known. ~1 day.
4. **`transfer.ts`** — block-transfer state machine. Testable
   against a mock provider that simulates RequestDownload /
   TransferData responses. ~2 days.
5. **`aif-write.ts`** — apiJob wrapper. ~0.5 day.
6. **`session.ts`** — orchestrate the 7 stages. ~1 day.
7. **CLI command** — `nfsx flash <ipo> --fgn X --zbn Y --flash-data
   <dir>` with dry-run default. ~0.5 day.

Total: ~6 days of pure TypeScript work, plus an open-ended
real-ECU validation cycle that depends on hardware availability +
willingness to brick test units.

### 10.8 What blocks Phase 5

- **No bricking budget** — without hardware we're willing to lose,
  validation of TRANSFER + AIF_WRITE is gated on getting test ECUs.
- **No real flash files** — the S37 / BMW container layout is
  inferred; without a real flash file to parse, `flash-data` stays
  speculative.
- **Per-ECU SGBD quirks** — each ECU family (DSC, DDE, MSD, ACSM)
  may have its own quirks in the flash protocol. Bringing up the
  first ECU type will surface these; later types reuse the same
  base + per-ECU adapters.

**Status today (2026-05-25):** design only. No code. The Phase 3 +
Phase 4 work that landed in v0.4.0 covers everything that's
implementable without hardware.

## 11. WinKFP `coapiKf*` surface — Ghidra-verified 2026-05-27

The flash-programming planner / orchestrator inside `winkfpt.exe`
exposes ~40 functions named `coapiKf*` (string xrefs starting at
0x005ff12c). These map roughly to our `@emdzej/nfsx-*` packages and
gave us a concrete reference for "how WinKFP actually does it" during
the Phase 5 wiring on the bench GS20.

### 11.1 Discovery / read-only functions

| WinKFP function | Mirrors / consumed by | What it does |
|---|---|---|
| `coapiKfGetHwReferenzFromSgD2` | `nfsx-flash precheck` | dispatch `HW_REFERENZ` IPO job, read `HW_REF_SG_KENNUNG` + `HW_REF_PROJEKT` cabd-pars |
| `coapiKfGetHwNrFromSgD2` | `precheck.sgIdent` | dispatch identity job, read `ID_BMW_NR` |
| `coapiKfGetAifFromSgD2` | `precheck.sgAif` | dispatch `SG_AIF_LESEN`, read `AIF_*` cabd-pars |
| `coapiKfGetProgOrderBsuD2` | `precheck.sgStatus` + planner | dispatch `SG_STATUS_LESEN`, read `SG_STATUS` / `PROG_TYP` / `PROG_ORDER` cabd-pars |
| `coapiKfGetEcuAddrFromSgMember` | `nfsx-resolver` | resolve diag address from SG member |
| `coapiKfGetInterface` | `nfsx-resolver prgifsel` | which transport/interface to use |
| `coapiKfGetSgMember` | `nfsx-resolver kfconf` | which SG-member descriptor applies |
| `coapiKfReadKfConfTabD2` / `_driver` | `nfsx-resolver kfConf` | KFCONF table reader |
| `coapiKfReadHwNrTabD2` | `nfsx-resolver hwnr` | HWNR.DA2 reader |
| `coapiKfReadZbNrTabD2` | `nfsx-resolver zbNrTab` (§3.7) | per-SG `.DAT` row reader, keyed by ZB-NR |
| `coapiKfGetGlobalPabdSgbd` | `nfsx-runtime` | global PABD-SGBD context |

### 11.2 Validation / "can we flash?" gate

`coapiKfCheckBsuPossibleD2` (FUN_00447d10) is **pure SP-Daten lookup**
— doesn't touch the ECU. Reads the KFCONF table + an IST/SOLL mapping
table (`SGBEZ_IST`, `ZZZPPP_IST`, `HWNR_IST`, `SGBEZ_SOLL`,
`ZZZPPP_SOLL`, `HWNR_SOLL`, `WDP_JA_NEIN` columns) and decides
whether the current state can upgrade to the target.

Output codes (extracted from the function's logCoapiError calls):

| Code | Meaning (inferred) |
|---|---|
| OK (`local_3f0 == 1`) | upgrade allowed |
| `0x4a8` | wrong target type |
| `0x4a7` | upgrade not permitted from current state |
| `0x4a6` | no match |
| `0x3fe` | configuration error |
| `0x424` | PROG_TYP or PROG_ORDER missing/zero |

Sibling: `coapiKfCheckBsuPossibleForZbUpdateD2` handles ZB-only
updates (no firmware change, just configuration).

### 11.3 Programming functions

| WinKFP function | Mirrors |
|---|---|
| `coapiKfProgSgD2` | `nfsx-flash session` TRANSFER stage |
| `coapiKfProgSgDevelop` | dev-mode programming (no AIF write) |
| `coapiKfProgSgDevelopWithAif` | dev programming + post-flash AIF stamp |
| `coapiKfSetCABDParameterProgMode` | seed cabd-pars before programming |

### 11.4 The two-layer precheck pattern

Critical architectural observation from the precheck rewrite
(`packages/flash/src/precheck.ts`):

**Layer 1 — IPO-driven reads.** WinKFP dispatches `HW_REFERENZ`,
`SG_STATUS_LESEN`, `SG_IDENT_LESEN`, `SG_AIF_LESEN` via cabimain
(`coapiRunIpoJob`) and reads result cabd-pars by name (`SG_STATUS`,
`HW_REF_SG_KENNUNG`, `ID_BMW_NR`, `AIF_ZB_NR`, …). The IPO contains
ALL the chassis-specific bus knowledge — which ECU to query, which
SGBD job to invoke, which result names to expect. The host (WinKFP)
just dispatches and reads named cabd-pars.

**Layer 2 — SP-Daten cross-checks.** `coapiKfCheckBsuPossibleD2`
validates the cabd-par values against offline tables. No ECU
interaction.

**Notably absent: battery / ignition / KOMBI checks.** The strings
`KL15`, `ZUENDUNG`, `UBATT`, `SPANNUNG`, `KOMBI` (as standalone job
names) appear ZERO times in winkfpt.exe — the only related hit is
`KONF_PROGRAMMIERSPANNUNG_ANZEIGEN`, an `.ini` flag for whether to
*display* programming voltage to the operator. WinKFP does not gate
the flash on a hardcoded battery or ignition read. Don't reintroduce
this in `nfsx-flash`.

### 11.5 What WinKFP does NOT expose

WinKFP has no firmware-backup feature. There is no `coapiKfBackup*`
or `coapiKfReadFlash*` family — confirmed by full Ghidra walk across
the `coapiKf*` string table on 2026-05-27. BMW's design relies on
SP-Daten as the canonical firmware source: if you brick an ECU, the
recovery path is to re-flash from SP-Daten, not to restore from a
host-side ROM image.

### 11.6 The `ZIF_BACKUP` IPO job — on-ECU redundancy, NOT a host save

Initially this looked like the missing backup feature. It is not.
`ZIF_BACKUP` is the IPO surface for the ECU's **redundant identity
region** — a second copy of `ZIF` (Zustands-Identifikationsfeld /
state identification field) that the ECU itself maintains in a
flash region separate from the active firmware. Used by WinKFP as
a FALLBACK identity source, not as a host-disk backup.

Verified across three winkfpt.exe functions on 2026-05-27:

| Function | Address | What it does with ZIF_BACKUP |
|---|---|---|
| `FUN_00432300` | 0x432300 | dispatches ZIF_BACKUP IPO, reads result cabd-pars, appends to `REF.OUT` as audit log |
| `coapiKfCheckReferenzD2` | FUN_00450300 | if current ZIF reads garbage, falls back to ZIF_BACKUP for identity comparison |
| `coapiKfGetHwNrFromSgD2` | FUN_00445900 | if `SG_IDENT_LESEN` gives non-7-digit BMW_NR, falls back to ZIF_BACKUP_BMW_HW |

**Result cabd-pars** published by the ZIF_BACKUP IPO dispatch:

| Cabd-par | Type | Meaning |
|---|---|---|
| `ZIF_BACKUP_SG_KENNUNG` | string | SG kennung (e.g. `G22`) |
| `ZIF_BACKUP_PROJEKT` | string | projekt code |
| `ZIF_BACKUP_PROGRAMM_STAND` | string | program version (e.g. `89D0`) |
| `ZIF_BACKUP_BMW_HW` | string | BMW HW-NR (7-digit, optional) |
| `ZIF_BACKUP_BMW_PST` | string | BMW programming-state number (optional) |
| `ZIF_BACKUP_STATUS` | ushort | dispatch status byte (logged as %X) |
| `ZIF_BACKUP_ENTRIES` | ushort | count of entries (referenced in WinKFP; semantic TBD) |

**Special status code:** `0x427` means "no backup data available"
(ECU's redundant region not populated). WinKFP's FUN_00432300
treats this as success — closes the audit file and returns OK. Our
`runBackup` records it in the report rather than treating it as a
dispatch failure.

**Bench validation (2026-05-27 against GS20 HWNR 7544721):**
ZIF_BACKUP returned populated:
- `ZIF_BACKUP_PROGRAMM_STAND = 89D0` matches the `0089D0` suffix
  in the file reference `G2210_0089D0` ✓
- `ZIF_BACKUP_BMW_HW = 7544721` matches HWNR ✓
- All identity fields agree with HW_REFERENZ + SG_IDENT_LESEN — healthy
  redundancy region, no partial-flash artefacts.

**`C:\NFS-Backup` (the directory)** — defined in `WinKFP.INI` as
`KomfortKonfPath`. Stores user-coding-comfort backups (coding
values the operator can edit), NOT firmware. Different workflow
entirely.

### 11.8 `SG_PROGRAMMIEREN` is THE flash primitive

Verified by Ghidra decomp of `FUN_00455780` = `coapiKfProgSgD2` on
2026-05-27. The flash is **a single IPO dispatch** of
`SG_PROGRAMMIEREN`. UDS-level concerns (0x27 SecurityAccess,
0x10 DiagnosticSession, 0x34/0x36/0x37 RequestDownload/TransferData/
RequestTransferExit) live **inside the IPO**, invisible to the host.

The host's job is:

1. Look up KFCONF + ZB-NR rows (the SP-Daten data layer, §3.7)
2. Set up cabd-pars that `SG_PROGRAMMIEREN` reads:
   - `DOMINANTE` (priority/mode, from runtime global)
   - `BSUTIME` (BSU time-budget hint)
   - `PROG_WITH_AIF` (0 = AIF written separately; 1 = inline)
   - `SCHNELLE_BAUDRATE` (ON/OFF — fast-baud opt-in)
   - If `PROG_WITH_AIF=1`: `AIF_FG_NR`, `AIF_DATUM`,
     `AIF_AENDERUNGS_INDEX`, `AIF_SW_NR`, `AIF_BEHOERDEN_NR`,
     `AIF_ZB_NR`, `AIF_SERIEN_NR`, `AIF_HAENDLER_NR`, `AIF_KM`,
     `AIF_PROG_NR`, `AIF_ADRESSE`
3. Dispatch `SG_PROGRAMMIEREN`. The IPO reads `.0PA`/`.0DA` from disk
   via the file-I/O syscall slots (`fileopen` / `fileread` /
   `filewrite` / `fileclose` — string xrefs at 0x00603f40 /
   0x00603d54 / 0x00603f28 / 0x00603f34 in winkfpt.exe) and drives
   the SGBD jobs (`SEED_KEY`, `FLASH_LOESCHEN`, `FLASH_SCHREIBEN`,
   `FLASH_SCHREIBEN_ENDE`, etc.) internally.
4. (Optional) If AIF wasn't inlined, dispatch `SG_AIF_SCHREIBEN`
   afterwards with the same `AIF_*` cabd-pars seeded.

**Pre-2026-05-27 design pitfall:** the original `@emdzej/nfsx-flash`
pipeline had explicit `AUTHENTICATE` / `SESSION` / `TRANSFER` /
`AIF_WRITE` stages implementing UDS handshakes directly on the
wire. That was architecturally wrong — WinKFP delegates all of that
to the IPO. The wire-level modules (`auth.ts`, `transfer.ts`,
`aif-write.ts`) were removed in the rewrite.

**Current `FlashSession` pipeline:**

| Stage | What it does |
|---|---|
| `RESOLVE` | Parse `.0PA`/`.0DA` for integrity (early validation, does NOT pass bytes to IPO) |
| `PRECHECK` | IPO-driven identity reads + FSC check (see §11.4) |
| `BACKUP` | IPO-driven audit snapshot (see §11.6, §11.7) |
| `PROGRAM` | Single `SG_PROGRAMMIEREN` IPO dispatch |
| `POSTCHECK` | Re-read HW_REFERENZ + SG_IDENT_LESEN, verify ECU still answers |

**Slot-implementation progress (2026-05-27):**

The host-side dispatch shape is correct + tested. Adding slot
handlers in `nfsx-runtime/src/system-functions.ts` unblocks SG_PROGRAMMIEREN
incrementally. Confirmed via mock-mode dispatch trace, the IPO's
slot-call order is:

| Step | Slot | Status |
|---|---|---|
| 1 | `CDHGetCabdPar` (read `JOBNAME`) | ✓ |
| 2 | `CDHapiInit` | ✓ |
| 3 | `CDHGetSgbdName` | ✓ |
| 4 | `CDHapiJob` (initial SGBD handshake — likely SEED_KEY) | ✓ |
| 5 | `CDHapiResultText` (read JOB_STATUS) | ✓ |
| 6 | `CDHBinBufCreate` (allocate firmware buffer) | ✓ #235 |
| 7+ | (presumed) `fileopen` + `fileread` to load `.0PA` | ✓ open/close/write done (#234); read TBD |
| later | `CDHBinBuf{Read,Write}{Byte,Word}` + `CDHBinBufToNettoData` for staging | ✓ #235 |
| later | `CDHapiJob` calls to `FLASH_LOESCHEN` / `FLASH_SCHREIBEN` / etc. | ✓ via existing CDHapiJob |

Task #234 (`fileopen` / `fileclose` / `filewrite` + `workingDir`
threading) + task #235 (the `CDHBinBuf*` family: 0x49–0x51, plus
`CDHCheckDataUsed`) both landed 2026-05-27. Implementation
deliberately replicates `ncsx-inpax-cabi-provider`'s tested
BinBuf logic in `packages/runtime/src/system-functions.ts`
rather than depending on it — the file already follows a
manual-handler pattern. Full migration to a CabiProvider-adapter
shape is filed as #236.

**Next blocker (task #237):** with BinBuf wired, `SG_PROGRAMMIEREN`
gets deeper into the IPO but throws a VM stack error in
`TestApiFehlerNoExit#7` (`Stack index out of bounds: 30 ...
pc=2 op=0x07 frameOffset=21 stackLen=28`). Hypothesis: a slot
handler is failing to write an out-ref the IPO downstream
expects to be non-zero. Diagnose by decompiling the IPO's
`TestApiFehlerNoExit` function via `inpax decompile --ips` +
cross-referencing the slot trace just before the crash.

**`fileread` slot:** still not directly observed — the IPO is
crashing before reaching file I/O. Slot number remains TBD,
deferred to whenever the trace progresses past step 6.

### 11.7 `nfsx backup` — our backup design

Faithful to WinKFP. The `nfsx backup` CLI command dispatches the
universal IPO reads (HW_REFERENZ + SG_STATUS_LESEN + SG_IDENT_LESEN
+ SG_AIF_LESEN + ZIF_BACKUP) and persists everything as
`<HWNR>-<ZB>-<timestamp>.json`. No SGBD-specific jobs — keeps the
backup chassis-agnostic, IPO-driven, and forward-compatible with
any SG that supports the standard cabimain entry-points.

NOT a brick-recovery image, and we don't pretend it is. If a flash
goes sideways, recovery comes from:
1. The ECU's on-board ZIF_BACKUP region (preserved identity during
   the failed write), and
2. Re-flashing the prior `.0PA`/`.0DA` from SP-Daten (if available
   in the drop).

If neither path works, the ECU is bricked. WinKFP makes the same
trade-off; we don't have a way to do better without breaking the
IPO-driven principle.
