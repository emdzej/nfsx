# nfsx — project status

**State (2026-05-25):** Parked pending hardware.

Everything implementable without a real ECU is done and tested.
Resume when test ECUs + a bricking budget are available.

## What ships today

| Package | Surface | Tests |
|---|---|---:|
| `@emdzej/nfsx-data-files` | 7 SP-Daten parsers (KMM_SIT, HWNR, KFCONF, SGID, NPV, PRGIFSEL, lexer) | 65 |
| `@emdzej/nfsx-resolver` | HWNR / SG_TYP / DiagAddr / Upgrade lookups across SP-Daten | 15 |
| `@emdzej/nfsx-runtime` | inpax-VM-based IPO dispatcher; 99-slot NCSEXPER CABI surface | 12 |
| `@emdzej/nfsx-fsc` | `FscManager.checkFsc / getFsc / getVin / getTime / getFsStatus` | 6 |
| `@emdzej/nfsx-flash-data` | Motorola S-record parser + memory-map coalescer + CRC32 | 30 |
| `@emdzej/nfsx-flash` | 7-stage flash orchestrator (RESOLVE → … → POSTCHECK) with safety surface | 12 |
| `@emdzej/nfsx-cli` | `nfsx plan / run / flash` commands | — |

**Total: 140 tests passing.** All packages held at `0.1.0` — no real release until
hardware bring-up validates the end-to-end path.

## Phase ledger

| Phase | Description | Status |
|---|---|---|
| **1** | Ghidra walk of `winkfpt.exe` + `KmmSrv.dll`; locate the CABI dispatcher | ✅ done — `CInterpreter::DoInterpret` at `FUN_004a2c00`, slot table at `state+0x50` (see `docs/architecture.md §9.6`) |
| **2** | SP-Daten parsers | ✅ done — all 7 parsers shipped |
| **3** | IPO dispatcher | ✅ done — `nfsx run 16ACC65.ipo --job JOB_ERMITTELN/HW_REFERENZ/SG_IDENT_LESEN/SG_AIF_LESEN/SG_STATUS_LESEN` all work end-to-end against `MockEdiabasProvider` |
| **4** | FSC + cert + identity orchestrator | ✅ done — `00swt*.ipo` family (6 transport variants, same 20-job vocabulary) wrapped by `FscManager` |
| **5** | Flash + safety surface | ✅ as far as mocks allow — 7-stage pipeline runs end-to-end via `nfsx flash --write --yes` against a full mock |

## Blocked on hardware

These items are real but can't usefully progress without an ECU on the cable:

1. **Real seed→key algorithm.** `auth.ts` defaults to `PassthroughKeyDerivation` which
   only works against ECUs with security access disabled. Production needs one of:
   BMW-internal SAUTH.DAT key tables, per-ECU `.PRG` reverse-engineering, or
   captured seed/key pairs from real sessions.
2. **Per-ECU SGBD quirks.** Block size limits, exact apiJob names, NRC handling, retry
   semantics — defaults in `transfer.ts` are reasonable but each ECU type needs a
   real-wire validation pass.
3. **Real flash binaries.** Current tests use hand-crafted S37 payloads. Any BMW
   container format wrapping the raw S-records is inferred.
4. **TRANSFER + AIF_WRITE end-to-end.** Requires ECUs we can afford to brick.

## Resume protocol

When hardware lands, in order of risk:

1. **Wire up a real `IEdiabasProvider`** from `@emdzej/ediabasx` and run an existing
   Phase 3 dispatcher demo (e.g. `nfsx run 16ACC65.ipo --job HW_REFERENZ`) against a
   live ECU. Validates the dispatcher against a real device instead of the mock.
2. **Run `nfsx flash` in dry-run against a real wire.** Exercises PRECHECK without
   writing anything. Surfaces apiJob / result-name mismatches between mock
   assumptions and real SGBD shapes.
3. **First real flash on a sacrificial ECU.** Pick the most recoverable type. Watch
   the transfer logs and iterate on per-ECU adapters.
4. **Backup-before-flash** (mentioned in `docs/architecture.md §10.4`) — implement
   before any production flash, not before the first lab flash.

## Key files

- `docs/architecture.md` — §1-§8 background + reconstruction plan, §9 lookup chain
  + Ghidra walk, §10 Phase 5 design + safety surface
- `packages/flash/src/session.ts` — orchestrator entry point
- `packages/flash/src/transfer.ts` — block-transfer state machine (most likely place
  to need per-ECU tweaks)
- `packages/flash/src/auth.ts` — `PassthroughKeyDerivation` stub; first thing to
  replace with a real strategy
- `packages/fsc/src/manager.ts` — Phase 4 FSC orchestrator, used by PRECHECK

## What's not in this status

- Test names / file:line citations — verify against current code (`pnpm -r test`)
  rather than trusting this doc, which freezes at the parked-on date above.
- Hardware shopping list — separate concern.
