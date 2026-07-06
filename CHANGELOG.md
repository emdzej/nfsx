# Changelog

## 0.4.1 — 2026-07-06 — connect() idempotence

Prophylactic patch. `useEmbeddedAutoConnect`'s `$effect` re-runs on
any reactive state it reads, and `connect()`'s own
`connection.status = { kind: 'connecting' }` is a reactive write —
so the hook re-enters `connect()` before the first WebSocket
finishes opening, spinning up N parallel sockets. Adds the same
idempotence guard inpax's `connect()` has had since 0.11.0.

Not observed leaking in nfsx yet (ncsx reported ~20 sockets to
`/rpc/ediabasx` from a single Connect); the mechanism is identical
so fixing before it bites.

### Fixed

- `apps/web/src/lib/ediabas-session.svelte.ts` — early-return from
  `connect()` when `status.kind === 'connecting'` or when already
  `'connected'` with an active session.

## 0.4.0 — 2026-07-06 — Embedded Build + Dongle K-line

Adopts [ediabasx 0.8.0](https://github.com/emdzej/ediabasx/releases/tag/0.8.0)
and [inpax 0.12.0](https://github.com/emdzej/inpax/releases/tag/0.12.0),
adds a `--mode embedded` build for the [Bimmerz Box](https://github.com/emdzej/bimmerz-box)
dongle, and swaps every K-line consumer over to a dongle-hosted
JSON-RPC transport when running embedded. Attaches
`nfsx-web-embedded-<version>.zip` to every GitHub Release so dongle
packagers can drop the SPA onto the SD card without cloning the
monorepo.

Nothing changes for the hosted browser build at `nfsx.bimmerz.app` —
the embedded gates are compile-time `__EMBEDDED__` constants that
tree-shake in either build.

### Added

- **`RpcUartTransport`** (`apps/web/src/lib/rpc-uart-transport.ts`) —
  a `SerialTransport` implementation backed by the dongle firmware's
  `/rpc/uart/0` JSON-RPC-over-WebSocket endpoint. Wraps `uart.open`
  / `uart.configure` / `uart.write` / `uart.transact` / `uart.slowInit`
  / `uart.fastInit` / `uart.close` + streams `uart.rx` /
  `uart.revoked` / `uart.error` notifications. 14 vitest cases with
  a fake WebSocket cover open / write / read reassembly / timeout /
  revoke / close / malformed-input tolerance.
- **Embedded-mode auto-connect** (OEM scope) via
  `@emdzej/bimmerz-ui@0.2.0`'s `useEmbeddedAutoConnect` hook. Opens
  the same-origin `/rpc/ediabasx` RPC session once the install has
  mounted (`isReady: () => app.install !== null`), retries with
  exponential backoff on transient drops (1 → 2 → 4 → 8 → 16 → 30 s
  cap), disconnects cleanly on `beforeunload` / `pagehide`.
  Attempts stream to the `nfsx.autoconnect` bimmerz-logger category.
- **Directmode dongle path** — `directmode-session.svelte.ts`
  branches on `isEmbedded` and builds an `RpcUartTransport` bound
  to `${origin}/rpc/uart/0` instead of `navigator.serial.requestPort()`.
  The `Ds2DirectModeTransport` above the byte-pipe stays unchanged —
  DS2 framing / echo / baud switches work identically over the
  WebSocket. `exclusive: true` so a stray dashboard tab issuing an
  ediabasx `job` can't fight over the wire mid-flash.
- **Bootmode dongle path** — `bootmode-session.svelte.ts` swaps
  `WebBootmodeTransport` for a thin `RpcBootmodeTransport` adapter
  (dongle strips the K-line echo server-side via `consumeEcho: true`,
  so no echo-verify layer is needed above). BSL protocol code
  unchanged.
- **Embedded-build infra** — `lib/embedded.ts` (`isEmbedded`,
  `embeddedEndpoints()`), `__EMBEDDED__` compile-time constant,
  `build:embedded` + `preview:embedded` scripts, config-load
  overrides so persisted `mode` / `serverUrl` never fight the dongle
  origin, PWA + service worker dropped in the embedded build,
  base path rewritten to `/nfsx/`.
- **Bimmerz Box `manifest.json`** emitted by a small Vite plugin —
  `name` / `description` / `version` from `package.json` / `icon`
  (`requires: ["kline"]`). Schema: [bimmerz-box's App manifest
  section](https://github.com/emdzej/bimmerz-box#app-manifest).
- **`apps/web/README.md`** — first draft, covering the two scopes
  and the embedded-build workflow.

### Release artefacts

- **`nfsx-web-embedded-<version>.zip`** attached to each GitHub
  Release via `publish.yml`. Workflow runs
  `pnpm --filter @emdzej/nfsx-web build:embedded`, zips
  `dist-embedded/`, and uploads via `gh release upload`. Skipped on
  manual `workflow_dispatch` / dry runs.
- New `publish.yml` also runs `pnpm -r publish --provenance` on
  release-published, mirroring the ediabasx / inpax / ncsx pattern.

### Changed

- **`@emdzej/ediabasx-*` deps bumped `^0.7.1` → `^0.8.0`** across
  `nfsx-web`, `nfsx-cli`, `nfsx-flash`, `nfsx-runtime`,
  `nfsx-directmode`, `nfsx-ms45`.
- **`@emdzej/inpax-*` deps bumped `^0.11.1` → `^0.12.0`** across
  `nfsx-web`, `nfsx-cli`, `nfsx-flash`, `nfsx-runtime`, `nfsx-fsc`.

### Dependencies

- **`@emdzej/bimmerz-ui@^0.2.0`** — new dep of `@emdzej/nfsx-web`.
  Source-only Svelte package — added to `optimizeDeps.exclude` so
  each `.svelte` / `.svelte.ts` file is routed through
  `@sveltejs/vite-plugin-svelte`'s transform instead of esbuild's
  pre-bundler.
- **`vitest@^2.1.8`** — new devDep of `@emdzej/nfsx-web` for the
  `RpcUartTransport` unit tests.

## 0.3.0 — MS45 Flashing, Browser Bootmode

Fourth flash path (BMW MS45.0 / MS45.1 DMEs over the EDIABAS `D_Motor` SGBD), plus a functional bootmode flow in the web app. Bootmode package is now browser-safe end to end.

### @emdzej/nfsx-ms45 (new)

Clean-room reimplementation of terraphantm/MS45-Flasher for BMW MS45.0 (E46, DS2) and MS45.1 (E60/E65, BMW-FAST) DMEs. Credit: hassmaschine (DME disassembly), terraphantm (published RSA constants + reference flasher), bimmerlabs.

- Offline BIN helpers: CRC-32/MPEG-2 checksum verify/rewrite (parameter blob @ 0x100, dual program checksums @ 0x60000/0x60340), RSA-512 firmware signing verify/rewrite (parameter @ 0x174, program @ 0x60074) spanning external + MPC flash
- Security-access payload builder (level-3, RSA-512 + MD5 over `userID || serial || seed`)
- `Ms45Session` — probe / read / write choreography over the `IEdiabas.job(...)` primitive; handles the DS2 baud raise (MS45.0 → 115200) vs. BMW-FAST native path, `normaler_datenverkehr` traffic gating, `FLASH_SIGNATUR_PRUEFEN` post-write check
- Region tables, segment-header parsers (BE u32), address ↔ file-offset math for external @ 0xFFF00000 and MPC @ 0x0
- `MockIEdiabas` for downstream testing
- 121 tests across regions, checksum, signature, auth, ident, session-control, auth-flow, read-memory, erase, flash-block, verify, and full session orchestration (including end-to-end sign+CRC round-trip on the reassembled wire payload)

### @emdzej/nfsx-cli

- `nfsx ms45 probe` — DME identity: variant (MS45.0/MS45.1), VIN, HW/SW ref, diag protocol
- `nfsx ms45 read -m tune|full` — dump the 116 KB tune blob, or the 1 MB external flash + 448 KB MPC flash (`_MPC` suffix)
- `nfsx ms45 write -m tune|full` — erase + CRC-32/MPEG-2 recompute + RSA-512 sign + write + verify; `--skip-checksum`, `--skip-sign`, `--skip-verify`, `--yes` (skip confirmation)
- `nfsx ms45 checksum` — offline CRC-32 + RSA-sig verify, `--rewrite` for in-place recompute (or `-o` output), `--json`
- ECU-dir resolution: `--ecu-dir` → ediabasx `sgbdPath` → `<sp-daten>/ecu` fallback
- Bootmode CLI updated for the new package API — constructs `NodeBootmodeTransport` + `createNodeBundleLoader()` and passes them to session functions

### @emdzej/nfsx-bootmode (breaking)

- **`Buffer` → `Uint8Array`** across every source file — the package is now browser-safe (no `node:buffer` dependency in the shared code path)
- **Injectable transport + bundle loader**: `probeBootmode`, `readFullFlash`, `writeFullFlash`, `readFullFlashJmg`, `writeFullFlashJmg` now take `{ transport, bundle, ... }`. The caller constructs the transport, calls `open()`, and closes when done — the session functions no longer own the wire lifecycle
- New `BundleLoader` interface: async `getManifest()` / `getBlob(name)` / `verifyIntegrity()`. Implementations pick their preferred hash primitive (Node `crypto.createHash` or Web Crypto)
- New `bytes.ts` helpers (`concatU8`, `le16`, `le24`)
- Package split: browser-safe surface at `.` (interface + session + protocol helpers + `MockBootmodeTransport`), Node convenience at `./node` (`NodeBootmodeTransport`, `createNodeBundleLoader`, sync FS helpers), bundled blobs at `./bundled/*`

### @emdzej/nfsx-web

- **Functional BootmodeView**: Connect K-line (baud selector), Verify bundle (Web Crypto SHA-256 report with per-blob pass/fail), Probe (BSL handshake + testComm), Read (dumps full 512 KB `.bin`), Write (file picker + `--skip-verify` + `--calculate-checksum` MS4x CRC-16 recompute), progress bar, error banner, integrity report table
- `WebBootmodeTransport` — Web Serial-backed `BootmodeTransport` with its own background reader loop for sync `flushInput()` support (8N1, echo-verify)
- `createWebBundleLoader()` — Vite `?url` imports of the 7 hex blobs (LOADK / MINIMONK / JMG_LOADK / JMG_BLOB / ERASE_STUB / PROGRAMMER_STUB / PROBE_STUB); small blobs are inlined as base64 data URLs, no extra network round trips
- `bootmode-session.svelte.ts` — Svelte 5 `$state` module mirroring `directmode-session.svelte.ts` shape

### Docs

- `docs/ms45-flashing.md` — full MS45 protocol reference: memory model (dual flash spaces), SGBD job choreography, RSA-512 level-3 security access, CRC-32/MPEG-2 checksums, firmware signing layout, command reference, credits
- README updated with MS45 as the fourth flash path + package table entry + docs link

### Web UX polish

- Primary-button contrast fix — swapped `text-zinc-950` (near-black on BMW-blue accent, ~1.6:1 on hover) to `text-white` across 7 button/tab call sites
- `Settings › Data` tab — install summary (root name + source pill + `EDIABAS/Ecu` and `EC-APPS/NFS/DATA` presence), Change folder / Forget actions, mirroring the ncsx pattern. Discovery deduped into a shared `install-discovery.ts` used by both `InstallPicker` and `SettingsDialog`
- Top-bar right cluster (install-pill / mode-pill / Settings / Connect) is now OEM-scope-only — hidden in Flashing where the sub-views (directmode / bootmode / checksum) manage their own K-line lifecycles independently of the shared ediabasx client

## 0.2.0 — Firmware Tune, Browser Directmode, Buffer-free Directmode

Offline firmware BIN editing (VIN, immobilizer, UIF), browser-safe directmode package, and a functional DirectmodeView in the web app.

### @emdzej/nfsx-flash-data
- BMW packed VIN codec: `encodeVin` (17 ASCII chars → 13 bytes) / `decodeVin` (13 bytes → 17 chars)
- Per-variant firmware layout tables (MS42 / MS43): UIF base, ISN offset, immo-clear range, ECU number, software version — addresses extracted from community TunerPro XDF patchlists
- `readVin` / `writeVin` — read from UIF row 0; write stamps all 14 rows
- `readImmoStatus` — virgin/paired detection + ISN hex
- `virginize` — 0xFF-fill the ISN + EWS pairing region (MS42: 66 B at 0x3EDE, MS43: 76 B at 0x3ED4)
- `readIsn`, `readEcuNumber`, `readSoftwareVersion`, `readUif` — field-level BIN access
- `resolveLayout` — auto-detect variant + return the matching layout table

### @emdzej/nfsx-directmode
- **Buffer → Uint8Array migration** across all source files — the package is now browser-safe (no `node:buffer` dependency)
- **Transport interface extraction**: `DirectModeTransport` interface + `buildRequestPayload` pure function in `transport-interface.ts`; Node-specific `NodeDirectModeTransport` moved to `node-transport.ts`
- **Subpath exports**: `"."` for browser-safe code, `"./node"` for `NodeDirectModeTransport`
- Tests migrated to Uint8Array inputs

### @emdzej/nfsx-cli
- `nfsx tune read -f <bin> --feature <name>` — read VIN, immo status, ISN, ECU number, software version, or full UIF table from a firmware BIN
- `nfsx tune apply -f <bin> --feature vin --value <VIN>` — encode + write VIN to all 14 UIF rows
- `nfsx tune apply -f <bin> --feature virginize` — clear immobilizer data for EWS re-pairing
- `--variant ms42|ms43` override; auto-detect by default
- `-o <path>` writes to a separate file instead of overwriting input
- Automatic checksum recompute (CRC-16 + add-32) after every apply; `--skip-checksum` to disable
- `--json` machine-readable output for all tune operations

### @emdzej/nfsx-web
- **DirectmodeView**: functional K-line connect/disconnect, probe (IDENT fields table), read (full/cal + baud selector + save-as .bin), write (file picker + mode + baud + verify toggle), progress bar
- `WebDirectModeTransport` wrapping `WebSerialTransport` + `Ds2Session` + `sendFastInit` from ediabasx
- Reactive session state via Svelte 5 `$state` runes

### Docs
- README: tune command reference with usage examples, related projects, Right to Repair, Support (sponsorship), License, Disclaimer

## 0.1.0 — Initial Release

BMW NFS ECU flashing toolchain: three verified flash paths (IPO-driven, direct DS2, C167 bootmode), structured CLI, and a browser-based UI.

### Packages

#### @emdzej/nfsx-data-files
- Parsers for all 7 NFS SGDAT file types: KMM_SIT, HWNR.DA2, KFCONF10.DA2, SGIDC, SGIDD, NPV, PRGIFSEL
- HWNR → SGBD/SWT/IPO lookup chain

#### @emdzej/nfsx-resolver
- Resolve flash plan from HWNR: SGBD, SWT, IPO, firmware path, working directory
- Surface auth, transport, and upgrade parsers

#### @emdzej/nfsx-runtime
- BEST2 VM runtime bridge for NFS IPOs (drop-in compatible with NCSEXPER CABI slots)
- CDHapiJob bridge, CDHBinBuf slots, file I/O overrides, CDHapiJobData/CDHGetApiJobByteData
- Syscall pop order driven from NCSEXPER_CABI_SLOTS
- Retry transient FLASH_SCHREIBEN / STATUS_UNBEKANNT errors in slot 0x0E

#### @emdzej/nfsx-fsc
- FSC/FreiSchaltCode host orchestrator — dispatch FSC-specific IPO jobs

#### @emdzej/nfsx-flash
- IPO-driven flash pipeline: precheck (SG_STATUS_LESEN), auth, AIF write, firmware transfer, verify
- WinKFP-compatible BinBuf framing for .0PA flash records
- HWNR-driven UX: auto-derive IPO, SGBD, SWT, firmware path
- Per-chunk progress reporting, retry backoff (default 200 ms)
- Pre-flash safety runbook + confirm prompt

#### @emdzej/nfsx-flash-data
- S37/S-record parser with integrity checks
- .0PA / .0DA parser and HWNR pairing logic
- MS42/MS43 CRC-16 checksum algorithm (verify + rewrite)

#### @emdzej/nfsx-directmode
- Raw DS2 flashing over K-line: IDENT, SEED/KEY auth, erase, write, verify
- ECU detection via hardware-reference dispatch (cmd 0x0D → 0x06 → 6-char key)
- Per-ECU region tables for MS42, MS43, GS20 (full + calibration modes)
- Split read/write region tables (read includes bootloader + checksum trailers)
- Baud-switch for bulk transfer (9600 / 19200 / 38400 / 62500 / 125000)
- 0xFF-skip optimisation on write
- Verify-by-readback with 0xFF-skip-aware comparison
- Erase block grouping (shared erase points across regions)
- Browser-safe: all Uint8Array, transport interface extracted for web use

#### @emdzej/nfsx-bootmode
- C167 bootmode flash via custom erase + program stubs
- Alternative monolithic secondary loader path (--alt)
- Stubs bundled as .hex, built via build-stubs script

### Apps

#### @emdzej/nfsx-cli
- `nfsx flash` — IPO-driven flash with HWNR auto-resolution
- `nfsx directmode probe/read/write` — raw DS2 flashing
- `nfsx bootmode` — C167 bootmode flash
- `nfsx checksum` — MS4x CRC-16 verify/rewrite
- `nfsx check` — pre-flash diagnostic check
- `nfsx browse` — full-screen ink TUI for NFS data exploration
- `nfsx configure` — interactive config editor (~/.config/nfsx)
- `nfsx run` — run arbitrary IPO jobs against a real ECU
- Commander-based CLI with JSON output mode

#### @emdzej/nfsx-web
- Svelte 5 + Vite + Tailwind PWA
- BMW bimmerz-theme (M-light blue accent, navy-tinted neutrals, dark mode)
- WebSerial, J2534 (OpenPort 2.0), and gateway connection modes
- OEM flash: browse installs, plan view, install picker
- Direct DS2: connect K-line, probe, read (full/cal + baud), write (full/cal + baud + verify)
- Bootmode + checksum placeholder views
- Settings dialog, about dialog, error banner
- Offline-capable via service worker (Workbox)
