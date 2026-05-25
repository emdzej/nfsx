/**
 * `FlashSession` — orchestrates the 7-stage flash pipeline.
 *
 * Public contract:
 *
 *   const session = new FlashSession({ ecu, firmware, ediabas, ... });
 *   const result = await session.run({ dryRun: false, confirm });
 *
 * `result.ok === true` iff every stage completed. If the run aborted
 * mid-pipeline, `result.abortedAt` names the stage that failed and
 * `result.abortReason` carries the surfaced error.
 *
 * Events: `session.events` is a live array the orchestrator appends
 * to; for streaming, listen via `session.on('event', cb)`.
 */

import { parseS37, buildMemoryMap, type MemoryRegion } from '@emdzej/nfsx-flash-data';
import { runPrecheck } from './precheck.js';
import { runAuthenticate, PassthroughKeyDerivation } from './auth.js';
import { runTransfer } from './transfer.js';
import { runAifWrite, type AifPayload } from './aif-write.js';
import { DESTRUCTIVE_STAGES, rejectAllConfirmation } from './safety.js';
import type {
  ConfirmContext,
  FlashEvent,
  FlashResult,
  FlashSessionOptions,
  RunOptions,
  Stage,
} from './types.js';

const STAGE_ORDER: readonly Stage[] = [
  'RESOLVE',
  'PRECHECK',
  'AUTHENTICATE',
  'SESSION',
  'TRANSFER',
  'AIF_WRITE',
  'POSTCHECK',
];

export class FlashSession {
  private listeners: Array<(e: FlashEvent) => void> = [];
  /** Live append-only event log — exposed for observability. */
  readonly events: FlashEvent[] = [];

  constructor(private readonly opts: FlashSessionOptions) {}

  /** Subscribe to per-event updates. Returns an unsubscribe function. */
  on(_kind: 'event', cb: (e: FlashEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  /**
   * Run the pipeline. Defaults to `dryRun: true` and
   * `confirm: rejectAllConfirmation` — callers must explicitly opt
   * into both `dryRun: false` and a real confirmation function.
   */
  async run(runOpts: RunOptions = {}): Promise<FlashResult> {
    const dryRun = runOpts.dryRun ?? true;
    const confirm = runOpts.confirm ?? rejectAllConfirmation;

    let bytesTransferred = 0;
    let totalBytes = 0;
    const stagesRun: Stage[] = [];

    // RESOLVE — pre-parse firmware into memory regions. This is
    // pure compute; runs even in dry-run.
    let regions: MemoryRegion[];
    const resolveStart = Date.now();
    this.emit({ type: 'stage:start', stage: 'RESOLVE' });
    try {
      regions = this.resolveFirmware();
      totalBytes = regions.reduce((n, r) => n + r.bytes.length, 0);
      stagesRun.push('RESOLVE');
      this.emit({ type: 'stage:done', stage: 'RESOLVE', durationMs: Date.now() - resolveStart });
      this.emit({
        type: 'log',
        level: 'info',
        message: `firmware: ${regions.length} region(s), ${totalBytes} bytes total`,
      });
    } catch (err) {
      return this.abortAt('RESOLVE', err, stagesRun, bytesTransferred, totalBytes, dryRun);
    }

    // PRECHECK — read-only, runs for real even in dry-run.
    const precheckStart = Date.now();
    this.emit({ type: 'stage:start', stage: 'PRECHECK' });
    try {
      const report = await runPrecheck(
        this.opts.ecu,
        this.opts.ediabas,
        this.opts.precheck,
      );
      stagesRun.push('PRECHECK');
      if (!report.ok) {
        const failed: string[] = [];
        if (!report.battery.ok && !report.battery.skipped) failed.push(`battery (${report.battery.reason})`);
        if (!report.ignition.ok && !report.ignition.skipped) failed.push(`ignition (${report.ignition.reason})`);
        if (!report.ecuComms.ok && !report.ecuComms.skipped) failed.push(`ecu_comms (${report.ecuComms.reason})`);
        if (!report.fsc.ok && !report.fsc.skipped) failed.push(`fsc (${report.fsc.reason})`);
        return this.abortAt('PRECHECK', `precheck failed: ${failed.join('; ')}`, stagesRun, bytesTransferred, totalBytes, dryRun);
      }
      this.emit({ type: 'stage:done', stage: 'PRECHECK', durationMs: Date.now() - precheckStart });
    } catch (err) {
      return this.abortAt('PRECHECK', err, stagesRun, bytesTransferred, totalBytes, dryRun);
    }

    // Destructive stages — gated by confirm in non-dry-run mode.
    const ctx: ConfirmContext = {
      ecu: this.opts.ecu,
      totalBytes,
      regionCount: regions.length,
    };

    for (const stage of ['AUTHENTICATE', 'SESSION', 'TRANSFER', 'AIF_WRITE'] as const) {
      if (dryRun) {
        this.emit({ type: 'stage:skipped', stage, reason: 'dry-run' });
        stagesRun.push(stage);
        continue;
      }
      if (DESTRUCTIVE_STAGES.has(stage)) {
        const proceed = await Promise.resolve(confirm(stage, ctx));
        if (!proceed) {
          return this.abortAt(stage, 'operator declined confirmation', stagesRun, bytesTransferred, totalBytes, dryRun);
        }
      }
      const stageStart = Date.now();
      this.emit({ type: 'stage:start', stage });
      try {
        if (stage === 'AUTHENTICATE') {
          const r = await runAuthenticate(
            this.opts.ecu,
            this.opts.ediabas,
            this.opts.keyDerivation ?? PassthroughKeyDerivation,
          );
          if (!r.ok) {
            return this.abortAt(stage, r.reason!, stagesRun, bytesTransferred, totalBytes, dryRun);
          }
        } else if (stage === 'SESSION') {
          // BMW wraps UDS 0x10 0x02 ProgrammingSession in
          // FLASH_PROGRAMMIEREN_MODUS or similar — varies by SGBD.
          // We use the conventional name; ECU-specific naming
          // would override this via a TransferOptions extension.
          await this.opts.ediabas.job(this.opts.ecu.sgbd, 'FLASH_PROGRAMMIEREN_MODUS', '', '');
          const status = this.opts.ediabas.hasResult('JOB_STATUS', 1)
            ? this.opts.ediabas.resultText('JOB_STATUS', 1, '')
            : '';
          if (status !== 'OKAY') {
            return this.abortAt(stage, `programming-session JOB_STATUS="${status}"`, stagesRun, bytesTransferred, totalBytes, dryRun);
          }
        } else if (stage === 'TRANSFER') {
          const report = await runTransfer(
            this.opts.ecu,
            this.opts.ediabas,
            regions,
            this.opts.transfer ?? {},
            (e) => this.emit(e),
          );
          bytesTransferred = report.bytesTransferred;
          if (!report.ok) {
            return this.abortAt(stage, report.abortReason!, stagesRun, bytesTransferred, totalBytes, dryRun);
          }
        } else if (stage === 'AIF_WRITE') {
          // Caller can override via `aifPayload` on FlashSessionOptions;
          // for now we send an empty payload (no metadata stamp).
          const r = await runAifWrite(this.opts.ecu, this.opts.ediabas, {} as AifPayload);
          if (!r.ok) {
            return this.abortAt(stage, r.reason!, stagesRun, bytesTransferred, totalBytes, dryRun);
          }
        }
        stagesRun.push(stage);
        this.emit({ type: 'stage:done', stage, durationMs: Date.now() - stageStart });
      } catch (err) {
        return this.abortAt(stage, err, stagesRun, bytesTransferred, totalBytes, dryRun);
      }
    }

    // POSTCHECK — read-only safety net (ECU reset + status read).
    const pcStart = Date.now();
    this.emit({ type: 'stage:start', stage: 'POSTCHECK' });
    try {
      if (!dryRun) {
        // ECU reset via UDS 0x11; SGBD-specific name. Fail-soft —
        // postcheck failures are diagnostic, the flash itself
        // succeeded.
        try {
          await this.opts.ediabas.job(this.opts.ecu.sgbd, 'STEUERGERAETE_RESET', '', '');
        } catch (err) {
          this.emit({
            type: 'log',
            level: 'warn',
            message: `STEUERGERAETE_RESET threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      stagesRun.push('POSTCHECK');
      this.emit({ type: 'stage:done', stage: 'POSTCHECK', durationMs: Date.now() - pcStart });
    } catch (err) {
      return this.abortAt('POSTCHECK', err, stagesRun, bytesTransferred, totalBytes, dryRun);
    }

    return {
      ok: true,
      stagesRun,
      bytesTransferred,
      totalBytes,
      dryRun,
      events: [...this.events],
    };
  }

  private resolveFirmware(): MemoryRegion[] {
    const f = this.opts.firmware;
    if ('regions' in f) return [...f.regions];
    const { records, skipped } = parseS37(f.s37Bytes);
    if (skipped.length > 0) {
      this.emit({
        type: 'log',
        level: 'warn',
        message: `S37 parse: skipped ${skipped.length} lines (first: line ${skipped[0]!.lineNumber} ${skipped[0]!.reason})`,
      });
    }
    const map = buildMemoryMap(records);
    if (map.overlaps.length > 0) {
      throw new Error(
        `firmware has ${map.overlaps.length} overlapping memory range(s) — refusing to flash`,
      );
    }
    return map.regions;
  }

  private emit(e: FlashEvent): void {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }

  private abortAt(
    stage: Stage,
    reason: unknown,
    stagesRun: Stage[],
    bytesTransferred: number,
    totalBytes: number,
    dryRun: boolean,
  ): FlashResult {
    const msg = reason instanceof Error ? reason.message : String(reason);
    this.emit({ type: 'log', level: 'error', message: `aborting at ${stage}: ${msg}` });
    return {
      ok: false,
      stagesRun,
      abortedAt: stage,
      abortReason: msg,
      bytesTransferred,
      totalBytes,
      dryRun,
      events: [...this.events],
    };
  }
}
