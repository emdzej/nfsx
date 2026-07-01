/**
 * `nfsx ms45` — MS45 DME probe / read / write / checksum.
 *
 * Talks to the DME via EDIABAS + the MS45 SGBD (MS450DS0.prg on E46,
 * 10MDS45.prg on E60/E65 — both auto-resolved from the D_Motor group
 * file). The wire layer, K-line vs. BMW-FAST, is picked by the SGBD;
 * we only feed it named jobs and byte-perfect arguments.
 *
 * ECU-dir resolution (where MS450DS0.prg / D_Motor.grp live):
 *
 *   1. `--ecu-dir <path>`               explicit CLI flag
 *   2. `sgbdPath` in ediabasx config    (~/.config/ediabasx/config.json)
 *   3. `<sp-daten>/ecu` fallback         (from ~/.config/nfsx/config.json)
 *
 * The last fallback lets users who already have SP-Daten configured
 * for `nfsx flash` reuse the same ECU dir without repointing.
 */

import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadConfig as loadEdiabasxConfig,
  resolveSelection,
  summariseSelection,
  type InterfaceOverrides,
} from '@emdzej/ediabasx-host-config';
import { EmbeddedEdiabas } from '@emdzej/ediabasx-client';
import { createInterface } from '@emdzej/ediabasx-interfaces';
import { SimulationInterface } from '@emdzej/ediabasx-interface-base';
import type { IEdiabas } from '@emdzej/ediabasx-core';
import {
  probe as ms45Probe,
  readFlash as ms45ReadFlash,
  writeFlash as ms45WriteFlash,
  verifyParameterChecksum,
  verifyProgramChecksum,
  verifyParameterSignature,
  verifyProgramSignature,
  rewriteParameterChecksum,
  rewriteProgramChecksum,
  rewriteParameterSignature,
  rewriteProgramSignature,
  TUNE_BLOB_SIZE,
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  Ms45SessionError,
  Ms45JobError,
  type DmeIdent,
  type Ms45Progress,
} from '@emdzej/nfsx-ms45';
import { resolveSpDaten, NfsxConfigError } from './config.js';

// ── shared options ─────────────────────────────────────────────────

export interface Ms45TransportOptions {
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  /** Explicit ECU dir. Overrides ediabas config's `sgbdPath` and the SP-Daten fallback. */
  ecuDir?: string;
  /** SGBD to dispatch against. Defaults to `D_Motor`. */
  sgbd?: string;
  /** Path to the nfsx config file (for the `<spDaten>/ecu` fallback). */
  config?: string;
  /** SP-Daten override — used ONLY to derive `<spDaten>/ecu` fallback. */
  spDaten?: string;
  json?: boolean;
}

export interface Ms45ProbeOpts extends Ms45TransportOptions {}

export interface Ms45ReadOpts extends Ms45TransportOptions {
  output: string;
  mode: 'tune' | 'full';
}

export interface Ms45WriteOpts extends Ms45TransportOptions {
  input: string;
  mpc?: string;
  mode: 'tune' | 'full';
  skipChecksum?: boolean;
  skipSign?: boolean;
  skipVerify?: boolean;
  /** Skip the type-in-FLASH confirmation prompt. Requires the caller to already have consent. */
  yes?: boolean;
}

export interface Ms45ChecksumOpts {
  file: string;
  mpc?: string;
  output?: string;
  rewrite?: boolean;
  skipChecksum?: boolean;
  skipSignature?: boolean;
  json?: boolean;
}

// ── transport builder ──────────────────────────────────────────────

interface OpenedMs45 {
  ediabas: IEdiabas;
  cleanup: () => Promise<void>;
  summary: string;
  sgbd: string;
  ecuDir: string;
}

function resolveEcuDir(opts: Ms45TransportOptions, fromEdiabasConfig?: string): string {
  if (opts.ecuDir) return resolve(opts.ecuDir);
  if (fromEdiabasConfig) return resolve(fromEdiabasConfig);
  // Last-resort fallback: <spDaten>/ecu. Only reachable when the user
  // has nfsx configured for the SP-Daten workflows.
  try {
    const spDaten = resolveSpDaten({ spDaten: opts.spDaten, configPath: opts.config });
    return join(spDaten, 'ecu');
  } catch (err) {
    // Repackage as an MS45-specific error message pointing at the
    // three sources we actually consulted.
    throw new Error(
      'ms45: no ECU directory configured.\n' +
        '  Pass --ecu-dir <path>, set `sgbdPath` in ~/.config/ediabasx/config.json,\n' +
        `  or run \`nfsx configure\` to point at an SP-Daten drop (its ecu/ dir is used).\n` +
        `  original: ${(err as Error).message}`,
    );
  }
}

async function openMs45Ediabas(opts: Ms45TransportOptions): Promise<OpenedMs45> {
  const fileConfig = loadEdiabasxConfig(opts.ediabasConfig);
  const overrides: InterfaceOverrides = {
    interfaceName: opts.interface,
    gateway: opts.gateway,
    options: {
      port: opts.serialPort,
      baudRate: opts.serialBaud,
    },
  };
  const selection = resolveSelection(fileConfig, overrides, { fallback: 'simulation' });

  const useSimulation = selection.interface === 'simulation';
  const iface = useSimulation
    ? new SimulationInterface()
    : createInterface(selection.interface, selection.options);

  const ecuDir = resolveEcuDir(opts, selection.sgbdPath);
  if (!existsSync(ecuDir)) {
    throw new Error(`ms45: ECU dir does not exist: ${ecuDir}`);
  }

  const ediabas = new EmbeddedEdiabas({
    sgbdPath: ecuDir,
    interface: iface,
  });

  await ediabas.init();

  return {
    ediabas,
    cleanup: async () => {
      await ediabas.end();
    },
    summary: `${summariseSelection(selection)}  ecuDir=${ecuDir}`,
    sgbd: opts.sgbd ?? 'D_Motor',
    ecuDir,
  };
}

// ── progress printer ───────────────────────────────────────────────

function makeProgressPrinter(json: boolean): (p: Ms45Progress) => void {
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

// ── error formatting ───────────────────────────────────────────────

function reportError(err: unknown): void {
  if (err instanceof Ms45JobError) {
    process.stderr.write(
      chalk.red(`ms45: job "${err.job}" failed (JOB_STATUS=${err.jobStatus ?? '<missing>'})\n`),
    );
    process.stderr.write(chalk.red(`  ${err.message}\n`));
    return;
  }
  if (err instanceof Ms45SessionError) {
    process.stderr.write(chalk.red(`ms45 [${err.stage}]: ${err.message}\n`));
    return;
  }
  if (err instanceof NfsxConfigError) {
    process.stderr.write(chalk.red(`ms45: ${err.message}\n`));
    return;
  }
  process.stderr.write(chalk.red(`error: ${(err as Error).message ?? String(err)}\n`));
}

// ── probe ──────────────────────────────────────────────────────────

function printIdent(ident: DmeIdent): void {
  process.stdout.write(chalk.bold('MS45 DME\n'));
  process.stdout.write(`  variant:         ${ident.variant ?? chalk.yellow('<unknown>')}\n`);
  process.stdout.write(`  VIN:             ${ident.vin}\n`);
  process.stdout.write(`  HW ref:          ${ident.hwRef}\n`);
  process.stdout.write(`  SW ref:          ${ident.swRef}\n`);
  process.stdout.write(`  program status:  ${ident.programmingStatus}\n`);
  process.stdout.write(`  diag protocol:   ${ident.diagProtocol}\n`);
}

export async function runMs45Probe(opts: Ms45ProbeOpts): Promise<number> {
  let opened: OpenedMs45 | undefined;
  try {
    opened = await openMs45Ediabas(opts);
    if (!opts.json) process.stderr.write(chalk.dim(`ediabasx: ${opened.summary}\n`));
    const ident = await ms45Probe({ ediabas: opened.ediabas, sgbd: opened.sgbd });
    if (opts.json) {
      process.stdout.write(JSON.stringify(ident, null, 2) + '\n');
    } else {
      printIdent(ident);
    }
    return 0;
  } catch (err) {
    reportError(err);
    return 2;
  } finally {
    if (opened) await opened.cleanup().catch(() => {});
  }
}

// ── read ───────────────────────────────────────────────────────────

export async function runMs45Read(opts: Ms45ReadOpts): Promise<number> {
  let opened: OpenedMs45 | undefined;
  try {
    opened = await openMs45Ediabas(opts);
    if (!opts.json) process.stderr.write(chalk.dim(`ediabasx: ${opened.summary}\n`));
    const progress = makeProgressPrinter(!!opts.json);
    const result = await ms45ReadFlash(
      { ediabas: opened.ediabas, sgbd: opened.sgbd },
      { mode: opts.mode, progress },
    );

    if (result.mode === 'tune') {
      const target = resolve(opts.output);
      writeFileSync(target, result.tune);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ mode: 'tune', output: target, size: result.tune.length }, null, 2) + '\n',
        );
      } else {
        process.stdout.write(chalk.green(`✓ tune saved → ${target} (${result.tune.length} bytes)\n`));
      }
      return 0;
    }

    // full-mode: emit two files, `<output>` and `<output>` with the
    // suffix replaced (or `.mpc.bin` appended when no suffix was given).
    const externalPath = resolve(opts.output);
    const mpcPath = suffixedPath(externalPath, '_MPC');
    writeFileSync(externalPath, result.external);
    writeFileSync(mpcPath, result.mpc);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            mode: 'full',
            external: externalPath,
            externalSize: result.external.length,
            mpc: mpcPath,
            mpcSize: result.mpc.length,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(chalk.green(`✓ external flash → ${externalPath} (${result.external.length} bytes)\n`));
      process.stdout.write(chalk.green(`✓ MPC flash      → ${mpcPath} (${result.mpc.length} bytes)\n`));
    }
    return 0;
  } catch (err) {
    reportError(err);
    return 2;
  } finally {
    if (opened) await opened.cleanup().catch(() => {});
  }
}

function suffixedPath(path: string, suffix: string): string {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return path + suffix;
  return path.slice(0, dot) + suffix + path.slice(dot);
}

// ── write ──────────────────────────────────────────────────────────

export async function runMs45Write(opts: Ms45WriteOpts): Promise<number> {
  let inputBytes: Uint8Array;
  let mpcBytes: Uint8Array | undefined;

  try {
    inputBytes = new Uint8Array(readFileSync(resolve(opts.input)));
  } catch (err) {
    process.stderr.write(chalk.red(`ms45: cannot read input: ${(err as Error).message}\n`));
    return 2;
  }

  if (opts.mode === 'full') {
    if (!opts.mpc) {
      process.stderr.write(chalk.red('ms45: --mode full requires --mpc <path>\n'));
      return 2;
    }
    try {
      mpcBytes = new Uint8Array(readFileSync(resolve(opts.mpc)));
    } catch (err) {
      process.stderr.write(chalk.red(`ms45: cannot read MPC: ${(err as Error).message}\n`));
      return 2;
    }
  }

  // Payload size gates BEFORE any wire I/O.
  if (opts.mode === 'tune' && inputBytes.length !== TUNE_BLOB_SIZE) {
    process.stderr.write(
      chalk.red(
        `ms45: tune input must be exactly ${TUNE_BLOB_SIZE} bytes, got ${inputBytes.length}\n`,
      ),
    );
    return 2;
  }
  if (opts.mode === 'full' && inputBytes.length !== EXTERNAL_FLASH_SIZE) {
    process.stderr.write(
      chalk.red(
        `ms45: external input must be exactly ${EXTERNAL_FLASH_SIZE} bytes, got ${inputBytes.length}\n`,
      ),
    );
    return 2;
  }
  if (mpcBytes && mpcBytes.length !== MPC_FLASH_SIZE) {
    process.stderr.write(
      chalk.red(
        `ms45: MPC input must be exactly ${MPC_FLASH_SIZE} bytes, got ${mpcBytes.length}\n`,
      ),
    );
    return 2;
  }

  // Destructive-op prompt (skippable with --yes).
  if (!opts.yes && !opts.json) {
    process.stderr.write(chalk.yellow('\n'));
    process.stderr.write(
      chalk.yellow('  ╔══════════════════════════════════════════════════════════════╗\n'),
    );
    process.stderr.write(
      chalk.yellow('  ║  ⚠  DESTRUCTIVE STAGE: MS45 FLASH                             ║\n'),
    );
    process.stderr.write(
      chalk.yellow('  ╚══════════════════════════════════════════════════════════════╝\n\n'),
    );
    process.stderr.write(`  mode:       ${opts.mode}\n`);
    process.stderr.write(`  input:      ${resolve(opts.input)}\n`);
    if (opts.mpc) process.stderr.write(`  mpc:        ${resolve(opts.mpc)}\n`);
    process.stderr.write(
      '\n  ⚠ This will ERASE and REWRITE the DME flash.\n' +
        '  ⚠ A failure mid-transfer can BRICK the DME.\n' +
        '  ⚠ Take a --mode full backup FIRST if you don\'t have one.\n\n',
    );
    process.stderr.write('  Pass --yes to skip this prompt and proceed non-interactively.\n\n');
    const answer = await readLine('  Type "FLASH" to proceed, anything else to abort: ');
    if (answer.trim() !== 'FLASH') {
      process.stderr.write(chalk.dim('aborted\n'));
      return 3;
    }
  }

  let opened: OpenedMs45 | undefined;
  try {
    opened = await openMs45Ediabas(opts);
    if (!opts.json) process.stderr.write(chalk.dim(`ediabasx: ${opened.summary}\n`));
    const progress = makeProgressPrinter(!!opts.json);

    const config = { ediabas: opened.ediabas, sgbd: opened.sgbd };
    const common = {
      progress,
      skipChecksum: opts.skipChecksum,
      skipSign: opts.skipSign,
      skipVerify: opts.skipVerify,
    };

    const result =
      opts.mode === 'tune'
        ? await ms45WriteFlash(config, { mode: 'tune', tune: inputBytes, ...common })
        : await ms45WriteFlash(config, {
            mode: 'full',
            external: inputBytes,
            mpc: mpcBytes!,
            ...common,
          });

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            variant: result.ident.variant,
            hwRef: result.ident.hwRef,
            programmingStatus: result.programmingStatus,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(chalk.green('\n✓ flash complete\n'));
      process.stdout.write(`  variant:           ${result.ident.variant ?? '<unknown>'}\n`);
      process.stdout.write(`  programming state: ${result.programmingStatus ?? '<n/a>'}\n`);
    }
    return 0;
  } catch (err) {
    reportError(err);
    return 2;
  } finally {
    if (opened) await opened.cleanup().catch(() => {});
  }
}

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return await new Promise<string>((res) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        res(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// ── checksum (offline) ─────────────────────────────────────────────

type ChecksumTarget = 'tune' | 'full';

function classifyChecksumTarget(size: number): ChecksumTarget | null {
  if (size === TUNE_BLOB_SIZE) return 'tune';
  if (size === EXTERNAL_FLASH_SIZE) return 'full';
  return null;
}

export function runMs45Checksum(opts: Ms45ChecksumOpts): number {
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(readFileSync(resolve(opts.file)));
  } catch (err) {
    process.stderr.write(chalk.red(`ms45: cannot read ${opts.file}: ${(err as Error).message}\n`));
    return 2;
  }

  const target = classifyChecksumTarget(buf.length);
  if (!target) {
    process.stderr.write(
      chalk.red(
        `ms45: cannot classify ${opts.file} — expected ${TUNE_BLOB_SIZE} bytes (tune) or ${EXTERNAL_FLASH_SIZE} bytes (full external flash), got ${buf.length}\n`,
      ),
    );
    return 2;
  }

  let mpc: Uint8Array | undefined;
  if (target === 'full') {
    if (!opts.mpc) {
      process.stderr.write(
        chalk.red('ms45: full-flash input requires --mpc <path> for signature verification\n'),
      );
      return 2;
    }
    try {
      mpc = new Uint8Array(readFileSync(resolve(opts.mpc)));
    } catch (err) {
      process.stderr.write(chalk.red(`ms45: cannot read MPC: ${(err as Error).message}\n`));
      return 2;
    }
    if (mpc.length !== MPC_FLASH_SIZE) {
      process.stderr.write(
        chalk.red(
          `ms45: MPC must be exactly ${MPC_FLASH_SIZE} bytes, got ${mpc.length}\n`,
        ),
      );
      return 2;
    }
  }

  const doChecksum = !opts.skipChecksum;
  const doSignature = !opts.skipSignature;

  // Rewrite path — mutate buf (and mpc where relevant) in place, then
  // re-run verification against the fresh bytes for the report.
  if (opts.rewrite) {
    if (target === 'tune') {
      if (doChecksum) rewriteParameterChecksum(buf);
      if (doSignature) rewriteParameterSignature(buf);
    } else {
      if (doChecksum) rewriteProgramChecksum(buf, mpc!);
      if (doSignature) rewriteProgramSignature(buf, mpc!);
    }
    const outPath = resolve(opts.output ?? opts.file);
    try {
      writeFileSync(outPath, buf);
    } catch (err) {
      process.stderr.write(chalk.red(`ms45: cannot write ${outPath}: ${(err as Error).message}\n`));
      return 2;
    }
  }

  // Report (post-rewrite when applicable — verifying what's now in `buf`).
  const report =
    target === 'tune'
      ? buildTuneReport(buf, doChecksum, doSignature)
      : buildFullReport(buf, mpc!, doChecksum, doSignature);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ target, ...report }, replaceUint8, 2) + '\n');
    return report.allOk ? 0 : 1;
  }

  printChecksumReport(opts.file, target, buf.length, report);
  return report.allOk ? 0 : 1;
}

interface ReportEntry {
  name: string;
  stored: string;
  computed: string;
  ok: boolean;
}

interface Report {
  entries: ReportEntry[];
  allOk: boolean;
  rewrote: boolean;
}

function hexU32(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
}

function hexBytes(bytes: Uint8Array, max: number = 8): string {
  const head = Array.from(bytes.subarray(0, max), (b) => b.toString(16).padStart(2, '0')).join('');
  return bytes.length > max ? `${head}…` : head;
}

function buildTuneReport(
  blob: Uint8Array,
  doChecksum: boolean,
  doSignature: boolean,
): Report {
  const entries: ReportEntry[] = [];
  if (doChecksum) {
    const r = verifyParameterChecksum(blob);
    entries.push({
      name: 'parameter CRC-32 @ 0x100',
      stored: hexU32(r.stored),
      computed: hexU32(r.computed),
      ok: r.ok,
    });
  }
  if (doSignature) {
    const r = verifyParameterSignature(blob);
    entries.push({
      name: 'parameter RSA sig @ 0x174',
      stored: hexBytes(r.stored),
      computed: hexBytes(r.computed),
      ok: r.ok,
    });
  }
  return { entries, allOk: entries.every((e) => e.ok), rewrote: false };
}

function buildFullReport(
  external: Uint8Array,
  mpc: Uint8Array,
  doChecksum: boolean,
  doSignature: boolean,
): Report {
  const entries: ReportEntry[] = [];
  if (doChecksum) {
    const r = verifyProgramChecksum(external, mpc);
    entries.push({
      name: 'program CRC-32 primary @ 0x60000',
      stored: hexU32(r.primary.stored),
      computed: hexU32(r.primary.computed),
      ok: r.primary.ok,
    });
    entries.push({
      name: 'program CRC-32 secondary @ 0x60340',
      stored: hexU32(r.secondary.stored),
      computed: hexU32(r.secondary.computed),
      ok: r.secondary.ok,
    });
  }
  if (doSignature) {
    const r = verifyProgramSignature(external, mpc);
    entries.push({
      name: 'program RSA sig @ 0x60074',
      stored: hexBytes(r.stored),
      computed: hexBytes(r.computed),
      ok: r.ok,
    });
  }
  return { entries, allOk: entries.every((e) => e.ok), rewrote: false };
}

function printChecksumReport(
  filePath: string,
  target: ChecksumTarget,
  size: number,
  report: Report,
): void {
  process.stdout.write(
    `${chalk.bold(`MS45 offline BIN check`)}: ${filePath} (${size} bytes) → ${target} blob\n`,
  );
  for (const e of report.entries) {
    const mark = e.ok ? chalk.green('✓') : chalk.red('✗');
    process.stdout.write(
      `  ${e.name.padEnd(38)}  stored ${e.stored.padEnd(12)}  computed ${e.computed.padEnd(12)}  ${mark}\n`,
    );
  }
  if (report.allOk) {
    process.stdout.write(chalk.green('✓ all checks pass\n'));
  } else {
    process.stdout.write(chalk.red('✗ one or more checks failed\n'));
  }
}

function replaceUint8(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return value;
}
