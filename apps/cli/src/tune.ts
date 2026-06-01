import { readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import {
  resolveLayout,
  readVin,
  writeVin,
  readImmoStatus,
  virginize,
  readIsn,
  readEcuNumber,
  readSoftwareVersion,
  readUif,
  rewriteMs4xChecksums,
  TuneError,
  type FirmwareLayout,
  type Ms4xEcuVariant,
} from '@emdzej/nfsx-flash-data';

// ── types ──────────────────────────────────────────────────────────

export type TuneFeature = 'vin' | 'immo' | 'isn' | 'ecu-number' | 'software-version' | 'uif';

export interface TuneReadOptions {
  file: string;
  feature: TuneFeature;
  variant?: Ms4xEcuVariant;
  json: boolean;
}

export interface TuneApplyOptions {
  file: string;
  feature: 'vin' | 'virginize';
  variant?: Ms4xEcuVariant;
  value?: string;
  output?: string;
  skipChecksum: boolean;
  json: boolean;
}

// ── read ───────────────────────────────────────────────────────────

export function runTuneRead(opts: TuneReadOptions): number {
  try {
    const bin = new Uint8Array(readFileSync(opts.file));
    const layout = resolveLayout(bin, opts.variant);

    if (opts.json) {
      const data = readFeatureJson(bin, layout, opts.feature);
      process.stdout.write(JSON.stringify({ variant: layout.variant, feature: opts.feature, ...data }, null, 2) + '\n');
      return 0;
    }

    printHeader(layout, opts.file);

    switch (opts.feature) {
      case 'vin': {
        const vin = readVin(bin, layout);
        console.log(`VIN: ${vin || chalk.dim('(empty)')}`);
        break;
      }
      case 'immo': {
        const status = readImmoStatus(bin, layout);
        console.log(`Immobilizer: ${status.virgin ? chalk.green('virgin') : chalk.yellow('paired')}`);
        console.log(`ISN: ${status.isnHex}`);
        break;
      }
      case 'isn': {
        const isn = readIsn(bin, layout);
        console.log(`ISN: ${toHex(isn)}`);
        break;
      }
      case 'ecu-number': {
        console.log(`ECU number: ${readEcuNumber(bin, layout) || chalk.dim('(empty)')}`);
        break;
      }
      case 'software-version': {
        console.log(`Software version: ${readSoftwareVersion(bin, layout) || chalk.dim('(empty)')}`);
        break;
      }
      case 'uif': {
        const rows = readUif(bin, layout);
        console.log(`UIF table (${layout.uifRows} rows × ${layout.uifRowSize} cols @ 0x${layout.uifBase.toString(16)}):\n`);
        for (const row of rows) {
          const vin = row.vin || chalk.dim('(empty)');
          const date = toHex(row.date);
          const soft = toHex(row.soft);
          const serv = toHex(row.serv);
          const asm = toHex(row.asm);
          console.log(`  UIF ${String(row.index + 1).padStart(2, '0')}  VIN=${vin}  DATE=${date}  SOFT=${soft}  SERV=${serv}  ASM=${asm}`);
        }
        break;
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof TuneError ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`error: ${msg}\n`));
    return 1;
  }
}

// ── apply ──────────────────────────────────────────────────────────

export function runTuneApply(opts: TuneApplyOptions): number {
  try {
    const bin = new Uint8Array(readFileSync(opts.file));
    const layout = resolveLayout(bin, opts.variant);
    const outPath = opts.output ?? opts.file;

    if (!opts.json) printHeader(layout, opts.file);

    switch (opts.feature) {
      case 'vin': {
        if (!opts.value) {
          process.stderr.write(chalk.red('error: --value <VIN> is required for vin apply\n'));
          return 1;
        }
        const oldVin = readVin(bin, layout);
        writeVin(bin, layout, opts.value.toUpperCase());
        const cksReport = recalcChecksums(bin, layout, opts.skipChecksum, opts.json);
        writeFileSync(outPath, bin);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ variant: layout.variant, feature: 'vin', old: oldVin, new: opts.value.toUpperCase(), checksums: cksReport, output: outPath }, null, 2) + '\n');
        } else {
          console.log(`VIN: ${oldVin || chalk.dim('(empty)')} → ${chalk.green(opts.value.toUpperCase())}`);
          printChecksumResult(cksReport, opts.skipChecksum);
          console.log(`Written to ${outPath}`);
        }
        break;
      }
      case 'virginize': {
        const before = readImmoStatus(bin, layout);
        if (before.virgin) {
          if (opts.json) {
            process.stdout.write(JSON.stringify({ variant: layout.variant, feature: 'virginize', status: 'already-virgin' }, null, 2) + '\n');
          } else {
            console.log(chalk.green('Already virgin — nothing to do.'));
          }
          return 0;
        }
        virginize(bin, layout);
        const cksReport = recalcChecksums(bin, layout, opts.skipChecksum, opts.json);
        writeFileSync(outPath, bin);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ variant: layout.variant, feature: 'virginize', status: 'done', clearedBytes: layout.immoClearSize, checksums: cksReport, output: outPath }, null, 2) + '\n');
        } else {
          console.log(`Immobilizer data: ${chalk.yellow('paired')} → ${chalk.green('virgin')}`);
          console.log(`Cleared ${layout.immoClearSize} bytes at 0x${layout.immoClearOffset.toString(16)}`);
          printChecksumResult(cksReport, opts.skipChecksum);
          console.log(`Written to ${outPath}`);
        }
        break;
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof TuneError ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`error: ${msg}\n`));
    return 1;
  }
}

// ── internal ───────────────────────────────────────────────────────

function printHeader(layout: FirmwareLayout, file: string): void {
  console.log(`${chalk.bold(layout.variant)} — ${file}\n`);
}

function toHex(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

interface ChecksumSummary {
  recomputed: boolean;
  allValid: boolean;
  count: number;
}

function recalcChecksums(bin: Uint8Array, layout: FirmwareLayout, skip: boolean, _json: boolean): ChecksumSummary | null {
  if (skip) return null;
  const report = rewriteMs4xChecksums(bin, { variant: layout.variant });
  return { recomputed: true, allValid: report.allValid, count: report.results.length };
}

function printChecksumResult(summary: ChecksumSummary | null, skipped: boolean): void {
  if (skipped || !summary) {
    console.log(chalk.dim('Checksums: skipped (--skip-checksum)'));
    return;
  }
  const status = summary.allValid ? chalk.green('valid') : chalk.yellow('recomputed');
  console.log(`Checksums: ${summary.count} recomputed — ${status}`);
}

function readFeatureJson(bin: Uint8Array, layout: FirmwareLayout, feature: TuneFeature): Record<string, unknown> {
  switch (feature) {
    case 'vin':
      return { vin: readVin(bin, layout) };
    case 'immo': {
      const s = readImmoStatus(bin, layout);
      return { virgin: s.virgin, isnHex: s.isnHex, rawHex: s.rawHex };
    }
    case 'isn':
      return { isn: toHex(readIsn(bin, layout)) };
    case 'ecu-number':
      return { ecuNumber: readEcuNumber(bin, layout) };
    case 'software-version':
      return { softwareVersion: readSoftwareVersion(bin, layout) };
    case 'uif':
      return {
        rows: readUif(bin, layout).map(r => ({
          index: r.index,
          vin: r.vin,
          date: toHex(r.date),
          soft: toHex(r.soft),
          serv: toHex(r.serv),
          asm: toHex(r.asm),
        })),
      };
  }
}
