/**
 * `nfsx bootmode` — Infineon C167 BSL bootmode flashing for MS42/MS43.
 *
 * Subcommands handled here:
 *   probe   — handshake + read flash chip ID + disconnect
 *   read    — handshake + dump full 512 KB to a file
 *   write   — handshake + erase + program + verify a 512 KB image
 *   verify  — sha-256 verify the bundled MiniMon blobs
 *
 * Requires a bench-pulled ECU with BOOT pin grounded. In-vehicle bootmode
 * is not supported (BOOT pin isn't routed to OBD). See `docs/raw-ds2-flashing.md`
 * §7 for the full procedure.
 */
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  readFullFlash,
  writeFullFlash,
  readFullFlashJmg,
  writeFullFlashJmg,
  probeBootmode,
  verifyBundleIntegrity,
  describeBundle,
  C167CR_BSL_ID,
  type BootmodeProgress,
} from '@emdzej/nfsx-bootmode';
import {
  verifyMs4xChecksums,
  rewriteMs4xChecksums,
} from '@emdzej/nfsx-flash-data';

export interface BootmodeBaseOptions {
  device: string;
  baud: number;
  bslId: number;
  loaderInterByteDelayMs?: number;
  json: boolean;
}

export interface BootmodeReadOptions extends BootmodeBaseOptions {
  output: string;
  alt: boolean;
}

export interface BootmodeWriteOptions extends BootmodeBaseOptions {
  input: string;
  skipVerify: boolean;
  calculateChecksum: boolean;
  alt: boolean;
}

function makeProgressPrinter(json: boolean): (p: BootmodeProgress) => void {
  if (json) return () => {};
  let lastStage = '';
  return (p) => {
    if (p.stage !== lastStage) {
      process.stderr.write(chalk.dim(`[${p.stage}] ${p.message}\n`));
      lastStage = p.stage;
    } else if (p.fraction !== undefined) {
      const pct = Math.round(p.fraction * 100);
      process.stderr.write(chalk.dim(`  ${pct}% — ${p.message}\r`));
      if (pct >= 100) process.stderr.write('\n');
    }
  };
}

export async function runBootmodeProbe(opts: BootmodeBaseOptions): Promise<number> {
  const onProgress = makeProgressPrinter(opts.json);
  try {
    const id = await probeBootmode(
      {
        device: opts.device,
        baud: opts.baud,
        defaultTimeoutMs: 2000,
        expectedBslId: opts.bslId,
        loaderInterByteDelayMs: opts.loaderInterByteDelayMs,
      },
      onProgress,
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify(id) + '\n');
    } else {
      process.stdout.write(chalk.green('OK ') + `bootmode handshake + comms test passed\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}

export async function runBootmodeRead(opts: BootmodeReadOptions): Promise<number> {
  const onProgress = makeProgressPrinter(opts.json);
  try {
    const cfg = {
      device: opts.device,
      baud: opts.baud,
      defaultTimeoutMs: 5000,
      expectedBslId: opts.bslId,
      loaderInterByteDelayMs: opts.loaderInterByteDelayMs,
    };
    const image = opts.alt
      ? await readFullFlashJmg(cfg, onProgress)
      : await readFullFlash(cfg, onProgress);
    writeFileSync(resolve(opts.output), image);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ written: opts.output, bytes: image.length }) + '\n');
    } else {
      process.stdout.write(chalk.green(`OK `) + `wrote ${image.length} bytes to ${opts.output}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}

export async function runBootmodeWrite(opts: BootmodeWriteOptions): Promise<number> {
  let image: Buffer;
  try {
    image = readFileSync(resolve(opts.input));
  } catch (err) {
    process.stderr.write(chalk.red(`error reading input: ${(err as Error).message}\n`));
    return 2;
  }

  if (opts.calculateChecksum) {
    let pre;
    try {
      pre = verifyMs4xChecksums(image);
    } catch (err) {
      process.stderr.write(
        chalk.red(`error: --calculate-checksum requires an MS42/MS43 BIN: ${(err as Error).message}\n`),
      );
      return 2;
    }
    if (!opts.json) {
      process.stderr.write(chalk.dim(`checksum precheck — variant ${pre.variant}\n`));
      for (const r of pre.results) {
        if (!r.supported) continue;
        const status = r.match ? chalk.green('match') : chalk.yellow('rewrite needed');
        process.stderr.write(
          chalk.dim(`  ${r.name.padEnd(14)} ${status} (stored 0x${r.stored.toString(16).padStart(4, '0').toUpperCase()})\n`),
        );
      }
    }
    if (!pre.allValid) {
      rewriteMs4xChecksums(image);
      if (!opts.json) {
        process.stderr.write(chalk.dim(`  → recomputed CRC-16s before flashing\n`));
      }
    }
  }

  const onProgress = makeProgressPrinter(opts.json);
  try {
    const cfg = {
      device: opts.device,
      baud: opts.baud,
      defaultTimeoutMs: 5000,
      expectedBslId: opts.bslId,
      loaderInterByteDelayMs: opts.loaderInterByteDelayMs,
    };
    const flashOpts = { skipVerify: opts.skipVerify };
    const result = opts.alt
      ? await writeFullFlashJmg(image, cfg, flashOpts, onProgress)
      : await writeFullFlash(image, cfg, flashOpts, onProgress);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ verified: result.verified }) + '\n');
    } else {
      const v = result.verified ? chalk.green('verified') : chalk.yellow('unverified');
      process.stdout.write(chalk.green(`OK `) + `flash complete — ${v}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}

export function runBootmodeVerifyBundle(opts: { json: boolean }): number {
  const report = verifyBundleIntegrity();
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.allValid ? 0 : 1;
  }
  const bundle = describeBundle();
  process.stdout.write(chalk.bold(`Source:  ${bundle.source}\n`));
  process.stdout.write(chalk.bold(`License: ${bundle.license}\n`));
  process.stdout.write('\n');
  for (const r of report.results) {
    const status = r.match ? chalk.green('OK   ') : chalk.red('FAIL ');
    process.stdout.write(`${status} ${r.name.padEnd(16)} sha256=${r.actualSha256}\n`);
    if (!r.match) {
      process.stdout.write(chalk.red(`       expected ${r.expectedSha256}\n`));
    }
  }
  process.stdout.write('\n');
  process.stdout.write(report.allValid ? chalk.green('Bundle integrity OK\n') : chalk.red('Bundle integrity FAILED\n'));
  return report.allValid ? 0 : 1;
}

export const DEFAULT_BSL_ID = C167CR_BSL_ID;
