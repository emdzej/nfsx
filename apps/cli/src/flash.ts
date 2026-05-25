/**
 * `nfsx flash` — drive the FlashSession orchestrator from the CLI.
 *
 * **Defaults are safe**: `--dry-run` is implicit unless `--write` is
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
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { FlashSession, allowAllConfirmation, buildPromptConfirmation, type Stage } from '@emdzej/nfsx-flash';

interface FlashFlags {
  swtIpoPath?: string;
  sgbd?: string;
  diagAddr?: number;
  firmwarePath?: string;
  mockFile?: string;
  write: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
}

const HELP = `nfsx flash — flash an ECU through the FlashSession orchestrator.

Usage:
  nfsx flash --swt <00swt*.ipo> --sgbd <name> --firmware <S37 path>
             [--mock-file <json>] [--diag-addr <hex>]
             [--write] [--yes] [--json]

Required:
  --swt <path>          Path to the FSC/SWT IPO for the ECU's transport
                        (00swtkwp.ipo for KWP2000 etc).
  --sgbd <name>         ECU SGBD basename (e.g. C_DSC_KWP).
  --firmware <path>     S37 firmware payload to flash.

Optional:
  --mock-file <path>    JSON-shaped EDIABAS mock results to dispatch
                        against. Without this and without a real
                        wire, the dry-run finishes at PRECHECK.
  --diag-addr <hex>     Diagnostic address (audit/logging only).
  --write               Allow destructive operations. WITHOUT this
                        flag, the run is dry-run only. **The orches-
                        trator NEVER writes without --write set.**
  --yes                 Skip per-stage confirmation prompts. Requires
                        --write. Use only when scripted; the prompts
                        are your last chance to abort.
  --json                Machine-readable JSON output.
  --help                Show this help.

Examples:
  # Dry-run rehearsal against a mock — no ECU writes ever happen
  nfsx flash --swt 00swtkwp.ipo --sgbd C_DSC_KWP \\
             --firmware patched.s37 --mock-file lab-mock.json

  # Real flash against a connected ECU (interactive)
  nfsx flash --swt 00swtkwp.ipo --sgbd C_DSC_KWP \\
             --firmware patched.s37 --write
`;

export async function runFlash(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const missing = ['swtIpoPath', 'sgbd', 'firmwarePath'].filter(
    (k) => !(flags as unknown as Record<string, unknown>)[k],
  );
  if (missing.length > 0) {
    process.stderr.write(`error: missing required flag(s): ${missing.map((m) => `--${kebabCase(m)}`).join(', ')}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }

  if (flags.yes && !flags.write) {
    process.stderr.write('error: --yes requires --write (it would have nothing to skip in dry-run)\n');
    return 2;
  }

  // EDIABAS provider — mock when --mock-file is set, otherwise we
  // fall back to a stub mock. Real-ECU support needs a wired-up
  // ediabasx provider; not in this CLI iteration.
  let ediabas: MockEdiabasProvider;
  if (flags.mockFile) {
    ediabas = loadMockProvider(flags.mockFile);
  } else {
    // Empty mock — runs precheck (which will likely fail) + the
    // dry-run skips. Real wire integration is future work.
    ediabas = new MockEdiabasProvider();
    process.stdout.write('Note: no --mock-file and no real EDIABAS — using empty mock.\n');
    process.stdout.write('      Precheck will fail without a wire or mock data.\n\n');
  }

  // Load firmware
  if (!existsSync(flags.firmwarePath!)) {
    process.stderr.write(`error: firmware not found: ${flags.firmwarePath}\n`);
    return 2;
  }
  const s37Bytes = readFileSync(flags.firmwarePath!);

  const session = new FlashSession({
    ecu: {
      sgbd: flags.sgbd!,
      diagAddr: flags.diagAddr,
      swtIpoPath: flags.swtIpoPath!,
    },
    firmware: { s37Bytes: new Uint8Array(s37Bytes.buffer, s37Bytes.byteOffset, s37Bytes.byteLength) },
    ediabas,
  });

  // Live progress to stderr so --json output stays clean.
  session.on('event', (e) => {
    if (flags.json) return;
    if (e.type === 'stage:start') process.stderr.write(`  ▶ ${e.stage}\n`);
    else if (e.type === 'stage:done') process.stderr.write(`  ✓ ${e.stage} (${e.durationMs}ms)\n`);
    else if (e.type === 'stage:skipped') process.stderr.write(`  · ${e.stage} skipped (${e.reason})\n`);
    else if (e.type === 'log') process.stderr.write(`    ${e.level}: ${e.message}\n`);
    else if (e.type === 'block:transferred') {
      const pct = ((e.bytesSent / e.bytesTotal) * 100).toFixed(1);
      process.stderr.write(
        `    block ${e.blockIndex + 1}/${e.totalBlocks} → ${e.bytesSent}/${e.bytesTotal} bytes (${pct}%)\n`,
      );
    }
  });

  const dryRun = !flags.write;
  const result = await session.run({
    dryRun,
    confirm: dryRun
      ? undefined
      : flags.yes
        ? allowAllConfirmation
        : buildPromptFromStdin(),
  });

  if (flags.json) {
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
    process.stdout.write(`\n${result.ok ? '✓ flash complete' : '✗ flash aborted'}\n`);
    process.stdout.write(`  dryRun: ${result.dryRun}\n`);
    process.stdout.write(`  stages: ${result.stagesRun.join(' → ')}\n`);
    if (result.abortedAt) {
      process.stdout.write(`  aborted at: ${result.abortedAt}\n`);
      process.stdout.write(`  reason: ${result.abortReason}\n`);
    }
    process.stdout.write(`  bytes: ${result.bytesTransferred} / ${result.totalBytes}\n`);
  }

  return result.ok ? 0 : 1;
}

function parseFlags(args: string[]): FlashFlags {
  const flags: FlashFlags = { write: false, yes: false, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--swt':
        flags.swtIpoPath = takeValue(args, i);
        i++;
        break;
      case '--sgbd':
        flags.sgbd = takeValue(args, i);
        i++;
        break;
      case '--firmware':
        flags.firmwarePath = takeValue(args, i);
        i++;
        break;
      case '--mock-file':
        flags.mockFile = takeValue(args, i);
        i++;
        break;
      case '--diag-addr': {
        const v = takeValue(args, i);
        flags.diagAddr = parseInt(v, 16);
        i++;
        break;
      }
      case '--write':
        flags.write = true;
        break;
      case '--yes':
        flags.yes = true;
        break;
      case '--json':
        flags.json = true;
        break;
      default:
        process.stderr.write(`error: unknown flag "${a}"\n\n`);
        process.stderr.write(HELP);
        process.exit(2);
    }
  }
  return flags;
}

function takeValue(args: string[], idx: number): string {
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`error: ${args[idx]} requires a value\n`);
    process.exit(2);
  }
  return v;
}

function kebabCase(s: string): string {
  return s.replace(/[A-Z]/g, (m, i) => (i ? '-' : '') + m.toLowerCase());
}

function loadMockProvider(path: string): MockEdiabasProvider {
  const raw = readFileSync(path, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`error: --mock-file ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (!data || typeof data !== 'object') {
    process.stderr.write(`error: --mock-file ${path}: expected an object\n`);
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
          // Hex shorthand: "0x:11223344" → Uint8Array([0x11, 0x22, ...])
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

function buildPromptFromStdin() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return buildPromptConfirmation(async (q: string) => {
    const answer = await rl.question(q);
    return answer;
  }) as (stage: Stage, ctx: import('@emdzej/nfsx-flash').ConfirmContext) => Promise<boolean>;
}
