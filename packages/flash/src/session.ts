/**
 * `FlashSession` — orchestrates the 5-stage flash pipeline that
 * mirrors WinKFP's `coapiKfProgSgD2`.
 *
 *   RESOLVE → PRECHECK → BACKUP → PROGRAM → POSTCHECK
 *
 * See `types.ts` for the per-stage semantics. The PROGRAM stage is
 * a single `SG_PROGRAMMIEREN` IPO dispatch — all the wire-level UDS
 * handshaking lives inside the IPO, not here.
 */

import {
  parseS37,
  buildMemoryMap,
  parsePaDa,
  paDaToRegions,
  type MemoryRegion,
} from '@emdzej/nfsx-flash-data';
import { runPrecheck } from './precheck.js';
import { runBackup, writeBackupFile } from './backup.js';
import { runProgramSg } from './prog-sg.js';
import { buildRegionsFirmwareSource } from './firmware-source.js';
import { rejectAllConfirmation } from './safety.js';
import type {
  ConfirmContext,
  FlashEvent,
  FlashResult,
  FlashSessionOptions,
  RunOptions,
  Stage,
} from './types.js';

export class FlashSession {
  private listeners: Array<(e: FlashEvent) => void> = [];
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
   * into both `dryRun: false` and a real confirmation function for
   * the PROGRAM stage to execute.
   */
  async run(runOpts: RunOptions = {}): Promise<FlashResult> {
    const dryRun = runOpts.dryRun ?? true;
    const confirm = runOpts.confirm ?? rejectAllConfirmation;

    let totalBytes = 0;
    let backupPath: string | undefined;
    const stagesRun: Stage[] = [];

    // ── RESOLVE ───────────────────────────────────────────────────
    // Parse the firmware file for integrity. Doesn't pass bytes to
    // the IPO — the IPO reads from disk via CABF* syscalls.
    let regions: MemoryRegion[];
    {
      const t0 = Date.now();
      this.emit({ type: 'stage:start', stage: 'RESOLVE' });
      try {
        regions = this.resolveFirmware();
        totalBytes = regions.reduce((n, r) => n + r.bytes.length, 0);
        stagesRun.push('RESOLVE');
        this.emit({ type: 'stage:done', stage: 'RESOLVE', durationMs: Date.now() - t0 });
        this.emit({
          type: 'log',
          level: 'info',
          message: `firmware: ${regions.length} region(s), ${totalBytes} bytes total`,
        });
      } catch (err) {
        return this.abortAt('RESOLVE', err, stagesRun, totalBytes, backupPath, dryRun);
      }
    }

    // ── PRECHECK ──────────────────────────────────────────────────
    {
      const t0 = Date.now();
      this.emit({ type: 'stage:start', stage: 'PRECHECK' });
      try {
        const report = await runPrecheck(
          this.opts.ecu,
          this.opts.ediabas,
          this.opts.precheck,
        );
        stagesRun.push('PRECHECK');
        this.emitPrecheckSummary(report);
        if (!report.ok) {
          const failed: string[] = [];
          if (!report.hwReferenz.ok && !report.hwReferenz.skipped) failed.push(`hw_referenz (${report.hwReferenz.reason})`);
          if (!report.sgStatus.ok && !report.sgStatus.skipped) failed.push(`sg_status (${report.sgStatus.reason})`);
          if (!report.sgIdent.ok && !report.sgIdent.skipped) failed.push(`sg_ident (${report.sgIdent.reason})`);
          if (!report.sgAif.ok && !report.sgAif.skipped) failed.push(`sg_aif (${report.sgAif.reason})`);
          if (!report.hwnrMatch.ok && !report.hwnrMatch.skipped) failed.push(`hwnr_match (${report.hwnrMatch.reason})`);
          if (!report.fsc.ok && !report.fsc.skipped) failed.push(`fsc (${report.fsc.reason})`);
          return this.abortAt('PRECHECK', `precheck failed: ${failed.join('; ')}`, stagesRun, totalBytes, backupPath, dryRun);
        }
        this.emit({ type: 'stage:done', stage: 'PRECHECK', durationMs: Date.now() - t0 });
      } catch (err) {
        return this.abortAt('PRECHECK', err, stagesRun, totalBytes, backupPath, dryRun);
      }
    }

    // ── BACKUP ────────────────────────────────────────────────────
    // Audit snapshot. Read-only, always safe to run. Skippable via
    // `backup: { skip: true }` for tests / CI / explicit operator opt-out.
    {
      const t0 = Date.now();
      this.emit({ type: 'stage:start', stage: 'BACKUP' });
      try {
        if (this.opts.backup?.skip) {
          this.emit({ type: 'stage:skipped', stage: 'BACKUP', reason: 'backup.skip = true' });
        } else {
          const report = await runBackup(this.opts.ecu, this.opts.ediabas);
          const outputDir = this.opts.backup?.outputDir ?? './backups';
          backupPath = writeBackupFile(report, outputDir, this.opts.backup?.filename);
          this.emit({ type: 'log', level: 'info', message: `backup saved → ${backupPath}` });
        }
        stagesRun.push('BACKUP');
        this.emit({ type: 'stage:done', stage: 'BACKUP', durationMs: Date.now() - t0 });
      } catch (err) {
        return this.abortAt('BACKUP', err, stagesRun, totalBytes, backupPath, dryRun);
      }
    }

    // ── PROGRAM ───────────────────────────────────────────────────
    // The only destructive stage. Skipped in dry-run; gated by
    // confirm() otherwise.
    {
      if (dryRun) {
        this.emit({ type: 'stage:skipped', stage: 'PROGRAM', reason: 'dry-run' });
        stagesRun.push('PROGRAM');
      } else {
        const ctx: ConfirmContext = {
          ecu: this.opts.ecu,
          totalBytes,
          regionCount: regions.length,
        };
        const proceed = await Promise.resolve(confirm('PROGRAM', ctx));
        if (!proceed) {
          return this.abortAt('PROGRAM', 'operator declined confirmation', stagesRun, totalBytes, backupPath, dryRun);
        }
        const t0 = Date.now();
        this.emit({ type: 'stage:start', stage: 'PROGRAM' });
        try {
          // The IPO pops one record per call from this iterator via
          // slot 0x55. See packages/runtime/src/system-functions.ts.
          const firmwareSource = buildRegionsFirmwareSource(regions);
          const report = await runProgramSg(
            this.opts.ecu,
            this.opts.ediabas,
            this.opts.program,
            firmwareSource,
          );
          if (!report.ok) {
            return this.abortAt('PROGRAM', report.reason ?? 'SG_PROGRAMMIEREN failed', stagesRun, totalBytes, backupPath, dryRun);
          }
          stagesRun.push('PROGRAM');
          this.emit({ type: 'stage:done', stage: 'PROGRAM', durationMs: Date.now() - t0 });
        } catch (err) {
          return this.abortAt('PROGRAM', err, stagesRun, totalBytes, backupPath, dryRun);
        }
      }
    }

    // ── POSTCHECK ─────────────────────────────────────────────────
    // Re-run identity reads to confirm the ECU still responds. Skipped
    // in dry-run (nothing changed, so no need to verify). Fail-soft:
    // errors here are diagnostic, not flash failures.
    {
      const t0 = Date.now();
      this.emit({ type: 'stage:start', stage: 'POSTCHECK' });
      try {
        if (!dryRun) {
          const report = await runPrecheck(
            this.opts.ecu,
            this.opts.ediabas,
            // Skip FSC + hwnr_match — after a successful flash the
            // identity may have changed; we just want a liveness check.
            { skip: ['fsc', 'hwnr_match', 'sg_aif'] },
          );
          if (!report.hwReferenz.ok) {
            this.emit({
              type: 'log',
              level: 'warn',
              message: `POSTCHECK: HW_REFERENZ failed (${report.hwReferenz.reason}) — ECU may not have reset cleanly`,
            });
          } else if (report.hwReferenz.kennung) {
            this.emit({
              type: 'log',
              level: 'info',
              message: `POSTCHECK: HW_REFERENZ kennung=${report.hwReferenz.kennung} projekt=${report.hwReferenz.projekt ?? '?'}`,
            });
          }
        }
        stagesRun.push('POSTCHECK');
        this.emit({ type: 'stage:done', stage: 'POSTCHECK', durationMs: Date.now() - t0 });
      } catch (err) {
        // Fail-soft: log but don't abort.
        this.emit({
          type: 'log',
          level: 'warn',
          message: `POSTCHECK threw: ${err instanceof Error ? err.message : String(err)}`,
        });
        stagesRun.push('POSTCHECK');
        this.emit({ type: 'stage:done', stage: 'POSTCHECK', durationMs: Date.now() - t0 });
      }
    }

    return {
      ok: true,
      stagesRun,
      backupPath,
      totalBytes,
      dryRun,
      events: [...this.events],
    };
  }

  // ── Firmware parsing helpers ────────────────────────────────────

  private resolveFirmware(): MemoryRegion[] {
    const f = this.opts.firmware;
    if ('regions' in f) return [...f.regions];
    if ('paDaBytes' in f) return this.resolvePaDa(f.paDaBytes);
    return this.resolveS37(f.s37Bytes);
  }

  private resolveS37(bytes: Uint8Array): MemoryRegion[] {
    const { records, skipped } = parseS37(bytes);
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

  private resolvePaDa(bytes: Uint8Array): MemoryRegion[] {
    const result = parsePaDa(bytes);
    if (result.skipped.length > 0) {
      this.emit({
        type: 'log',
        level: 'warn',
        message: `PA/DA parse: skipped ${result.skipped.length} lines (first: line ${result.skipped[0]!.lineNumber} ${result.skipped[0]!.reason})`,
      });
    }
    const bad = result.records.filter((r) => !r.checksumOk);
    if (bad.length > 0) {
      throw new Error(
        `PA/DA file has ${bad.length} record(s) with bad checksums — refusing to flash`,
      );
    }
    const regions = paDaToRegions(result);
    if (regions.length === 0) {
      throw new Error('PA/DA file parsed but contained no data records');
    }
    if (result.metadata.referenz) {
      this.emit({
        type: 'log',
        level: 'info',
        message: `firmware: $REFERENZ ${result.metadata.referenz.ref} ${result.metadata.referenz.flag}`,
      });
    }
    if (result.metadata.checksum) {
      this.emit({
        type: 'log',
        level: 'info',
        message: `firmware: $CHECKSUMME ${result.metadata.checksum.value} ${result.metadata.checksum.flag}`,
      });
    }
    return regions;
  }

  // ── Event helpers ───────────────────────────────────────────────

  private emit(e: FlashEvent): void {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }

  private emitPrecheckSummary(r: Awaited<ReturnType<typeof runPrecheck>>): void {
    if (r.hwReferenz.ok && !r.hwReferenz.skipped && r.hwReferenz.kennung) {
      this.emit({
        type: 'log',
        level: 'info',
        message: `HW_REFERENZ: kennung=${r.hwReferenz.kennung} projekt=${r.hwReferenz.projekt ?? '?'}`,
      });
    }
    if (r.sgStatus.ok && !r.sgStatus.skipped) {
      const bits: string[] = [];
      if (r.sgStatus.status !== undefined) bits.push(`status=0x${r.sgStatus.status.toString(16).padStart(2, '0')}`);
      if (r.sgStatus.progTyp !== undefined) bits.push(`prog_typ=${r.sgStatus.progTyp}`);
      if (r.sgStatus.progOrder !== undefined) bits.push(`prog_order=${r.sgStatus.progOrder}`);
      if (bits.length > 0) this.emit({ type: 'log', level: 'info', message: `SG_STATUS: ${bits.join(' ')}` });
    }
    if (r.sgIdent.ok && !r.sgIdent.skipped && r.sgIdent.bmwNr) {
      this.emit({
        type: 'log',
        level: 'info',
        message: `SG_IDENT: bmwnr=${r.sgIdent.bmwNr} sw=${r.sgIdent.swNr ?? '?'} hw=${r.sgIdent.hwNr ?? '?'} prod=${r.sgIdent.prodNr ?? '?'}`,
      });
    }
    if (r.sgAif.ok && !r.sgAif.skipped && r.sgAif.zbNr) {
      this.emit({
        type: 'log',
        level: 'info',
        message: `SG_AIF: zb=${r.sgAif.zbNr} sw=${r.sgAif.swNr ?? '?'} index=${r.sgAif.aenderungsIndex ?? '?'} datum=${r.sgAif.datum ?? '?'}`,
      });
    }
    if (r.hwnrMatch.ok && !r.hwnrMatch.skipped && r.hwnrMatch.actual && r.hwnrMatch.expected) {
      this.emit({
        type: 'log',
        level: 'info',
        message: `HWNR_MATCH: ${r.hwnrMatch.actual} == ${r.hwnrMatch.expected} ✓`,
      });
    }
  }

  private abortAt(
    stage: Stage,
    reason: unknown,
    stagesRun: Stage[],
    totalBytes: number,
    backupPath: string | undefined,
    dryRun: boolean,
  ): FlashResult {
    const msg = reason instanceof Error ? reason.message : String(reason);
    this.emit({ type: 'log', level: 'error', message: `aborting at ${stage}: ${msg}` });
    return {
      ok: false,
      stagesRun,
      abortedAt: stage,
      abortReason: msg,
      backupPath,
      totalBytes,
      dryRun,
      events: [...this.events],
    };
  }
}
