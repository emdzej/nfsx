/**
 * Pre-flash audit backup — mirrors WinKFP's actual backup behaviour
 * (faithful, no embellishment).
 *
 * **What WinKFP actually does** (verified across 4 functions in
 * winkfpt.exe on 2026-05-27, see docs/architecture.md §11.6):
 *
 *   - `FUN_00432300` — dispatches `ZIF_BACKUP` IPO job, reads
 *     ZIF_BACKUP_SG_KENNUNG/PROJEKT/PROGRAMM_STAND/BMW_HW/BMW_PST/STATUS
 *     cabd-pars, appends to `REF.OUT` as audit log.
 *   - `coapiKfCheckReferenzD2` (FUN_00450300) — uses ZIF_BACKUP as an
 *     IDENTITY-FALLBACK when current ZIF reads garbage.
 *   - `coapiKfGetHwNrFromSgD2` (FUN_00445900) — uses ZIF_BACKUP as
 *     HW-NR FALLBACK when SG_IDENT_LESEN gives garbage.
 *   - `WinKFP.INI` defines `KomfortKonfPath=C:\\NFS-Backup` — that's
 *     where coding/comfort BACKUPS go, NOT firmware.
 *
 * **What WinKFP does NOT do: there is no firmware backup feature.**
 * `ZIF_BACKUP` is on-ECU REDUNDANCY (the ECU keeps a backup copy of
 * its identity in a separate flash region — used to recover from a
 * failed flash mid-write). It's NOT a host-side ROM save. BMW's
 * architecture relies on SP-Daten as the canonical firmware source;
 * if you brick, you re-flash from SP-Daten.
 *
 * **What this `runBackup` does:** captures the same IPO-driven
 * identity + audit state WinKFP records, persists as JSON. Useful
 * as a pre-flash snapshot for forensic / audit purposes. NOT a
 * brick-recovery image. Adding raw flash dumps via SGBD-specific
 * jobs would violate the IPO-driven principle that scopes our
 * design (see [[feedback-precheck-ipo-driven]]).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import { startNfsRuntime } from '@emdzej/nfsx-runtime';
import type { EcuTarget } from './types.js';

export interface BackupReport {
  /** ISO-8601 timestamp the backup was taken (UTC). */
  timestamp: string;
  /** Schema version for forward-compat. Bump when fields change shape. */
  schemaVersion: 1;
  /** What we know about the target at backup time. */
  target: {
    sgbd: string;
    ipoPath: string;
    diagAddr?: number;
    expectedHwnr?: string;
  };
  /**
   * Result of each IPO dispatch — `setjobstatus` (numeric, 0=OK) plus
   * the full cabd-par snapshot after each call. Stored as a record of
   * `<job-name> → { setjobstatus, cabdPars }`.
   */
  ipoDispatches: Record<
    string,
    { setjobstatus: number; cabdPars: Record<string, string> } | { error: string }
  >;
  /**
   * Final accumulated cabd-par store after all dispatches. Convenient
   * single-pane-of-glass — same data as the per-dispatch snapshots
   * but with later jobs overriding earlier ones.
   */
  finalCabdPars: Record<string, string>;
  /** System-data store (separate from cabd-pars). */
  systemData: Record<string, string>;
}

export interface BackupOptions {
  /**
   * Which IPO jobs to dispatch. Defaults to the four standard reads
   * that cover the irrecoverable host-state. Custom lists let callers
   * include SG-specific jobs (e.g. `ZIF_BACKUP` on GS20).
   */
  jobs?: ReadonlyArray<string>;
  /**
   * Pre-seed cabd-pars before dispatching. Mirrors the WinKFP
   * convention of setting `HWNR_IS_NEW=0` before `SG_STATUS_LESEN`.
   */
  cabdPars?: Record<string, string>;
}

/** Default jobs every backup runs — the universal IPO-level reads. */
export const DEFAULT_BACKUP_JOBS: ReadonlyArray<string> = [
  'HW_REFERENZ',
  'SG_STATUS_LESEN',
  'SG_IDENT_LESEN',
  'SG_AIF_LESEN',
  // ZIF_BACKUP reads the ECU's redundant identity region. WinKFP's
  // FUN_00432300 dispatches this last; we mirror the order. The IPO
  // publishes ZIF_BACKUP_SG_KENNUNG/PROJEKT/PROGRAMM_STAND/BMW_HW/
  // BMW_PST/STATUS as result cabd-pars. WinKFP treats status code
  // 0x427 as "no backup data" (not an error) — `runBackup` records
  // it in the report rather than aborting.
  'ZIF_BACKUP',
];

/**
 * WinKFP-specific success code for `ZIF_BACKUP` IPO when the ECU
 * doesn't have a populated backup region. Observed in
 * `FUN_00432300` as a special-case branch that closes the audit
 * file and returns success.
 */
export const ZIF_BACKUP_NOT_AVAILABLE = 0x427;

/**
 * Read the target SG via its IPO and capture every cabd-par each
 * dispatch publishes. Returns a `BackupReport` ready to be JSON-
 * serialised + persisted with `writeBackupFile`.
 *
 * Same cabimain dispatch pattern as `runPrecheck` — one runtime
 * handle, multiple jobs run in sequence, cabd-pars accumulate. The
 * difference is intent: precheck gates a flash, backup persists
 * state.
 */
export async function runBackup(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  opts: BackupOptions = {},
): Promise<BackupReport> {
  const jobs = opts.jobs ?? DEFAULT_BACKUP_JOBS;

  const handle = await startNfsRuntime({
    ipoPath: ecu.ipoPath,
    sgbd: ecu.sgbd,
    ediabas,
    cabdPars: { HWNR_IS_NEW: '0', ...(opts.cabdPars ?? {}) },
    workingDir: ecu.workingDir,
  });

  const ipoDispatches: BackupReport['ipoDispatches'] = {};

  for (const job of jobs) {
    try {
      await handle.runCabimain(job);
      ipoDispatches[job] = {
        setjobstatus: handle.state.lastJobStatus,
        cabdPars: Object.fromEntries(handle.state.cabdPars),
      };
    } catch (err) {
      ipoDispatches[job] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Merge per-dispatch cabd-pars with "last non-empty wins". Some
  // IPO jobs (notably ZIF_BACKUP) clear cabd-par keys their callers
  // populated earlier — e.g. ZIF_BACKUP wipes AIF_* by calling
  // CDHSetCabdPar with empty strings as part of its normal flow.
  // Without this merge, the post-dispatch handle.state would lose
  // the AIF values SG_AIF_LESEN published moments earlier.
  // Use ordered iteration so a later non-empty value overrides; an
  // earlier non-empty value survives a later empty-string write.
  const merged: Record<string, string> = {};
  for (const result of Object.values(ipoDispatches)) {
    if (!('cabdPars' in result)) continue;
    for (const [k, v] of Object.entries(result.cabdPars)) {
      if (v !== '') merged[k] = v;
      else if (!(k in merged)) merged[k] = '';
    }
  }

  return {
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    target: {
      sgbd: ecu.sgbd,
      ipoPath: ecu.ipoPath,
      diagAddr: ecu.diagAddr,
      expectedHwnr: ecu.expectedHwnr,
    },
    ipoDispatches,
    finalCabdPars: merged,
    systemData: Object.fromEntries(handle.state.systemData),
  };
}

/**
 * Persist a `BackupReport` to disk. Default filename pattern:
 * `<HWNR>-<ZB>-<UTC-timestamp>.json` under the chosen directory.
 * Creates the directory if missing. Returns the resolved absolute
 * path.
 */
export function writeBackupFile(
  report: BackupReport,
  outputDir: string,
  filename?: string,
): string {
  const dir = resolvePath(outputDir);
  mkdirSync(dir, { recursive: true });

  const name = filename ?? defaultBackupFilename(report);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return path;
}

/**
 * Build the canonical backup filename — used when the caller doesn't
 * specify one. Format: `<HWNR>-<ZB>-<sanitised-timestamp>.json`.
 * Falls back to `unknown` for any field we couldn't recover.
 */
export function defaultBackupFilename(report: BackupReport): string {
  const hwnr = report.finalCabdPars['ID_BMW_NR'] ?? report.target.expectedHwnr ?? 'unknownHwnr';
  const zb = report.finalCabdPars['AIF_ZB_NR'] ?? 'unknownZb';
  // ISO-8601 has `:` chars that are illegal on FAT/Win; replace + strip ms.
  const ts = report.timestamp.replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return `${hwnr}-${zb}-${ts}.json`;
}
