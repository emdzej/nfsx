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
import { DEFAULT_CONFIG_PATH } from './config.js';

const program = new Command();

program
  .name('nfsx')
  .description('BMW NFS / WinKFP reconstruction CLI — SP-Daten lookups, IPO dispatch, flash orchestration.')
  .version('0.1.0');

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
  .option('--interface <name>', 'override `interface` from config (simulation|serial|kdcan|enet|gateway)')
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
  .description('Drive the 7-stage FlashSession orchestrator (DRY-RUN by default).')
  .requiredOption('--swt <ipo>', 'path to the 00swt*.ipo for the ECU transport (FSC stage)')
  .requiredOption('--ipo <path>', 'path to the target SG IPO (e.g. 10GD20.ipo) — used by PRECHECK')
  .requiredOption('--sgbd <name>', 'ECU SGBD basename (e.g. C_DSC_KWP)')
  .requiredOption('--firmware <path>', 'S37 firmware payload to flash')
  .option('--expected-hwnr <hwnr>', 'cross-check `ID_BMW_NR` from SG_IDENT_LESEN against this expected HWNR')
  .option('--working-dir <dir>', 'override the per-SG working directory (default: derive from --ipo as <spDaten>/data/<SG_TYP>/)')
  .option('--mock-file <path>', 'bypass EDIABAS-X entirely with a JSON-fed MockEdiabasProvider (rehearsal / unit-test path)')
  .option('--ediabas-config <path>', 'EDIABAS-X config file (default: ~/.config/ediabasx/config.json)')
  .option('--interface <name>', 'override `interface` from config (simulation|serial|kdcan|enet|gateway)')
  .option('--serial-port <path>', 'override `options.port` from config (serial device path)')
  .option('--serial-baud <rate>', 'override `options.baudRate` from config', parseBaud)
  .option('--gateway <host:port>', 'shortcut: switch to gateway interface with this address')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop (overrides config) — provides the SGBD/ecu/ directory')
  .option('--config <path>', `nfsx config file path (default ${DEFAULT_CONFIG_PATH})`)
  .option('--diag-addr <hex>', 'diagnostic address (audit/logging only)', parseDiagAddr)
  .option('--write', 'allow destructive operations (without this, dry-run only)', false)
  .option('--yes', 'skip per-stage confirmation prompts (requires --write)', false)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: FlashOptions) => {
    const code = await runFlash(opts);
    if (code !== 0) process.exit(code);
  });

// ── backup ──────────────────────────────────────────────────────────
program
  .command('backup')
  .description(
    'Capture target SG identity + ZIF backup region via IPO dispatches (mirrors WinKFP\'s audit backup; not a brick-recovery image).',
  )
  .requiredOption('--ipo <path>', 'path to the target SG IPO (e.g. 10GD20.ipo)')
  .requiredOption('--sgbd <name>', 'ECU SGBD basename (e.g. 10GD20)')
  .option('-o, --output-dir <dir>', 'where to write the JSON snapshot', './backups')
  .option('--expected-hwnr <hwnr>', 'expected HWNR (cross-check vs ID_BMW_NR)')
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
  swt: string;
  ipo: string;
  sgbd: string;
  firmware: string;
  expectedHwnr?: string;
  workingDir?: string;
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
  json: boolean;
}

export interface BrowseOptions {
  hwnr?: string;
  zbAlt?: string;
  spDaten?: string;
  config?: string;
}

export interface BackupOptions {
  ipo: string;
  sgbd: string;
  outputDir: string;
  expectedHwnr?: string;
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
