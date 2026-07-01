#!/usr/bin/env node
/**
 * `nfsx` — the BMW NFS / WinKFP reconstruction CLI.
 *
 * Stack: commander (arg parsing) + chalk (terminal styling) + ink
 * (full-screen `browse` + `configure` TUIs). Each subcommand is a
 * thin orchestration layer over the corresponding `@emdzej/nfsx-*`
 * library package — no business logic lives in this app.
 *
 * Config: `~/.config/nfsx/config.json` by default (mirrors
 * ediabasx-cli's convention). Per-command `--config <path>` picks
 * a different file. Per-command `--sp-daten <dir>` always wins
 * over both. See `config.ts`.
 */

import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { runPlan } from './plan.js';
import { runRun } from './run.js';
import { runFlash } from './flash.js';
import { runBrowse } from './browse.js';
import { runConfigure } from './configure.js';
import { runBackupCmd } from './backup.js';
import { runVerifyCmd } from './verify.js';
import { runCheckCmd } from './check.js';
import { runChecksumCmd } from './checksum.js';
import {
  runBootmodeProbe,
  runBootmodeRead,
  runBootmodeWrite,
  runBootmodeVerifyBundle,
  DEFAULT_BSL_ID,
} from './bootmode.js';
import {
  runDirectmodeProbe,
  runDirectmodeRead,
  runDirectmodeWrite,
} from './directmode.js';
import {
  runMs45Probe,
  runMs45Read,
  runMs45Write,
  runMs45Checksum,
} from './ms45.js';
import {
  runTuneRead,
  runTuneApply,
  type TuneFeature,
} from './tune.js';
import { DEFAULT_CONFIG_PATH } from './config.js';

const program = new Command();

program
  .name('nfsx')
  .description('BMW NFS / WinKFP reconstruction CLI — SP-Daten lookups, IPO dispatch, flash orchestration.')
  .version('0.3.0');

// ── configure ───────────────────────────────────────────────────────
program
  .command('configure')
  .description('Interactive config editor (writes to ~/.config/nfsx/config.json by default).')
  .option('-o, --output <path>', 'config file path', DEFAULT_CONFIG_PATH)
  .action(async (opts: { output: string }) => {
    const code = await runConfigure(opts);
    if (code !== 0) process.exit(code);
  });

// ── plan ────────────────────────────────────────────────────────────
program
  .command('plan')
  .description('Resolve a part number / SG / diag-addr through the SP-Daten lookup chain.')
  .option('--hwnr <hwnr>', 'BMW part number (e.g. 4010581)')
  .option('--sg-typ <name>', 'SG short name (e.g. ACC65)')
  .option('--diag-addr <hex>', 'diagnostic address (e.g. 0x12)', parseDiagAddr)
  .option('--zb-alt <zb>', 'current ZB-Nummer; also looks up the NPV upgrade target')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config)')
  .option('--config <path>', `config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: PlanOptions) => {
    const code = runPlan(opts);
    if (code !== 0) process.exit(code);
  });

// ── run ─────────────────────────────────────────────────────────────
program
  .command('run')
  .description("Execute an NFS IPO's cabimain dispatcher and print what it published.")
  .argument('<ipo-path>', 'path to the .IPO file (e.g. 16ACC65.ipo)')
  .option('--job <name>', 'JOBNAME to dispatch', 'JOB_ERMITTELN')
  .option('--sgbd <name>', 'SGBD basename for CDHGetSgbdName (required for apiJob flows)')
  .option('--mock-file <path>', 'bypass EDIABAS-X entirely with a JSON-fed MockEdiabasProvider (rehearsal / unit-test path)')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config (simulation|serial|kdcan|j2534|enet|gateway)')
  .option('--serial-port <path>', 'override `options.port` from config (serial device path)')
  .option('--serial-baud <rate>', 'override `options.baudRate` from config', parseBaud)
  .option('--gateway <host:port>', 'shortcut: switch to gateway interface with this address')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config) — provides the SGBD/ecu/ directory')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--working-dir <dir>', 'override the per-SG working directory used by fileopen syscalls (default: derive from --ipo-path)')
  .option('--trace', 'print every CABI syscall the IPO made', false)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (ipoPath: string, opts: RunOptions) => {
    const code = await runRun({ ...opts, ipoPath });
    if (code !== 0) process.exit(code);
  });

// ── flash ───────────────────────────────────────────────────────────
program
  .command('flash')
  .description('Drive the 5-stage FlashSession (RESOLVE / PRECHECK / BACKUP / PROGRAM / POSTCHECK). DRY-RUN by default.')
  .requiredOption('--hwnr <hwnr>', 'BMW part number — resolves SG_TYP + IPO + SGBD + SWT + working dir + firmware from SP-Daten')
  .option('--zb <zbnr>', 'target ZB-Nummer when the HWNR maps to multiple (use `nfsx plan --hwnr X` to list)')
  .option('--zb-alt <zb>', 'currently-burned ZB; lets npv.dat pick the upgrade target automatically')
  .option('--no-backup', 'skip the BACKUP stage (otherwise: always taken)')
  .option('--no-verify', 'skip POSTCHECK re-read of identity (otherwise: always taken)')
  .option('--ipo <path>', 'override the auto-resolved target SG IPO')
  .option('--swt <ipo>', 'override the auto-resolved 00swt*.ipo for the FSC stage')
  .option('--sgbd <name>', 'override the auto-resolved SGBD basename')
  .option('--firmware <path>', 'override the auto-resolved .0PA firmware file')
  .option('--working-dir <dir>', 'override the auto-resolved per-SG working directory')
  .option('--transport <name>', 'disambiguate when multiple 00swt*.ipo exist (e.g. ds2, kwp)')
  .option('--mock-file <path>', 'bypass EDIABAS-X entirely with a JSON-fed MockEdiabasProvider (rehearsal / unit-test path)')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config (simulation|serial|kdcan|j2534|enet|gateway)')
  .option('--serial-port <path>', 'override `options.port` from config (serial device path)')
  .option('--serial-baud <rate>', 'override `options.baudRate` from config', parseBaud)
  .option('--gateway <host:port>', 'shortcut: switch to gateway interface with this address')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config)')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--diag-addr <hex>', 'diagnostic address (audit/logging only)', parseDiagAddr)
  .option('--write', 'allow destructive operations (without this, dry-run only)', false)
  .option('--yes', 'skip per-stage confirmation prompts (requires --write)', false)
  .option('--max-retries <n>', 'max retries per FLASH_SCHREIBEN dispatch on transient errors (default: 2 = 3 total attempts)', parseNonNegativeInt)
  .option('--retry-backoff-ms <ms>', 'wait between retry attempts in ms (default: 200 — empirically required for K+DCAN bus drain)', parseNonNegativeInt)
  .option('--trace-file <path>', 'dump the full IPO slot trace + counters to JSON for diagnostics')
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: FlashOptions) => {
    const code = await runFlash(opts);
    if (code !== 0) process.exit(code);
  });

// ── backup ──────────────────────────────────────────────────────────
program
  .command('backup')
  .description(
    "Capture target SG identity + ZIF backup region (mirrors WinKFP's audit backup; not a brick-recovery image).",
  )
  .requiredOption('--hwnr <hwnr>', 'BMW part number — resolves IPO + SGBD from SP-Daten')
  .option('-o, --output-dir <dir>', 'where to write the JSON snapshot', './backups')
  .option('--ipo <path>', 'override the auto-resolved target SG IPO')
  .option('--sgbd <name>', 'override the auto-resolved SGBD basename')
  .option('--mock-file <path>', 'bypass EDIABAS-X entirely with a JSON-fed MockEdiabasProvider')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config')
  .option('--serial-port <path>', 'override serial port from config')
  .option('--serial-baud <rate>', 'override serial baud rate', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config)')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: BackupOptions) => {
    const code = await runBackupCmd(opts);
    if (code !== 0) process.exit(code);
  });

// ── check ───────────────────────────────────────────────────────────
program
  .command('check')
  .description('Read live ECU identity (HW_REFERENZ + SG_IDENT + SG_AIF + ZIF_BACKUP). Same dispatches as `backup` but no JSON output — quick sanity probe.')
  .requiredOption('--hwnr <hwnr>', 'BMW part number — resolves IPO + SGBD from SP-Daten')
  .option('--ipo <path>', 'override the auto-resolved target SG IPO')
  .option('--sgbd <name>', 'override the auto-resolved SGBD basename')
  .option('--mock-file <path>', 'bypass EDIABAS-X entirely with a JSON-fed MockEdiabasProvider')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config')
  .option('--serial-port <path>', 'override serial port from config')
  .option('--serial-baud <rate>', 'override serial baud rate', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config)')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: CheckOptions) => {
    const code = await runCheckCmd(opts);
    if (code !== 0) process.exit(code);
  });

// ── verify ──────────────────────────────────────────────────────────
program
  .command('verify')
  .description('Read the ECU\'s current identity and compare against a backup snapshot or the expected HWNR.')
  .requiredOption('--hwnr <hwnr>', 'BMW part number — resolves IPO + SGBD from SP-Daten')
  .option('--against <path>', 'a previous backup JSON to diff against (otherwise: just print current state)')
  .option('--mock-file <path>', 'bypass EDIABAS-X entirely with a JSON-fed MockEdiabasProvider')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config')
  .option('--serial-port <path>', 'override serial port from config')
  .option('--serial-baud <rate>', 'override serial baud rate', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config)')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: VerifyOptions) => {
    const code = await runVerifyCmd(opts);
    if (code !== 0) process.exit(code);
  });

// ── checksum ────────────────────────────────────────────────────────
program
  .command('checksum')
  .description('Verify or recompute MS42/MS43 firmware BIN checksums (CRC-16/CCITT). Hardware-independent.')
  .requiredOption('-f, --file <path>', 'path to the 512 KB MS42/MS43 firmware BIN')
  .option(
    '--variant <name>',
    'force the firmware variant (auto | ms42 | ms43). Default auto — uses the BIN\'s header pointer at 0x502CE.',
    parseChecksumVariant,
    'auto',
  )
  .option('--rewrite', 'recompute checksums and write back in-place (or to --output)', false)
  .option('-o, --output <path>', 'write rewritten BIN here instead of overwriting input (requires --rewrite)')
  .option('--json', 'machine-readable JSON output', false)
  .action((opts: ChecksumOptions) => {
    const code = runChecksumCmd(opts);
    if (code !== 0) process.exit(code);
  });

// ── bootmode ────────────────────────────────────────────────────────
const bootmode = program
  .command('bootmode')
  .description(
    'Infineon C167 BSL bootmode flashing (BMW MS42/MS43, Bosch ME 7.2). Bench-only: ECU must be pulled from the vehicle and BOOT pin grounded.',
  );

bootmode
  .command('verify-bundle')
  .description('SHA-256 verify the bundled MiniMon blobs (LOADK / MINIMONK / A29F400B).')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    const code = await runBootmodeVerifyBundle(opts);
    if (code !== 0) process.exit(code);
  });

bootmode
  .command('probe')
  .description('Handshake + read flash chip ID, then disconnect. Quick connectivity check.')
  .requiredOption('-d, --device <path>', 'serial port (e.g. /dev/cu.usbserial-XXXX)')
  .option('--baud <rate>', 'baud rate (BSL auto-bauds; 9600..115200 typical)', parseBaud, 19200)
  .option('--bsl-id <hex>', 'expected BSL ID byte (default C167CR=0xC5)', parseHexByte, DEFAULT_BSL_ID)
  .option(
    '--loader-delay <ms>',
    'inter-byte delay during loader upload',
    (v) => Number.parseInt(v, 10),
    0,
  )
  .option('--json', 'machine-readable output', false)
  .action(async (opts: BootmodeProbeOpts) => {
    const code = await runBootmodeProbe({
      device: opts.device,
      baud: opts.baud,
      bslId: opts.bslId,
      loaderInterByteDelayMs: opts.loaderDelay,
      json: opts.json,
    });
    if (code !== 0) process.exit(code);
  });

bootmode
  .command('read')
  .description('Read the full 512 KB flash from a bench-wired MS42/MS43/ME 7.2 ECU.')
  .requiredOption('-d, --device <path>', 'serial port')
  .requiredOption('-o, --output <path>', 'destination .bin path')
  .option('--baud <rate>', 'baud rate', parseBaud, 19200)
  .option('--bsl-id <hex>', 'expected BSL ID (default C167CR=0xC5)', parseHexByte, DEFAULT_BSL_ID)
  .option('--loader-delay <ms>', 'inter-byte delay during loader upload', (v) => Number.parseInt(v, 10), 0)
  .option('--alt', 'use alternative bootmode blob (monolithic flash driver, different protocol)', false)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: BootmodeReadOpts) => {
    const code = await runBootmodeRead({
      device: opts.device,
      baud: opts.baud,
      bslId: opts.bslId,
      loaderInterByteDelayMs: opts.loaderDelay,
      json: opts.json,
      output: opts.output,
      alt: opts.alt,
    });
    if (code !== 0) process.exit(code);
  });

bootmode
  .command('write')
  .description('Write a 512 KB .bin to a bench-wired MS42/MS43/ME 7.2 ECU. Unlocks, erases, programs, verifies.')
  .requiredOption('-d, --device <path>', 'serial port')
  .requiredOption('-i, --input <path>', 'source .bin path (exactly 524288 bytes)')
  .option('--baud <rate>', 'baud rate', parseBaud, 19200)
  .option('--bsl-id <hex>', 'expected BSL ID (default C167CR=0xC5)', parseHexByte, DEFAULT_BSL_ID)
  .option('--loader-delay <ms>', 'inter-byte delay during loader upload', (v) => Number.parseInt(v, 10), 0)
  .option('--skip-verify', 'skip the post-write readback verification', false)
  .option('--calculate-checksum', 'recompute MS42/MS43 CRC-16 checksums before flashing', false)
  .option('--alt', 'use alternative bootmode blob (monolithic flash driver, different protocol)', false)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: BootmodeWriteOpts) => {
    const code = await runBootmodeWrite({
      device: opts.device,
      baud: opts.baud,
      bslId: opts.bslId,
      loaderInterByteDelayMs: opts.loaderDelay,
      json: opts.json,
      input: opts.input,
      skipVerify: opts.skipVerify,
      calculateChecksum: opts.calculateChecksum,
      alt: opts.alt,
    });
    if (code !== 0) process.exit(code);
  });

// ── directmode (DS2-driven flashing) ────────────────────────────────
const directmode = program
  .command('directmode')
  .description(
    'Raw DS2 flashing over K-line (MS42/MS43/GS20). Drives the normal diagnostic session: IDENT → SEED/KEY → erase → write → verify. ECU detected from IDENT; full vs calibration-only modes use different region tables.',
  );

directmode
  .command('probe')
  .description('IDENT + ECU type detection over K-line.')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config')
  .option('--serial-port <path>', 'override serial port from config')
  .option('--serial-baud <rate>', 'override serial baud rate', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--variant <name>', 'force ECU variant (MS42 | MS43 | GS20)', parseVariant)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: DirectmodeProbeOpts) => {
    const code = await runDirectmodeProbe({
      ediabasConfig: opts.ediabasConfig,
      interface: opts.interface,
      serialPort: opts.serialPort,
      serialBaud: opts.serialBaud,
      gateway: opts.gateway,
      forceVariant: opts.variant,
      json: opts.json,
    });
    if (code !== 0) process.exit(code);
  });

directmode
  .command('read')
  .description('Dump flash regions to a file. Choose FULL (everything BMW writes) or CALIBRATION (data block only).')
  .requiredOption('-o, --output <path>', 'destination .bin path')
  .requiredOption('-m, --mode <mode>', 'flash mode: full | calibration', parseFlashMode)
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config')
  .option('--serial-port <path>', 'override serial port from config')
  .option('--serial-baud <rate>', 'override serial baud rate', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--variant <name>', 'force ECU variant (MS42 | MS43 | GS20)', parseVariant)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: DirectmodeReadOpts) => {
    const code = await runDirectmodeRead({
      ediabasConfig: opts.ediabasConfig,
      interface: opts.interface,
      serialPort: opts.serialPort,
      serialBaud: opts.serialBaud,
      gateway: opts.gateway,
      forceVariant: opts.variant,
      output: opts.output,
      mode: opts.mode,
      json: opts.json,
    });
    if (code !== 0) process.exit(code);
  });

directmode
  .command('write')
  .description('Flash a BIN to the ECU via DS2. Use --mode full or --mode calibration to pick the region table.')
  .requiredOption('-i, --input <path>', 'source .bin path (must match expected size for the variant)')
  .requiredOption('-m, --mode <mode>', 'flash mode: full | calibration', parseFlashMode)
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config')
  .option('--serial-port <path>', 'override serial port from config')
  .option('--serial-baud <rate>', 'override serial baud rate', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--variant <name>', 'force ECU variant (MS42 | MS43 | GS20)', parseVariant)
  .option('--nonce <n>', 'SEED/KEY nonce (1..23, default 7)', (v) => Number.parseInt(v, 10), 7)
  .option('--write-baud <rate>', 'K-line baud during write (9600 | 19200 | 38400 | 62500 | 125000; default 38400)', parseBaud, 38400)
  .option('--skip-verify', 'skip post-write readback verification', false)
  .option('--calculate-checksum', 'recompute MS42/MS43 CRC-16 checksums before flashing', false)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: DirectmodeWriteOpts) => {
    const code = await runDirectmodeWrite({
      ediabasConfig: opts.ediabasConfig,
      interface: opts.interface,
      serialPort: opts.serialPort,
      serialBaud: opts.serialBaud,
      gateway: opts.gateway,
      forceVariant: opts.variant,
      input: opts.input,
      mode: opts.mode,
      skipVerify: opts.skipVerify,
      calculateChecksum: opts.calculateChecksum,
      nonce: opts.nonce,
      writeBaud: opts.writeBaud,
      json: opts.json,
    });
    if (code !== 0) process.exit(code);
  });

// ── ms45 (SGBD-driven MS45 DME flashing) ────────────────────────────
const ms45 = program
  .command('ms45')
  .description(
    'BMW MS45.0 / MS45.1 DME flashing over the EDIABAS D_Motor SGBD. Probe / read / write / checksum. RSA-1024 firmware signing + CRC-32 checksum recompute are automatic on write; can be individually skipped.',
  );

ms45
  .command('probe')
  .description('IDENT the DME — variant (MS45.0/MS45.1), VIN, HW/SW ref, diag protocol.')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config (simulation|serial|kdcan|j2534|enet|gateway)')
  .option('--serial-port <path>', 'override `options.port` from config')
  .option('--serial-baud <rate>', 'override `options.baudRate` from config', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--ecu-dir <path>', 'directory containing the MS45 SGBD (default: ediabasx config sgbdPath, then <sp-daten>/ecu)')
  .option('--sgbd <name>', 'SGBD to dispatch against (default: D_Motor)')
  .option('--sp-daten <dir>', 'SP-Daten drop — only used to derive <sp-daten>/ecu fallback for --ecu-dir')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: Ms45ProbeOpts) => {
    const code = await runMs45Probe(opts);
    if (code !== 0) process.exit(code);
  });

ms45
  .command('read')
  .description('Read the DME. --mode tune dumps the 116 KB parameter blob; --mode full dumps both external flash (1 MB) and internal MPC flash (448 KB, `_MPC` suffix).')
  .requiredOption('-o, --output <path>', 'destination BIN path (for --mode full, MPC is written to <path>_MPC.<ext>)')
  .requiredOption('-m, --mode <mode>', 'tune | full', parseMs45Mode)
  .option('--ediabas-config <path>', 'EDIABAS-X config file')
  .option('--interface <name>', 'override interface')
  .option('--serial-port <path>', 'override serial port')
  .option('--serial-baud <rate>', 'override serial baud', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--ecu-dir <path>', 'directory containing the MS45 SGBD')
  .option('--sgbd <name>', 'SGBD to dispatch against (default: D_Motor)')
  .option('--sp-daten <dir>', 'SP-Daten drop — <sp-daten>/ecu fallback for --ecu-dir')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: Ms45ReadOpts) => {
    const code = await runMs45Read(opts);
    if (code !== 0) process.exit(code);
  });

ms45
  .command('write')
  .description('Flash a BIN into the DME. Erases the target region, recomputes CRC-32 + RSA signature, streams the payload, verifies. `--mode full` requires `--mpc <path>`.')
  .requiredOption('-i, --input <path>', 'input BIN (tune: 0x1D000 bytes; full: external 0x100000 bytes)')
  .requiredOption('-m, --mode <mode>', 'tune | full', parseMs45Mode)
  .option('--mpc <path>', 'MPC BIN (required for --mode full, must be 0x70000 bytes)')
  .option('--skip-checksum', 'do not recompute CRC-32 before flashing', false)
  .option('--skip-sign', 'do not recompute RSA signature before flashing', false)
  .option('--skip-verify', 'skip the post-flash FLASH_SIGNATUR_PRUEFEN check', false)
  .option('--yes', 'skip the "type FLASH to proceed" confirmation prompt', false)
  .option('--ediabas-config <path>', 'EDIABAS-X config file')
  .option('--interface <name>', 'override interface')
  .option('--serial-port <path>', 'override serial port')
  .option('--serial-baud <rate>', 'override serial baud', parseBaud)
  .option('--gateway <host:port>', 'shortcut: gateway interface')
  .option('--ecu-dir <path>', 'directory containing the MS45 SGBD')
  .option('--sgbd <name>', 'SGBD to dispatch against (default: D_Motor)')
  .option('--sp-daten <dir>', 'SP-Daten drop — <sp-daten>/ecu fallback for --ecu-dir')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--json', 'machine-readable output', false)
  .action(async (opts: Ms45WriteOpts) => {
    const code = await runMs45Write(opts);
    if (code !== 0) process.exit(code);
  });

ms45
  .command('checksum')
  .description('Verify or rewrite the CRC-32 + RSA signature on an MS45 BIN offline. Auto-detects tune (0x1D000 bytes) vs. full external flash (0x100000 bytes); full requires --mpc.')
  .requiredOption('-f, --file <path>', 'BIN file to check')
  .option('--mpc <path>', 'MPC BIN (required when --file is a 0x100000-byte external flash)')
  .option('--rewrite', 'recompute + rewrite in-place (or to --output)', false)
  .option('-o, --output <path>', 'write rewritten BIN here instead of overwriting --file (requires --rewrite)')
  .option('--skip-checksum', 'do not verify/rewrite CRC-32', false)
  .option('--skip-signature', 'do not verify/rewrite RSA signature', false)
  .option('--json', 'machine-readable output', false)
  .action((opts: Ms45ChecksumOpts) => {
    const code = runMs45Checksum(opts);
    if (code !== 0) process.exit(code);
  });

// ── tune (firmware BIN field read/apply) ────────────────────────────
const tune = program
  .command('tune')
  .description(
    'Read or modify MS42/MS43 firmware BIN fields (VIN, immobilizer, UIF). All operations are offline — no ECU connection needed.',
  );

tune
  .command('read')
  .description('Read a field from a firmware BIN.')
  .requiredOption('-f, --file <path>', 'path to the 512 KB firmware BIN')
  .requiredOption('--feature <name>', 'field to read (vin | immo | isn | ecu-number | software-version | uif)', parseTuneReadFeature)
  .option('--variant <name>', 'force variant (auto | ms42 | ms43)', parseTuneVariant)
  .option('--json', 'machine-readable JSON output', false)
  .action((opts: { file: string; feature: TuneFeature; variant?: 'MS42' | 'MS43'; json: boolean }) => {
    const code = runTuneRead(opts);
    if (code !== 0) process.exit(code);
  });

tune
  .command('apply')
  .description('Modify a field in a firmware BIN. Checksums are recomputed automatically unless --skip-checksum is passed.')
  .requiredOption('-f, --file <path>', 'path to the 512 KB firmware BIN')
  .requiredOption('--feature <name>', 'operation to apply (vin | virginize)', parseTuneApplyFeature)
  .option('--value <val>', 'value to write (required for vin)')
  .option('--variant <name>', 'force variant (auto | ms42 | ms43)', parseTuneVariant)
  .option('-o, --output <path>', 'write modified BIN here instead of overwriting input')
  .option('--skip-checksum', 'do not recompute checksums after modification', false)
  .option('--json', 'machine-readable JSON output', false)
  .action((opts: { file: string; feature: 'vin' | 'virginize'; value?: string; variant?: 'MS42' | 'MS43'; output?: string; skipChecksum: boolean; json: boolean }) => {
    const code = runTuneApply(opts);
    if (code !== 0) process.exit(code);
  });

// ── browse (ink TUI) ────────────────────────────────────────────────
program
  .command('browse')
  .description('Full-screen TUI — browse HWNRs in the SP-Daten drop with details + NPV upgrade lookup.')
  .option('--hwnr <hwnr>', 'pre-fill the filter')
  .option('--zb-alt <zb>', 'initial ZB-Alt for NPV upgrade lookup')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config)')
  .option('--config <path>', `config file path (default ${DEFAULT_CONFIG_PATH})`)
  .action(async (opts: BrowseOptions) => {
    const code = await runBrowse(opts);
    if (code !== 0) process.exit(code);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(chalk.red(`fatal: ${message}\n`));
  process.exit(1);
});

function parseDiagAddr(value: string): number {
  const v = value.trim().toLowerCase();
  const parsed = v.startsWith('0x') ? Number.parseInt(v.slice(2), 16) : Number.parseInt(v, 16);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) {
    throw new InvalidArgumentError(`"${value}" is not a valid hex byte (00..FF).`);
  }
  return parsed;
}

function parseBaud(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`"${value}" is not a valid baud rate.`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`"${value}" is not a non-negative integer.`);
  }
  return parsed;
}

function parseHexByte(value: string): number {
  const v = value.trim().toLowerCase();
  const parsed = v.startsWith('0x') ? Number.parseInt(v.slice(2), 16) : Number.parseInt(v, 16);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) {
    throw new InvalidArgumentError(`"${value}" is not a valid hex byte (00..FF).`);
  }
  return parsed;
}

function parseVariant(value: string): 'MS42' | 'MS43' | 'GS20' {
  const v = value.trim().toUpperCase();
  if (v === 'MS42' || v === 'MS43' || v === 'GS20') return v;
  throw new InvalidArgumentError(`"${value}" is not a known ECU variant (MS42 | MS43 | GS20).`);
}

function parseFlashMode(value: string): 'full' | 'calibration' {
  const v = value.trim().toLowerCase();
  if (v === 'full' || v === 'calibration') return v;
  throw new InvalidArgumentError(`"${value}" is not a valid flash mode (full | calibration).`);
}

function parseMs45Mode(value: string): 'tune' | 'full' {
  const v = value.trim().toLowerCase();
  if (v === 'tune' || v === 'full') return v;
  throw new InvalidArgumentError(`"${value}" is not a valid MS45 mode (tune | full).`);
}

function parseTuneReadFeature(value: string): TuneFeature {
  const v = value.trim().toLowerCase();
  const valid: TuneFeature[] = ['vin', 'immo', 'isn', 'ecu-number', 'software-version', 'uif'];
  if (valid.includes(v as TuneFeature)) return v as TuneFeature;
  throw new InvalidArgumentError(`"${value}" is not a valid read feature (${valid.join(' | ')}).`);
}

function parseTuneApplyFeature(value: string): 'vin' | 'virginize' {
  const v = value.trim().toLowerCase();
  if (v === 'vin' || v === 'virginize') return v;
  throw new InvalidArgumentError(`"${value}" is not a valid apply feature (vin | virginize).`);
}

function parseTuneVariant(value: string): 'MS42' | 'MS43' | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'auto') return undefined;
  if (v === 'ms42') return 'MS42';
  if (v === 'ms43') return 'MS43';
  throw new InvalidArgumentError(`"${value}" is not a valid variant (auto | ms42 | ms43).`);
}

function parseChecksumVariant(value: string): 'auto' | 'MS42' | 'MS43' {
  const v = value.trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === 'ms42') return 'MS42';
  if (v === 'ms43') return 'MS43';
  throw new InvalidArgumentError(`"${value}" is not a valid variant (auto | ms42 | ms43).`);
}

// Type contracts the action callbacks consume. Mirror commander's
// camel-cased property names. Imported by each handler's
// implementation file so the contract stays in one place.
export interface PlanOptions {
  hwnr?: string;
  sgTyp?: string;
  diagAddr?: number;
  zbAlt?: string;
  spDaten?: string;
  config?: string;
  json: boolean;
}

export interface RunOptions {
  ipoPath: string;
  job: string;
  sgbd?: string;
  workingDir?: string;
  /** Bypass EDIABAS-X entirely — supply a MockEdiabasProvider built from the JSON file. */
  mockFile?: string;
  /** EDIABAS-X config (path or per-field overrides). Anything else is ediabasx's concern. */
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  spDaten?: string;
  config?: string;
  trace: boolean;
  json: boolean;
}

export interface FlashOptions {
  /** Primary input — resolves the rest. */
  hwnr: string;
  /** Pick a specific ZB row when the HWNR has multiple candidates. */
  zb?: string;
  /** Currently-burned ZB; enables NPV upgrade-target lookup. */
  zbAlt?: string;
  /** false when `--no-backup` was passed (default true). */
  backup: boolean;
  /** false when `--no-verify` was passed (default true). */
  verify: boolean;
  /** Optional override paths/names (skip auto-resolve for that field). */
  ipo?: string;
  swt?: string;
  sgbd?: string;
  firmware?: string;
  workingDir?: string;
  transport?: string;
  /** Bypass EDIABAS-X entirely — supply a MockEdiabasProvider built from the JSON file. */
  mockFile?: string;
  /** EDIABAS-X config (path or per-field overrides). */
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  spDaten?: string;
  config?: string;
  diagAddr?: number;
  write: boolean;
  yes: boolean;
  maxRetries?: number;
  retryBackoffMs?: number;
  traceFile?: string;
  json: boolean;
}

export interface BrowseOptions {
  hwnr?: string;
  zbAlt?: string;
  spDaten?: string;
  config?: string;
}

export interface BackupOptions {
  hwnr: string;
  outputDir: string;
  ipo?: string;
  sgbd?: string;
  mockFile?: string;
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  spDaten?: string;
  config?: string;
  json: boolean;
}

export interface CheckOptions {
  hwnr: string;
  ipo?: string;
  sgbd?: string;
  mockFile?: string;
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  spDaten?: string;
  config?: string;
  json: boolean;
}

export interface VerifyOptions {
  hwnr: string;
  /** Path to a previous backup JSON file to diff against. */
  against?: string;
  mockFile?: string;
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  spDaten?: string;
  config?: string;
  json: boolean;
}

export interface ChecksumOptions {
  file: string;
  rewrite: boolean;
  output?: string;
  json: boolean;
  variant: 'auto' | 'MS42' | 'MS43';
}

interface BootmodeProbeOpts {
  device: string;
  baud: number;
  bslId: number;
  loaderDelay: number;
  json: boolean;
}

interface BootmodeReadOpts extends BootmodeProbeOpts {
  output: string;
  alt: boolean;
}

interface BootmodeWriteOpts extends BootmodeProbeOpts {
  input: string;
  skipVerify: boolean;
  calculateChecksum: boolean;
  alt: boolean;
}

interface DirectmodeProbeOpts {
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  variant?: 'MS42' | 'MS43' | 'GS20';
  json: boolean;
}

interface DirectmodeReadOpts extends DirectmodeProbeOpts {
  output: string;
  mode: 'full' | 'calibration';
}

interface DirectmodeWriteOpts extends DirectmodeProbeOpts {
  input: string;
  mode: 'full' | 'calibration';
  skipVerify: boolean;
  calculateChecksum: boolean;
  nonce: number;
  writeBaud: number;
}

interface Ms45BaseOpts {
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  ecuDir?: string;
  sgbd?: string;
  spDaten?: string;
  config?: string;
  json: boolean;
}

type Ms45ProbeOpts = Ms45BaseOpts;

interface Ms45ReadOpts extends Ms45BaseOpts {
  output: string;
  mode: 'tune' | 'full';
}

interface Ms45WriteOpts extends Ms45BaseOpts {
  input: string;
  mode: 'tune' | 'full';
  mpc?: string;
  skipChecksum: boolean;
  skipSign: boolean;
  skipVerify: boolean;
  yes: boolean;
}

interface Ms45ChecksumOpts {
  file: string;
  mpc?: string;
  output?: string;
  rewrite: boolean;
  skipChecksum: boolean;
  skipSignature: boolean;
  json: boolean;
}
