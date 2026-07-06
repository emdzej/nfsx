/**
 * `nfsx flash` — drive the FlashSession orchestrator from the CLI.
 *
 * UX shape: the operator passes `--hwnr` and everything else is
 * derived via `resolveFlashContext` from the SP-Daten drop:
 *   - target IPO (KFCONF.ipoFile under sgdat/)
 *   - SGBD name (KFCONF.flashSgbd minus `.PRG`)
 *   - SWT IPO (glob `sgdat/00swt*.ipo`)
 *   - working dir (`<sp>/data/<SG_TYP>/`)
 *   - firmware `.0PA` (chosen from `<SG_TYP>.DAT` via single-candidate
 *     auto-pick / NPV upgrade / `--zb`)
 *
 * Per-field overrides (`--ipo`, `--swt`, `--sgbd`, `--firmware`,
 * `--working-dir`) skip auto-resolve for that field. The operator
 * never needs them on a normal SP-Daten drop.
 *
 * Defaults: dry-run unless `--write` is passed. Even with `--write`,
 * the operator is prompted before each destructive stage. `--yes`
 * skips the prompt but requires `--write`.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface as createReadlineInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import {
  FlashSession,
  allowAllConfirmation,
  buildPromptConfirmation,
  nodeStartRuntime,
  nodeBackupEmitter,
  type Stage,
  type ConfirmContext,
} from '@emdzej/nfsx-flash/node';
import {
  resolveFlashContext,
  FlashContextError,
  type FlashContext,
} from '@emdzej/nfsx-resolver/node';
import type { FlashOptions } from './cli.js';
import { buildEdiabasProvider, type BuiltEdiabasProvider } from './ediabasx-provider.js';
import { resolveSpDaten, NfsxConfigError } from './config.js';
import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';

export async function runFlash(opts: FlashOptions): Promise<number> {
  if (opts.yes && !opts.write) {
    process.stderr.write(chalk.red('error: --yes requires --write (nothing to skip in dry-run)\n'));
    return 2;
  }

  // 1. Resolve SP-Daten + flash context from --hwnr.
  let spDatenRoot: string;
  try {
    spDatenRoot = resolveSpDaten({ spDaten: opts.spDaten, configPath: opts.config });
  } catch (err) {
    process.stderr.write(
      chalk.red(`error: ${err instanceof NfsxConfigError ? err.message : String(err)}\n`),
    );
    return 2;
  }

  let ctx: FlashContext;
  try {
    ctx = resolveFlashContext(spDatenRoot, opts.hwnr, {
      zb: opts.zb,
      zbAlt: opts.zbAlt,
      swtIpoPath: opts.swt,
      transport: opts.transport,
    });
  } catch (err) {
    if (err instanceof FlashContextError) {
      process.stderr.write(chalk.red(`error: ${err.message}\n`));
      return 2;
    }
    throw err;
  }

  // Apply per-field overrides on top of the resolved context.
  const ipoPath = opts.ipo ?? ctx.ipoPath;
  const swtIpoPath = opts.swt ?? ctx.swtIpoPath;
  const sgbd = opts.sgbd ?? ctx.sgbd;
  const firmwarePath = opts.firmware ?? ctx.firmwarePath;
  const workingDir = opts.workingDir ?? ctx.workingDir;

  if (!opts.json) {
    process.stderr.write(chalk.dim(`HWNR ${opts.hwnr} → SG_TYP=${ctx.sgTyp} ZB=${ctx.selectedZb.zbNr}\n`));
    process.stderr.write(chalk.dim(`  IPO: ${ipoPath}\n`));
    process.stderr.write(chalk.dim(`  SGBD: ${sgbd}\n`));
    process.stderr.write(chalk.dim(`  SWT: ${swtIpoPath}\n`));
    process.stderr.write(chalk.dim(`  workingDir: ${workingDir}\n`));
    process.stderr.write(chalk.dim(`  firmware: ${firmwarePath}\n`));
    if (ctx.npvUpgrade) {
      process.stderr.write(
        chalk.dim(`  NPV upgrade: ZB ${ctx.npvUpgrade.zbAlt} → ${ctx.npvUpgrade.zbNeu}\n`),
      );
    }
  }

  // 2. EDIABAS provider — `--mock-file` bypasses ediabasx-x entirely
  // and supplies a hand-fed MockEdiabasProvider; everything else
  // routes through ediabasx (real or sim is its decision based on
  // the config file's `interface` field).
  let ediabas: IEdiabasProvider;
  let cleanup: (() => Promise<void>) | undefined;
  let built: BuiltEdiabasProvider | undefined;

  if (opts.mockFile) {
    ediabas = loadMockProvider(opts.mockFile);
  } else {
    try {
      built = await buildEdiabasProvider(opts);
      ediabas = built.provider;
      cleanup = built.cleanup;
      if (!opts.json) {
        process.stderr.write(chalk.dim(`EDIABAS-X: ${built.summary}\n`));
      }
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
      return 2;
    }
  }

  if (!existsSync(firmwarePath)) {
    process.stderr.write(chalk.red(`error: firmware not found: ${firmwarePath}\n`));
    if (cleanup) await cleanup().catch(() => undefined);
    return 2;
  }
  const fwBytes = readFileSync(firmwarePath);
  const fwSlice = new Uint8Array(fwBytes.buffer, fwBytes.byteOffset, fwBytes.byteLength);
  const firmware = isPaDa(firmwarePath) ? { paDaBytes: fwSlice } : { s37Bytes: fwSlice };

  // Build program-stage opts only when the operator passed override
  // values — otherwise let the runtime apply its defaults.
  const programOpts: import('@emdzej/nfsx-flash').FlashSessionOptions['program'] = {};
  if (opts.maxRetries !== undefined) programOpts.maxBinaryRetries = opts.maxRetries;
  if (opts.retryBackoffMs !== undefined) programOpts.retryBackoffMs = opts.retryBackoffMs;

  const session = new FlashSession({
    ecu: {
      sgbd,
      diagAddr: opts.diagAddr,
      ipoPath,
      swtIpoPath,
      expectedHwnr: opts.hwnr,
      workingDir,
    },
    firmware,
    ediabas,
    startRuntime: nodeStartRuntime,
    backup: { emitter: nodeBackupEmitter('./backups') },
    program: Object.keys(programOpts).length > 0 ? programOpts : undefined,
  });

  // Live progress to stderr so --json output stays clean.
  session.on('event', (e) => {
    if (opts.json) return;
    if (e.type === 'stage:start') process.stderr.write(`  ${chalk.cyan('▶')} ${e.stage}\n`);
    else if (e.type === 'stage:done') process.stderr.write(`  ${chalk.green('✓')} ${e.stage} ${chalk.dim(`(${e.durationMs}ms)`)}\n`);
    else if (e.type === 'stage:skipped') process.stderr.write(`  ${chalk.dim('·')} ${e.stage} ${chalk.dim(`skipped (${e.reason})`)}\n`);
    else if (e.type === 'log') {
      const color = e.level === 'error' ? chalk.red : e.level === 'warn' ? chalk.yellow : chalk.dim;
      process.stderr.write(`    ${color(e.level + ': ' + e.message)}\n`);
    }
  });

  const dryRun = !opts.write;
  let prompt: { confirm: (stage: Stage, ctx: ConfirmContext) => Promise<boolean>; close: () => void } | undefined;
  if (!dryRun && !opts.yes) prompt = buildPromptFromStdin();
  try {
    const result = await session.run({
      dryRun,
      skipBackup: opts.backup === false,
      skipPostcheck: opts.verify === false,
      confirm: dryRun ? undefined : opts.yes ? allowAllConfirmation : prompt!.confirm,
    });

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: result.ok,
            dryRun: result.dryRun,
            stagesRun: result.stagesRun,
            abortedAt: result.abortedAt,
            abortReason: result.abortReason,
            backupPath: result.backupPath,
            totalBytes: result.totalBytes,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(`\n${result.ok ? chalk.green('✓ flash complete') : chalk.red('✗ flash aborted')}\n`);
      process.stdout.write(`  dryRun: ${result.dryRun}\n`);
      process.stdout.write(`  stages: ${result.stagesRun.join(' → ')}\n`);
      if (result.abortedAt) {
        process.stdout.write(`  aborted at: ${chalk.yellow(result.abortedAt)}\n`);
        process.stdout.write(`  reason: ${result.abortReason}\n`);
      }
      if (result.backupPath) {
        process.stdout.write(`  backup:  ${result.backupPath}\n`);
      }
      process.stdout.write(`  totalBytes: ${result.totalBytes}\n`);
    }

    if (opts.traceFile && result.programDiagnostics) {
      try {
        writeFileSync(
          opts.traceFile,
          JSON.stringify(
            {
              firmwareStats: result.programDiagnostics.firmwareStats,
              ediabasJobs: {
                byKey: Object.fromEntries(result.programDiagnostics.ediabasJobs.byKey),
                byJob: Object.fromEntries(result.programDiagnostics.ediabasJobs.byJob),
                totalMs: result.programDiagnostics.ediabasJobs.totalMs,
                binByJob: Object.fromEntries(result.programDiagnostics.ediabasJobs.binByJob),
                binBytesPushed: result.programDiagnostics.ediabasJobs.binBytesPushed,
                binTotalMs: result.programDiagnostics.ediabasJobs.binTotalMs,
              },
              slotTrace: result.programDiagnostics.slotTrace,
            },
            null,
            2,
          ),
        );
        if (!opts.json) {
          process.stderr.write(chalk.dim(`trace dumped → ${opts.traceFile}\n`));
        }
      } catch (err) {
        process.stderr.write(
          chalk.yellow(`warning: failed to write --trace-file ${opts.traceFile}: ${err instanceof Error ? err.message : String(err)}\n`),
        );
      }
    }

    return result.ok ? 0 : 1;
  } finally {
    // Release stdin listener so the process can exit. The readline
    // interface (when allocated for the FLASH prompt) keeps the event
    // loop alive otherwise.
    if (prompt) prompt.close();
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        process.stderr.write(
          chalk.yellow(`warning: ediabas cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`),
        );
      }
    }
  }
}

function loadMockProvider(path: string): MockEdiabasProvider {
  const raw = readFileSync(path, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(chalk.red(`error: --mock-file ${path}: ${e instanceof Error ? e.message : String(e)}\n`));
    process.exit(2);
  }
  if (!data || typeof data !== 'object') {
    process.stderr.write(chalk.red(`error: --mock-file ${path}: expected an object\n`));
    process.exit(2);
  }
  const provider = new MockEdiabasProvider();
  for (const [ecu, jobs] of Object.entries(data as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [job, results] of Object.entries(jobs)) {
      // Convert JSON-friendly representations into the actual types
      // the provider stores: arrays of ints → Uint8Array, hex
      // strings prefixed with `0x:` → Uint8Array.
      const converted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(results)) {
        if (Array.isArray(v) && v.every((n) => typeof n === 'number')) {
          converted[k] = new Uint8Array(v as number[]);
        } else if (typeof v === 'string' && v.startsWith('0x:')) {
          const hex = v.slice(3);
          const bytes = new Uint8Array(hex.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          }
          converted[k] = bytes;
        } else {
          converted[k] = v;
        }
      }
      provider.setSimpleResult(ecu, job, converted);
    }
  }
  return provider;
}

/**
 * BMW SP-Daten firmware files use `.0PA` / `.0DA` (and case variants).
 * Everything else we route through the S37 parser.
 */
function isPaDa(path: string): boolean {
  return /\.0(PA|DA)$/i.test(path);
}

function buildPromptFromStdin(): {
  confirm: (stage: Stage, ctx: ConfirmContext) => Promise<boolean>;
  close: () => void;
} {
  const rl = createReadlineInterface({ input: process.stdin, output: process.stderr });
  const confirm = buildPromptConfirmation(async (q: string) => rl.question(q)) as (
    stage: Stage,
    ctx: ConfirmContext,
  ) => Promise<boolean>;
  return { confirm, close: () => rl.close() };
}
