/**
 * `nfsx flash` — drive the FlashSession orchestrator from the CLI.
 *
 * **Defaults are safe**: dry-run is implicit unless `--write` is
 * explicitly passed. Even with `--write`, the operator is prompted
 * before each destructive stage (AUTHENTICATE / SESSION / TRANSFER
 * / AIF_WRITE). `--yes` opts out of prompts but is rejected unless
 * `--write` is also set.
 *
 * Provider: by default, builds an EDIABAS-X provider from
 * `~/.config/ediabasx/config.json` (real-vs-sim is ediabasx's call,
 * see [[feedback-ediabasx-responsibility]]). `--mock-file <path>` is
 * the one escape hatch — it BYPASSES ediabasx entirely with a
 * `MockEdiabasProvider`, handy for rehearsals.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { createInterface as createReadlineInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import {
  FlashSession,
  allowAllConfirmation,
  buildPromptConfirmation,
  type Stage,
  type ConfirmContext,
} from '@emdzej/nfsx-flash';
import type { FlashOptions } from './cli.js';
import { buildEdiabasProvider, type BuiltEdiabasProvider } from './ediabasx-provider.js';
import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';

export async function runFlash(opts: FlashOptions): Promise<number> {
  if (opts.yes && !opts.write) {
    process.stderr.write(chalk.red('error: --yes requires --write (nothing to skip in dry-run)\n'));
    return 2;
  }

  // EDIABAS provider — `--mock-file` bypasses ediabasx-x entirely
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

  if (!existsSync(opts.firmware)) {
    process.stderr.write(chalk.red(`error: firmware not found: ${opts.firmware}\n`));
    if (cleanup) await cleanup().catch(() => undefined);
    return 2;
  }
  const fwBytes = readFileSync(opts.firmware);
  const fwSlice = new Uint8Array(fwBytes.buffer, fwBytes.byteOffset, fwBytes.byteLength);
  const firmware = isPaDa(opts.firmware) ? { paDaBytes: fwSlice } : { s37Bytes: fwSlice };

  const workingDir = opts.workingDir ?? deriveWorkingDir(opts.ipo);
  if (!opts.json && workingDir) {
    process.stderr.write(chalk.dim(`workingDir: ${workingDir}\n`));
  }

  const session = new FlashSession({
    ecu: {
      sgbd: opts.sgbd,
      diagAddr: opts.diagAddr,
      ipoPath: opts.ipo,
      swtIpoPath: opts.swt,
      expectedHwnr: opts.expectedHwnr,
      workingDir,
    },
    firmware,
    ediabas,
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
  try {
    const result = await session.run({
      dryRun,
      confirm: dryRun
        ? undefined
        : opts.yes
          ? allowAllConfirmation
          : buildPromptFromStdin(),
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

    return result.ok ? 0 : 1;
  } finally {
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

/**
 * Derive the per-SG working directory from the IPO path.
 *
 * SP-Daten layout: `<spDaten>/sgdat/<NN><SG_TYP>.ipo`, and per-SG data
 * files live at `<spDaten>/data/<SG_TYP>/`. Strip the leading digits
 * from the IPO basename (e.g. `10GD20.ipo` → `GD20`), then sibling-
 * navigate from `sgdat/` to `data/<SG_TYP>/`.
 *
 * Returns `undefined` if the IPO path doesn't follow the SP-Daten
 * convention — the operator can pass `--working-dir` explicitly.
 */
function deriveWorkingDir(ipoPath: string): string | undefined {
  const ipoDir = dirname(resolvePath(ipoPath));
  const ipoName = basename(ipoPath);
  // Strip leading non-letter chars (digit prefix on NFS IPOs) and the
  // `.ipo` / `.ips` extension.
  const m = /^[^A-Za-z]*([A-Za-z][A-Za-z0-9_]*)\.ip[os]$/i.exec(ipoName);
  if (!m) return undefined;
  const sgTyp = m[1]!;
  // SP-Daten convention: sibling of `sgdat/` is `data/`.
  // dirname('<root>/sgdat') === '<root>' — the sibling-navigation pattern.
  const root = dirname(ipoDir);
  return resolvePath(root, 'data', sgTyp);
}

function buildPromptFromStdin(): (stage: Stage, ctx: ConfirmContext) => Promise<boolean> {
  const rl = createReadlineInterface({ input: process.stdin, output: process.stderr });
  return buildPromptConfirmation(async (q: string) => rl.question(q)) as (
    stage: Stage,
    ctx: ConfirmContext,
  ) => Promise<boolean>;
}
