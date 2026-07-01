/**
 * `nfsx check` — quick live-ECU sanity probe.
 *
 * Same IPO dispatches as `backup` (HW_REFERENZ + SG_STATUS_LESEN +
 * SG_IDENT_LESEN + SG_AIF_LESEN + ZIF_BACKUP) but without writing a
 * JSON snapshot. Use it between operations to confirm the ECU is
 * alive and reachable — `plan` answers "what does SP-Daten say
 * about this part number"; `check` answers "what does the actual
 * ECU report right now".
 */

import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import {
  runBackup,
  ZIF_BACKUP_NOT_AVAILABLE,
} from '@emdzej/nfsx-flash';
import {
  resolveFlashContextLite,
  FlashContextError,
} from '@emdzej/nfsx-resolver/node';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import type { CheckOptions } from './cli.js';
import { buildEdiabasProvider } from './ediabasx-provider.js';
import { resolveSpDaten, NfsxConfigError } from './config.js';

export async function runCheckCmd(opts: CheckOptions): Promise<number> {
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
    ipoPath = opts.ipo ?? ctx.ipoPath;
    sgbd = opts.sgbd ?? ctx.sgbd;
  } catch (err) {
    if (err instanceof FlashContextError && opts.ipo && opts.sgbd) {
      ipoPath = opts.ipo;
      sgbd = opts.sgbd;
    } else if (err instanceof FlashContextError) {
      process.stderr.write(chalk.red(`error: ${err.message}\n`));
      return 2;
    } else {
      throw err;
    }
  }

  if (!opts.json) {
    process.stderr.write(chalk.dim(`HWNR ${opts.hwnr} → IPO=${ipoPath} SGBD=${sgbd}\n`));
  }

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
    const report = await runBackup(
      { sgbd, ipoPath, swtIpoPath: '', expectedHwnr: opts.hwnr },
      provider.provider,
    );

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            cabdPars: report.finalCabdPars,
            dispatches: Object.fromEntries(
              Object.entries(report.ipoDispatches).map(([k, v]) => [
                k,
                'error' in v ? { ok: false, error: v.error } : { ok: v.setjobstatus === 0, setjobstatus: v.setjobstatus },
              ]),
            ),
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    // Surface key identity fields.
    const get = (k: string): string | undefined => report.finalCabdPars[k];
    process.stdout.write(`\n${chalk.green('ECU state:')}\n`);
    for (const [label, key] of [
      ['ID_BMW_NR', 'ID_BMW_NR'],
      ['AIF_ZB_NR', 'AIF_ZB_NR'],
      ['AIF_SW_NR', 'AIF_SW_NR'],
      ['AIF_FG_NR (VIN)', 'AIF_FG_NR'],
      ['AIF_DATUM', 'AIF_DATUM'],
      ['HW_REF_SG_KENNUNG', 'HW_REF_SG_KENNUNG'],
      ['HW_REF_PROJEKT', 'HW_REF_PROJEKT'],
      ['ZIF_BACKUP_SG_KENNUNG', 'ZIF_BACKUP_SG_KENNUNG'],
    ] as const) {
      const v = get(key);
      if (v) process.stdout.write(`  ${label.padEnd(22)} ${v}\n`);
    }

    process.stdout.write(`\n  Dispatches:\n`);
    for (const [job, result] of Object.entries(report.ipoDispatches)) {
      if ('error' in result) {
        process.stdout.write(`    ${chalk.red('✗')} ${job} — ${result.error}\n`);
      } else if (result.setjobstatus === 0) {
        process.stdout.write(`    ${chalk.green('✓')} ${job}\n`);
      } else if (job === 'ZIF_BACKUP' && result.setjobstatus === ZIF_BACKUP_NOT_AVAILABLE) {
        process.stdout.write(`    ${chalk.dim('·')} ${job} (no backup data — ECU\'s redundant region not populated)\n`);
      } else {
        process.stdout.write(`    ${chalk.yellow('!')} ${job} (setjobstatus=${result.setjobstatus})\n`);
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
