/**
 * `nfsx backup` — capture the target SG's IPO-readable state as a
 * JSON snapshot. Mirrors WinKFP's audit-backup behaviour (no raw
 * flash dump — that doesn't exist in WinKFP either, see architecture
 * doc §11.6). Useful as a pre-flash forensic record.
 *
 * UX: take just `--hwnr` and resolve IPO + SGBD via the SP-Daten
 * lookup. `--ipo` / `--sgbd` are power-user overrides.
 */

import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import {
  runBackup,
  writeBackupFile,
  ZIF_BACKUP_NOT_AVAILABLE,
} from '@emdzej/nfsx-flash';
import {
  resolveFlashContextLite,
  FlashContextError,
} from '@emdzej/nfsx-resolver';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import type { BackupOptions } from './cli.js';
import { buildEdiabasProvider } from './ediabasx-provider.js';
import { resolveSpDaten, NfsxConfigError } from './config.js';

export async function runBackupCmd(opts: BackupOptions): Promise<number> {
  // Resolve SP-Daten + flash context (lite — no ZB selection; backup
  // doesn't pick a target firmware).
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
    if (err instanceof FlashContextError) {
      // Fall back to overrides if both are passed; otherwise surface.
      if (opts.ipo && opts.sgbd) {
        ipoPath = opts.ipo;
        sgbd = opts.sgbd;
      } else {
        process.stderr.write(chalk.red(`error: ${err.message}\n`));
        return 2;
      }
    } else {
      throw err;
    }
  }

  if (!opts.json) {
    process.stderr.write(chalk.dim(`HWNR ${opts.hwnr} → IPO=${ipoPath} SGBD=${sgbd}\n`));
  }

  // Same provider plumbing as `run` / `flash` — `--mock-file` bypasses
  // ediabasx entirely; otherwise build the real EDIABAS-X chain.
  let provider:
    | { provider: import('@emdzej/inpax-interfaces').IEdiabasProvider; cleanup: () => Promise<void>; summary: string }
    | { provider: import('@emdzej/inpax-interfaces').IEdiabasProvider; cleanup?: undefined; summary?: undefined };

  if (opts.mockFile) {
    provider = { provider: loadMockProvider(opts.mockFile) };
  } else {
    try {
      const built = await buildEdiabasProvider(opts);
      provider = built;
      if (!opts.json) {
        process.stderr.write(chalk.dim(`EDIABAS-X: ${built.summary}\n`));
      }
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
      return 2;
    }
  }

  try {
    const report = await runBackup(
      {
        sgbd,
        ipoPath,
        swtIpoPath: '', // backup doesn't need the SWT IPO
        expectedHwnr: opts.hwnr,
      },
      provider.provider,
    );

    const outputPath = writeBackupFile(report, opts.outputDir);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ outputPath, report }, null, 2) + '\n');
      return 0;
    }

    process.stdout.write(`\n${chalk.green('✓ backup saved')} → ${outputPath}\n\n`);

    // Surface key fields the operator should see.
    const bmwNr = report.finalCabdPars['ID_BMW_NR'];
    if (bmwNr) process.stdout.write(`  ID_BMW_NR:  ${bmwNr}\n`);
    const zb = report.finalCabdPars['AIF_ZB_NR'];
    if (zb) process.stdout.write(`  AIF_ZB_NR:  ${zb}\n`);
    const sw = report.finalCabdPars['AIF_SW_NR'];
    if (sw) process.stdout.write(`  AIF_SW_NR:  ${sw}\n`);
    const vin = report.finalCabdPars['AIF_FG_NR'];
    if (vin) process.stdout.write(`  AIF_FG_NR:  ${vin}\n`);
    const kennung = report.finalCabdPars['HW_REF_SG_KENNUNG'];
    if (kennung) process.stdout.write(`  HW kennung: ${kennung}\n`);
    const zifKennung = report.finalCabdPars['ZIF_BACKUP_SG_KENNUNG'];
    if (zifKennung) process.stdout.write(`  ZIF backup: ${zifKennung} (on-ECU redundancy)\n`);

    // Per-dispatch status summary.
    process.stdout.write(`\n  Dispatches:\n`);
    for (const [job, result] of Object.entries(report.ipoDispatches)) {
      if ('error' in result) {
        process.stdout.write(`    ${chalk.red('✗')} ${job} — ${result.error}\n`);
      } else if (result.setjobstatus === 0) {
        process.stdout.write(`    ${chalk.green('✓')} ${job}\n`);
      } else if (job === 'ZIF_BACKUP' && result.setjobstatus === ZIF_BACKUP_NOT_AVAILABLE) {
        process.stdout.write(`    ${chalk.dim('·')} ${job} (no backup data — ECU's redundant region not populated)\n`);
      } else {
        process.stdout.write(`    ${chalk.yellow('!')} ${job} (setjobstatus=${result.setjobstatus})\n`);
      }
    }

    process.stdout.write(
      `\n  ${chalk.dim('Note: this is an audit snapshot (mirrors WinKFP). NOT a brick-recovery image —')}\n` +
        `  ${chalk.dim('BMW does not back up firmware (SP-Daten is the canonical source).')}\n`,
    );

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
      provider.setSimpleResult(ecu, job, results);
    }
  }
  return provider;
}
