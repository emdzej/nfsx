/**
 * `nfsx verify` — read the ECU's current identity (HW_REFERENZ +
 * SG_IDENT_LESEN + SG_AIF_LESEN) and either print the current state
 * or diff it against a saved backup JSON.
 *
 * Use cases:
 *   - sanity-check after a flash: `nfsx verify --hwnr X --against
 *     ./backups/<HWNR>-<ZB>-<ts>.json`
 *   - quick read of who-am-I without writing a snapshot
 */

import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { runBackup } from '@emdzej/nfsx-flash';
import {
  resolveFlashContextLite,
  FlashContextError,
} from '@emdzej/nfsx-resolver';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import type { VerifyOptions } from './cli.js';
import { buildEdiabasProvider } from './ediabasx-provider.js';
import { resolveSpDaten, NfsxConfigError } from './config.js';

const KEY_FIELDS = [
  'ID_BMW_NR',
  'AIF_ZB_NR',
  'AIF_SW_NR',
  'AIF_FG_NR',
  'HW_REF_SG_KENNUNG',
  'HW_REF_PROJEKT',
] as const;

export async function runVerifyCmd(opts: VerifyOptions): Promise<number> {
  // 1. Resolve IPO + SGBD from --hwnr.
  let spDatenRoot: string;
  try {
    spDatenRoot = resolveSpDaten({ spDaten: opts.spDaten, configPath: opts.config });
  } catch (err) {
    process.stderr.write(
      chalk.red(`error: ${err instanceof NfsxConfigError ? err.message : String(err)}\n`),
    );
    return 2;
  }

  let ipoPath: string;
  let sgbd: string;
  try {
    const ctx = resolveFlashContextLite(spDatenRoot, opts.hwnr);
    ipoPath = ctx.ipoPath;
    sgbd = ctx.sgbd;
  } catch (err) {
    if (err instanceof FlashContextError) {
      process.stderr.write(chalk.red(`error: ${err.message}\n`));
      return 2;
    }
    throw err;
  }

  if (!opts.json) {
    process.stderr.write(chalk.dim(`HWNR ${opts.hwnr} → IPO=${ipoPath} SGBD=${sgbd}\n`));
  }

  // 2. Provider.
  let provider:
    | { provider: import('@emdzej/inpax-interfaces').IEdiabasProvider; cleanup: () => Promise<void>; summary: string }
    | { provider: import('@emdzej/inpax-interfaces').IEdiabasProvider; cleanup?: undefined; summary?: undefined };
  if (opts.mockFile) {
    provider = { provider: loadMockProvider(opts.mockFile) };
  } else {
    try {
      const built = await buildEdiabasProvider(opts);
      provider = built;
      if (!opts.json) process.stderr.write(chalk.dim(`EDIABAS-X: ${built.summary}\n`));
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
      return 2;
    }
  }

  try {
    // 3. Read current state. Reuse runBackup with the standard jobs —
    // it dispatches HW_REFERENZ + SG_IDENT_LESEN + SG_AIF_LESEN + …
    const report = await runBackup(
      { sgbd, ipoPath, swtIpoPath: '', expectedHwnr: opts.hwnr },
      provider.provider,
    );

    // 4. Optional diff against a saved backup.
    let baseline: Record<string, string> | undefined;
    if (opts.against) {
      try {
        const raw = readFileSync(opts.against, 'utf-8');
        const parsed = JSON.parse(raw);
        baseline =
          parsed?.report?.finalCabdPars ??
          parsed?.finalCabdPars ??
          undefined;
      } catch (err) {
        process.stderr.write(
          chalk.red(`error: failed to read --against ${opts.against}: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        return 2;
      }
      if (!baseline) {
        process.stderr.write(
          chalk.red(`error: --against ${opts.against} has no finalCabdPars to compare against\n`),
        );
        return 2;
      }
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            current: report.finalCabdPars,
            against: opts.against ?? null,
            baseline: baseline ?? null,
            diff: baseline ? diffPars(baseline, report.finalCabdPars) : null,
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    // 5. Text output.
    process.stdout.write(`\n${chalk.green('Current ECU state:')}\n`);
    for (const field of KEY_FIELDS) {
      const v = report.finalCabdPars[field];
      if (v) process.stdout.write(`  ${field.padEnd(20)} ${v}\n`);
    }

    if (baseline) {
      const diff = diffPars(baseline, report.finalCabdPars);
      process.stdout.write(`\n${chalk.cyan('Diff vs')} ${opts.against}:\n`);
      if (diff.length === 0) {
        process.stdout.write(`  ${chalk.green('(no changes in key fields)')}\n`);
      } else {
        for (const d of diff) {
          process.stdout.write(
            `  ${chalk.yellow(d.field.padEnd(20))} ${chalk.dim(d.before ?? '(unset)')} → ${d.after ?? '(unset)'}\n`,
          );
        }
      }
    }

    return 0;
  } finally {
    if (provider.cleanup) {
      try {
        await provider.cleanup();
      } catch (err) {
        process.stderr.write(
          chalk.yellow(`warning: ediabas cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`),
        );
      }
    }
  }
}

interface ParDiff {
  field: string;
  before?: string;
  after?: string;
}

function diffPars(before: Record<string, string>, after: Record<string, string>): ParDiff[] {
  const out: ParDiff[] = [];
  for (const field of KEY_FIELDS) {
    if (before[field] !== after[field]) {
      out.push({ field, before: before[field], after: after[field] });
    }
  }
  return out;
}

function loadMockProvider(path: string): MockEdiabasProvider {
  const raw = readFileSync(path, 'utf-8');
  const data = JSON.parse(raw) as Record<string, Record<string, Record<string, unknown>>>;
  const provider = new MockEdiabasProvider();
  for (const [ecu, jobs] of Object.entries(data)) {
    for (const [job, results] of Object.entries(jobs)) {
      provider.setSimpleResult(ecu, job, results);
    }
  }
  return provider;
}
