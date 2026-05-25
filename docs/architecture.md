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

1. Remaining 4 data parsers (SGIDC.AS2, SGIDD.AS2, npv.dat,
   prgifsel.dat).
2. Wire an NFS IPO through inpax against a mock transport
   (Phase 3 — actually run a read-only IPO job like `Ident`).
3. Real-ECU read-only flows on hardware (Phase 3).
4. FSC + certificate management UI (Phase 4).
5. Actual flash + safety surface (Phase 5).

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
