/**
 * `nfsx checksum` — verify or recompute MS42/MS43 firmware checksums.
 *
 * Hardware-independent. Operates on a local 512 KB BIN file. Auto-detects
 * MS42 vs MS43 by reading the program-checksum header pointer. Computes
 * CRC-16/CCITT over the regions described by the firmware's own header
 * pointers, compares against stored values, optionally rewrites in place.
 *
 * MS43 also has two 32-bit addition checksums whose covered ranges vary
 * by firmware version (430037 / 430055 / ...); those are reported as
 * unsupported here — the stored value is shown, but recomputation needs
 * per-version range info this command does not yet ship.
 */

import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  verifyMs4xChecksums,
  rewriteMs4xChecksums,
  type Ms4xEcuVariant,
} from '@emdzej/nfsx-flash-data';

export type ChecksumVariantArg = 'auto' | 'MS42' | 'MS43';

export interface ChecksumOptions {
  file: string;
  rewrite?: boolean;
  output?: string;
  json?: boolean;
  /** `auto` = let the BIN's header pointer at 0x502CE decide. Default. */
  variant?: ChecksumVariantArg;
}

function resolveVariantOverride(v?: ChecksumVariantArg): Ms4xEcuVariant | undefined {
  if (!v || v === 'auto') return undefined;
  return v;
}

export function runChecksumCmd(opts: ChecksumOptions): number {
  let buf: Buffer;
  try {
    buf = readFileSync(resolve(opts.file));
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 2;
  }

  const variantOverride = resolveVariantOverride(opts.variant);

  let report;
  try {
    report = verifyMs4xChecksums(buf, { variant: variantOverride });
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 2;
  }

  if (opts.rewrite) {
    rewriteMs4xChecksums(buf, { variant: variantOverride });
    const target = opts.output ?? opts.file;
    try {
      writeFileSync(resolve(target), buf);
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
      return 2;
    }
    // Re-verify so the report reflects the on-disk state.
    report = verifyMs4xChecksums(buf, { variant: variantOverride });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, replaceBigInt, 2) + '\n');
    return report.allValid ? 0 : 1;
  }

  const hex2 = (n: number, w: number) =>
    `0x${n.toString(16).toUpperCase().padStart(w, '0')}`;

  const detection =
    !opts.variant || opts.variant === 'auto' ? chalk.dim('(auto-detected)') : chalk.yellow('(forced via --variant)');
  process.stdout.write(chalk.bold(`File:    ${opts.file}\n`));
  process.stdout.write(chalk.bold(`Variant: ${report.variant} `) + detection + '\n');
  process.stdout.write(chalk.bold(`Length:  ${report.fileLength} bytes\n`));
  process.stdout.write('\n');

  for (const r of report.results) {
    const head =
      r.kind === 'crc16'
        ? `${chalk.cyan(r.name.padEnd(20))} ${chalk.dim('CRC-16/CCITT @ ' + hex2(r.resultOffset, 5))}`
        : `${chalk.cyan(r.name.padEnd(20))} ${chalk.dim('add32        @ ' + hex2(r.resultOffset, 5))}`;
    process.stdout.write(head + '\n');

    if (!r.supported) {
      process.stdout.write(
        `  ${chalk.yellow('skipped')}  stored=${hex2(r.stored, 8)} (${r.note ?? 'not supported'})\n`,
      );
      continue;
    }

    const status = r.match ? chalk.green('MATCH') : chalk.red('MISMATCH');
    const storedHex = hex2(r.stored, r.resultBytes === 4 ? 8 : 4);
    const computedHex = hex2(r.computed, r.resultBytes === 4 ? 8 : 4);
    process.stdout.write(
      `  ${status}    stored=${storedHex} computed=${computedHex}` +
        (r.seed !== undefined ? ` seed=${hex2(r.seed, 4)}` : '') +
        '\n',
    );
    if (r.ranges.length > 0) {
      const rangesStr = r.ranges
        .map((rg) => `${hex2(rg.start, 5)}-${hex2(rg.end, 5)}`)
        .join(', ');
      process.stdout.write(`  ${chalk.dim('range:   ')}${rangesStr}\n`);
    }
  }

  process.stdout.write('\n');
  const supportedCount = report.results.filter((r) => r.supported).length;
  const matchCount = report.results.filter((r) => r.supported && r.match).length;
  const summary = report.allValid
    ? chalk.green(`OK — ${matchCount}/${supportedCount} verified`)
    : chalk.red(`MISMATCH — ${matchCount}/${supportedCount} verified`);
  process.stdout.write(summary + '\n');
  if (opts.rewrite) {
    process.stdout.write(
      chalk.dim(`(rewritten to ${opts.output ?? opts.file})\n`),
    );
  }
  return report.allValid ? 0 : 1;
}

function replaceBigInt(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
