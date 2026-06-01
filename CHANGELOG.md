# Changelog

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
