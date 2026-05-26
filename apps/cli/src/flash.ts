/**
 * `nfsx flash` — drive the FlashSession orchestrator from the CLI.
 *
 * **Defaults are safe**: dry-run is implicit unless `--write` is
 * explicitly passed. Even with `--write`, the operator is prompted
 * before each destructive stage (AUTHENTICATE / SESSION / TRANSFER
 * / AIF_WRITE). `--yes` opts out of prompts but is rejected unless
 * `--write` is also set.
 *
 * Mock-driven execution: with `--mock-file`, exactly the same
 * pipeline runs against a `MockEdiabasProvider` — useful for
 * rehearsing a flash session before plugging in a real cable.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
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

export async function runFlash(opts: FlashOptions): Promise<number> {
  if (opts.yes && !opts.write) {
    process.stderr.write(chalk.red('error: --yes requires --write (nothing to skip in dry-run)\n'));
    return 2;
  }

  // EDIABAS provider — mock when --mock-file is set, otherwise we
  // fall back to a stub mock. Real-ECU support needs a wired-up
  // ediabasx provider; not in this CLI iteration.
  let ediabas: MockEdiabasProvider;
  if (opts.mockFile) {
    ediabas = loadMockProvider(opts.mockFile);
  } else {
    ediabas = new MockEdiabasProvider();
    process.stderr.write(
      chalk.yellow('note: no --mock-file and no real EDIABAS wired — using an empty mock.\n'),
    );
    process.stderr.write(
      chalk.yellow('      PRECHECK will fail without mock data or a real wire.\n\n'),
    );
  }

  if (!existsSync(opts.firmware)) {
    process.stderr.write(chalk.red(`error: firmware not found: ${opts.firmware}\n`));
    return 2;
  }
  const s37Bytes = readFileSync(opts.firmware);

  const session = new FlashSession({
    ecu: {
      sgbd: opts.sgbd,
      diagAddr: opts.diagAddr,
      swtIpoPath: opts.swt,
    },
    firmware: { s37Bytes: new Uint8Array(s37Bytes.buffer, s37Bytes.byteOffset, s37Bytes.byteLength) },
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
    } else if (e.type === 'block:transferred') {
      const pct = ((e.bytesSent / e.bytesTotal) * 100).toFixed(1);
      process.stderr.write(
        chalk.dim(`    block ${e.blockIndex + 1}/${e.totalBlocks} → ${e.bytesSent}/${e.bytesTotal} bytes (${pct}%)\n`),
      );
    }
  });

  const dryRun = !opts.write;
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
          bytesTransferred: result.bytesTransferred,
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
    process.stdout.write(`  bytes: ${result.bytesTransferred} / ${result.totalBytes}\n`);
  }

  return result.ok ? 0 : 1;
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

function buildPromptFromStdin(): (stage: Stage, ctx: ConfirmContext) => Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return buildPromptConfirmation(async (q: string) => rl.question(q)) as (
    stage: Stage,
    ctx: ConfirmContext,
  ) => Promise<boolean>;
}
