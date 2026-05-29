/**
 * `nfsx directmode` — raw DS2 flashing (the "MS4x Flasher" path).
 *
 * Drives the ECU through the normal diagnostic session over K-line
 * (9600 8E1): IDENT → SEED/KEY → erase → write → verify. ECU type is
 * auto-detected from the IDENT response; the host then picks the right
 * region table for FULL or CALIBRATION-only flash.
 *
 * Subcommands:
 *   probe   — identify the ECU on the wire
 *   read    — dump flash regions to a file (full or calibration-only)
 *   write   — flash a BIN file (full or calibration-only)
 */
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  probe,
  readFlash,
  writeFlash,
  type DirectModeProgress,
  type FlashMode,
} from '@emdzej/nfsx-directmode';
import {
  verifyMs4xChecksums,
  rewriteMs4xChecksums,
} from '@emdzej/nfsx-flash-data';

type ForceVariant = 'MS42' | 'MS43' | 'GS20' | undefined;

export interface DirectModeBaseOptions {
  device: string;
  baud: number;
  forceVariant?: ForceVariant;
  json: boolean;
}

export interface DirectModeReadOpts extends DirectModeBaseOptions {
  output: string;
  mode: FlashMode;
}

export interface DirectModeWriteOpts extends DirectModeBaseOptions {
  input: string;
  mode: FlashMode;
  skipVerify: boolean;
  calculateChecksum: boolean;
  nonce: number;
}

function makeProgressPrinter(json: boolean): (p: DirectModeProgress) => void {
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

export async function runDirectmodeProbe(opts: DirectModeBaseOptions): Promise<number> {
  const onProgress = makeProgressPrinter(opts.json);
  try {
    const r = await probe(
      {
        device: opts.device,
        baud: opts.baud,
        defaultTimeoutMs: 3000,
        forceVariant: opts.forceVariant,
      },
      onProgress,
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify(r) + '\n');
    } else {
      process.stdout.write(chalk.green('OK ') + `variant=${r.variant}\n`);
      process.stdout.write(chalk.dim(`identity: ${r.identAscii}\n`));
    }
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}

export async function runDirectmodeRead(opts: DirectModeReadOpts): Promise<number> {
  const onProgress = makeProgressPrinter(opts.json);
  try {
    const { variant, image } = await readFlash(
      {
        device: opts.device,
        baud: opts.baud,
        defaultTimeoutMs: 5000,
        forceVariant: opts.forceVariant,
      },
      { mode: opts.mode },
      onProgress,
    );
    writeFileSync(resolve(opts.output), image);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ variant, mode: opts.mode, bytes: image.length, written: opts.output }) + '\n',
      );
    } else {
      process.stdout.write(
        chalk.green('OK ') +
          `${variant} ${opts.mode}-mode read: ${image.length} bytes → ${opts.output}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}

export async function runDirectmodeWrite(opts: DirectModeWriteOpts): Promise<number> {
  let image: Buffer;
  try {
    image = readFileSync(resolve(opts.input));
  } catch (err) {
    process.stderr.write(chalk.red(`error reading input: ${(err as Error).message}\n`));
    return 2;
  }

  if (opts.calculateChecksum) {
    // Auto-detect the variant from the BIN itself first (MS42 vs MS43 only —
    // GS20 isn't covered by flash-data's checksum module).
    try {
      const pre = verifyMs4xChecksums(image);
      if (!opts.json) {
        process.stderr.write(chalk.dim(`checksum precheck — variant ${pre.variant}\n`));
        for (const r of pre.results) {
          if (!r.supported) continue;
          const status = r.match ? chalk.green('match') : chalk.yellow('rewrite needed');
          process.stderr.write(
            chalk.dim(
              `  ${r.name.padEnd(14)} ${status} (stored 0x${r.stored.toString(16).padStart(4, '0').toUpperCase()})\n`,
            ),
          );
        }
      }
      if (!pre.allValid) {
        rewriteMs4xChecksums(image);
        if (!opts.json) process.stderr.write(chalk.dim(`  → recomputed CRC-16s before flashing\n`));
      }
    } catch (err) {
      if (!opts.json) {
        process.stderr.write(
          chalk.yellow(`(checksum precheck skipped: ${(err as Error).message})\n`),
        );
      }
    }
  }

  const onProgress = makeProgressPrinter(opts.json);
  try {
    const result = await writeFlash(
      image,
      {
        device: opts.device,
        baud: opts.baud,
        defaultTimeoutMs: 5000,
        forceVariant: opts.forceVariant,
      },
      { mode: opts.mode, skipVerify: opts.skipVerify, nonce: opts.nonce },
      onProgress,
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const v = result.verified ? chalk.green('verified') : chalk.yellow('unverified');
      process.stdout.write(
        chalk.green('OK ') +
          `${result.variant} ${result.mode}-mode write: ${result.bytesWritten} bytes ` +
          `(${result.bytesSkipped} 0xFF-skipped) — ${v}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`error: ${(err as Error).message}\n`));
    return 1;
  }
}
