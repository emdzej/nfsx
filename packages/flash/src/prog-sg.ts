/**
 * `runProgramSg` — mirrors WinKFP's `coapiKfProgSgD2`.
 *
 * The flash is **a single IPO dispatch** of `SG_PROGRAMMIEREN`. The
 * IPO encapsulates every wire-level concern (security access via
 * SEED_KEY, programming-session entry, block transfer, post-flash
 * verification). Our job is to seed the right cabd-pars so the IPO
 * knows what to flash and what AIF to stamp post-flash.
 *
 * Verified against `winkfpt.exe` FUN_00455780 (xref to
 * `s_coapiKfProgSgD2_006001c4` at 0x006001c4) — see
 * `docs/architecture.md` §11.8.
 *
 * **Critical dependency:** the IPO reads the `.0PA` / `.0DA` files
 * via CABF* file-IO syscalls. Inpax-interpreter doesn't currently
 * implement those (task #234). Without them, dispatch will succeed
 * but the IPO will fail at the first `CABFOpen` call. Mock-mode
 * dispatch + dry-run still useful for shape validation.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { FirmwareSource, IpoRuntimeStart } from '@emdzej/nfsx-runtime';
import type { EcuTarget } from './types.js';
import {
  buildInstrumentedFirmwareSource,
  type FirmwareSourceStats,
} from './firmware-source.js';
import {
  newEdiabasJobCounters,
  wrapWithJobCounter,
  type EdiabasJobCounters,
} from './ediabas-counter.js';

/**
 * Cabd-pars `SG_PROGRAMMIEREN` reads. Matches what
 * `coapiKfProgSgD2` (FUN_00455780 in winkfpt.exe) sets before its
 * `coapiRunIpoJob("SG_PROGRAMMIEREN", ...)` call.
 *
 * Most fields default sensibly; the AIF block is only honored when
 * `progWithAif === true` — that's the BMW convention for "write AIF
 * inline as part of the flash" vs. "write AIF in a separate post-flash
 * step via SG_AIF_SCHREIBEN".
 */
export interface ProgramOptions {
  /**
   * Whether to write the AIF inline as part of the flash. When
   * `true`, all the `aif*` fields below must be populated; the IPO
   * will use them in the AIF region it stamps post-flash. When
   * `false`, the AIF is left untouched and the caller is responsible
   * for dispatching `SG_AIF_SCHREIBEN` separately.
   *
   * Mirrors `PROG_WITH_AIF` cabd-par in WinKFP.
   */
  progWithAif?: boolean;

  /**
   * `DOMINANTE` cabd-par. In WinKFP it's pulled from the runtime
   * global `DAT_006e0720`. Empirically appears to encode flash
   * priority / sequence mode. Default 0.
   */
  dominante?: number;

  /**
   * `BSUTIME` cabd-par — Block-Software-Update time-budget hint.
   * Pulled from `DAT_006e0828` in WinKFP. Default 0.
   */
  bsuTime?: number;

  /**
   * `SCHNELLE_BAUDRATE` cabd-par. Mapped from `WinKFP.INI`'s
   * `SCHNELLE_BAUDRATE` setting. When `true`, the IPO may negotiate
   * a faster baud rate after security access. Default false.
   */
  schnelleBaudrate?: boolean;

  /** AIF fields — required when `progWithAif === true`. */
  aifFgNr?: string;
  aifDatum?: string;
  aifAenderungsIndex?: string;
  aifSwNr?: string;
  aifBehoerdenNr?: string;
  aifZbNr?: string;
  aifSerienNr?: string;
  aifHaendlerNr?: string;
  aifKm?: string;
  aifProgNr?: string;
  aifAdresse?: string;

  /**
   * Override the slot 0x0E (CDHapiJobData) retry knobs. See
   * `BuildSystemFunctionsOptions` in nfsx-runtime for full doc.
   * When unset, the runtime applies its defaults: 2 retries, 200 ms
   * backoff, {ERROR_WRITE_DATA, ERROR_INVALID_BIN_BUFFER} as the
   * retryable status set.
   */
  maxBinaryRetries?: number;
  retryBackoffMs?: number;
}

export interface ProgramReport {
  ok: boolean;
  /** Final `setjobstatus` from the IPO (0 = success). */
  setjobstatus: number;
  /** Reason, if `ok === false`. */
  reason?: string;
  /**
   * Cabd-pars the IPO published as the dispatch ran. Includes
   * whatever progress / status the IPO surfaces. Empty when the
   * dispatch threw before publishing anything.
   */
  cabdPars: Record<string, string>;
  /**
   * What the firmware iterator actually delivered. Empty `calls`/
   * `bytesDelivered` on a "successful" run is the unambiguous
   * signature of an IPO that ran-but-didn't-flash (loop body never
   * executed). Undefined when `firmwareSource` wasn't supplied.
   */
  firmwareStats?: FirmwareSourceStats;
  /**
   * Per-job counters on the wire. For a real flash, expect
   * `FLASH_SCHREIBEN` ≈ `firmwareStats.calls - 1` (one less than
   * the iterator-call count because the EOF call doesn't trigger
   * a write).
   */
  ediabasJobs: EdiabasJobCounters;
  /**
   * Full per-slot trace from the IPO run — every CABI slot call in
   * order, with its arguments. Use to diagnose flows where the
   * counters look wrong (e.g. IPO drained the firmware iterator but
   * never dispatched FLASH_SCHREIBEN).
   */
  slotTrace: ReadonlyArray<{ slot: number; name: string; args: Record<string, unknown> }>;
}

/**
 * Dispatch `SG_PROGRAMMIEREN` against the target SG's IPO. This is
 * the ONLY wire-level call the host makes for a flash — the IPO
 * handles everything from security access to block transfer to
 * post-flash verification internally.
 *
 * `firmwareSource` is what the IPO's flash loop pops chunks from
 * via slot 0x55 — typically built via `buildRegionsFirmwareSource`
 * over the parsed `.0PA`. Without it, the loop exits immediately
 * (no payload), which is the safe degenerate path.
 */
export async function runProgramSg(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  startRuntime: IpoRuntimeStart,
  opts: ProgramOptions = {},
  firmwareSource?: FirmwareSource,
  onProgress?: (stats: import('./firmware-source.js').FirmwareSourceStats) => void,
): Promise<ProgramReport> {
  const cabdPars: Record<string, string> = {
    DOMINANTE: String(opts.dominante ?? 0),
    BSUTIME: String(opts.bsuTime ?? 0),
    SCHNELLE_BAUDRATE: opts.schnelleBaudrate ? 'ON' : 'OFF',
    PROG_WITH_AIF: opts.progWithAif ? '1' : '0',
  };

  if (opts.progWithAif) {
    // Match WinKFP's exact cabd-par names from FUN_00455780.
    if (opts.aifFgNr !== undefined) cabdPars['AIF_FG_NR'] = opts.aifFgNr;
    if (opts.aifDatum !== undefined) cabdPars['AIF_DATUM'] = opts.aifDatum;
    if (opts.aifAenderungsIndex !== undefined) cabdPars['AIF_AENDERUNGS_INDEX'] = opts.aifAenderungsIndex;
    if (opts.aifSwNr !== undefined) cabdPars['AIF_SW_NR'] = opts.aifSwNr;
    if (opts.aifBehoerdenNr !== undefined) cabdPars['AIF_BEHOERDEN_NR'] = opts.aifBehoerdenNr;
    if (opts.aifZbNr !== undefined) cabdPars['AIF_ZB_NR'] = opts.aifZbNr;
    if (opts.aifSerienNr !== undefined) cabdPars['AIF_SERIEN_NR'] = opts.aifSerienNr;
    if (opts.aifHaendlerNr !== undefined) cabdPars['AIF_HAENDLER_NR'] = opts.aifHaendlerNr;
    if (opts.aifKm !== undefined) cabdPars['AIF_KM'] = opts.aifKm;
    if (opts.aifProgNr !== undefined) cabdPars['AIF_PROG_NR'] = opts.aifProgNr;
    if (opts.aifAdresse !== undefined) cabdPars['AIF_ADRESSE'] = opts.aifAdresse;
  }

  const ediabasJobs = newEdiabasJobCounters();
  const countingProvider = wrapWithJobCounter(ediabas, ediabasJobs);
  const instrumented = firmwareSource
    ? buildInstrumentedFirmwareSource(
        firmwareSource,
        onProgress ? { onProgress } : {},
      )
    : undefined;

  try {
    const handle = await startRuntime(ecu.ipoPath, {
      sgbd: ecu.sgbd,
      ediabas: countingProvider,
      cabdPars,
      workingDir: ecu.workingDir,
      firmwareSource: instrumented ?? firmwareSource,
      maxBinaryRetries: opts.maxBinaryRetries,
      retryBackoffMs: opts.retryBackoffMs,
    });
    await handle.runCabimain('SG_PROGRAMMIEREN');
    const status = handle.state.lastJobStatus;
    const report: ProgramReport = {
      ok: status === 0,
      setjobstatus: status,
      cabdPars: Object.fromEntries(handle.state.cabdPars),
      ediabasJobs,
      slotTrace: [...handle.state.trace],
    };
    if (status !== 0) report.reason = `SG_PROGRAMMIEREN setjobstatus=${status}`;
    if (instrumented) report.firmwareStats = instrumented.stats;
    return report;
  } catch (err) {
    const report: ProgramReport = {
      ok: false,
      setjobstatus: -1,
      reason: err instanceof Error ? err.message : String(err),
      cabdPars: {},
      ediabasJobs,
      slotTrace: [],
    };
    if (instrumented) report.firmwareStats = instrumented.stats;
    return report;
  }
}

/**
 * Dispatch `SG_AIF_SCHREIBEN` as a separate post-flash step.
 *
 * Only needed when the prior `SG_PROGRAMMIEREN` ran with
 * `PROG_WITH_AIF=0` — i.e. the AIF wasn't stamped inline. WinKFP's
 * FUN_00455780 sets the same AIF_* cabd-pars + dispatches
 * `SG_AIF_SCHREIBEN` in this path.
 */
export async function runAifSchreiben(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  startRuntime: IpoRuntimeStart,
  opts: ProgramOptions,
): Promise<ProgramReport> {
  const cabdPars: Record<string, string> = {};
  if (opts.aifFgNr !== undefined) cabdPars['AIF_FG_NR'] = opts.aifFgNr;
  if (opts.aifDatum !== undefined) cabdPars['AIF_DATUM'] = opts.aifDatum;
  if (opts.aifAenderungsIndex !== undefined) cabdPars['AIF_AENDERUNGS_INDEX'] = opts.aifAenderungsIndex;
  if (opts.aifSwNr !== undefined) cabdPars['AIF_SW_NR'] = opts.aifSwNr;
  if (opts.aifBehoerdenNr !== undefined) cabdPars['AIF_BEHOERDEN_NR'] = opts.aifBehoerdenNr;
  if (opts.aifZbNr !== undefined) cabdPars['AIF_ZB_NR'] = opts.aifZbNr;
  if (opts.aifSerienNr !== undefined) cabdPars['AIF_SERIEN_NR'] = opts.aifSerienNr;
  if (opts.aifHaendlerNr !== undefined) cabdPars['AIF_HAENDLER_NR'] = opts.aifHaendlerNr;
  if (opts.aifKm !== undefined) cabdPars['AIF_KM'] = opts.aifKm;
  if (opts.aifProgNr !== undefined) cabdPars['AIF_PROG_NR'] = opts.aifProgNr;
  if (opts.aifAdresse !== undefined) cabdPars['AIF_ADRESSE'] = opts.aifAdresse;

  const ediabasJobs = newEdiabasJobCounters();
  const countingProvider = wrapWithJobCounter(ediabas, ediabasJobs);
  try {
    const handle = await startRuntime(ecu.ipoPath, {
      sgbd: ecu.sgbd,
      ediabas: countingProvider,
      cabdPars,
      workingDir: ecu.workingDir,
    });
    await handle.runCabimain('SG_AIF_SCHREIBEN');
    const status = handle.state.lastJobStatus;
    const report: ProgramReport = {
      ok: status === 0,
      setjobstatus: status,
      cabdPars: Object.fromEntries(handle.state.cabdPars),
      ediabasJobs,
      slotTrace: [...handle.state.trace],
    };
    if (status !== 0) report.reason = `SG_AIF_SCHREIBEN setjobstatus=${status}`;
    return report;
  } catch (err) {
    return {
      ok: false,
      setjobstatus: -1,
      reason: err instanceof Error ? err.message : String(err),
      cabdPars: {},
      slotTrace: [],
      ediabasJobs,
    };
  }
}
