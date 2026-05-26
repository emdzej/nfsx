#!/usr/bin/env node
/**
 * `nfsx` — the BMW NFS / WinKFP reconstruction CLI.
 *
 * Stack: commander (arg parsing) + chalk (terminal styling) + ink
 * (browse TUI). Each subcommand is a thin orchestration layer over
 * the corresponding `@emdzej/nfsx-*` library package — no business
 * logic lives in this app.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { runPlan } from './plan.js';
import { runRun } from './run.js';
import { runFlash } from './flash.js';
import { runBrowse } from './browse.js';

const DEFAULT_SP_DATEN =
  process.env.NFSX_SP_DATEN ?? join(homedir(), 'Downloads', 'E46_v74');

const program = new Command();

program
  .name('nfsx')
  .description('BMW NFS / WinKFP reconstruction CLI — SP-Daten lookups, IPO dispatch, flash orchestration.')
  .version('0.1.0');

// ── plan ────────────────────────────────────────────────────────────
program
  .command('plan')
  .description('Resolve a part number / SG / diag-addr through the SP-Daten lookup chain.')
  .option('--hwnr <hwnr>', 'BMW part number (e.g. 4010581)')
  .option('--sg-typ <name>', 'SG short name (e.g. ACC65)')
  .option('--diag-addr <hex>', 'diagnostic address (e.g. 0x12)', parseDiagAddr)
  .option('--zb-alt <zb>', 'current ZB-Nummer; also looks up the NPV upgrade target')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop', DEFAULT_SP_DATEN)
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
  .option('--mock-file <path>', 'JSON mock EDIABAS results (loaded into MockEdiabasProvider)')
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
  .requiredOption('--swt <ipo>', 'path to the 00swt*.ipo for the ECU transport')
  .requiredOption('--sgbd <name>', 'ECU SGBD basename (e.g. C_DSC_KWP)')
  .requiredOption('--firmware <path>', 'S37 firmware payload to flash')
  .option('--mock-file <path>', 'JSON mock EDIABAS results for rehearsal')
  .option('--diag-addr <hex>', 'diagnostic address (audit/logging only)', parseDiagAddr)
  .option('--write', 'allow destructive operations (without this, dry-run only)', false)
  .option('--yes', 'skip per-stage confirmation prompts (requires --write)', false)
  .option('--json', 'machine-readable JSON output', false)
  .action(async (opts: FlashOptions) => {
    const code = await runFlash(opts);
    if (code !== 0) process.exit(code);
  });

// ── browse (ink TUI) ────────────────────────────────────────────────
program
  .command('browse')
  .description('Interactive TUI — browse available updates per HWNR.')
  .option('--hwnr <hwnr>', 'initial HWNR (editable in the TUI)')
  .option('--zb-alt <zb>', 'initial ZB-Alt for NPV upgrade lookup')
  .option('--sp-daten <dir>', 'SP-Daten chassis drop', DEFAULT_SP_DATEN)
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

// Type contracts the action callbacks consume. Mirror commander's
// camel-cased property names. Imported by each handler's
// implementation file so the contract stays in one place.
export interface PlanOptions {
  hwnr?: string;
  sgTyp?: string;
  diagAddr?: number;
  zbAlt?: string;
  spDaten: string;
  json: boolean;
}

export interface RunOptions {
  ipoPath: string;
  job: string;
  sgbd?: string;
  mockFile?: string;
  trace: boolean;
  json: boolean;
}

export interface FlashOptions {
  swt: string;
  sgbd: string;
  firmware: string;
  mockFile?: string;
  diagAddr?: number;
  write: boolean;
  yes: boolean;
  json: boolean;
}

export interface BrowseOptions {
  hwnr?: string;
  zbAlt?: string;
  spDaten: string;
}
