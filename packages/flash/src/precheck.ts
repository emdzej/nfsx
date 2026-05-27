/**
 * Pre-flash readiness checks — mirrors WinKFP's `coapiKfGet*FromSgD2`
 * family. Each check is one cabimain dispatch through the target SG's
 * IPO; results come back as named cabd-pars. We do NOT touch the
 * bus directly (no `ediabas.job('KOMBI', 'STATUS_LESEN', ...)` calls).
 *
 * Cross-referenced with winkfpt.exe Ghidra walk:
 *
 *   - `coapiKfGetHwReferenzFromSgD2` (FUN_00442080) dispatches
 *     `HW_REFERENZ` and reads `HW_REF_SG_KENNUNG` + `HW_REF_PROJEKT`.
 *   - `coapiKfGetProgOrderBsuD2` (FUN_004423e0) dispatches
 *     `SG_STATUS_LESEN` and reads `SG_STATUS` + `PROG_TYP` + `PROG_ORDER`.
 *   - There are ZERO `KL15` / `UBATT` / `KOMBI` / `STATUS_LESEN` strings
 *     in winkfpt.exe — battery/ignition are NOT WinKFP's concern. We
 *     don't pretend to gate on them either.
 *
 * The IPO does all the chassis-specific bus work internally (querying
 * the target SG via the right transport, running SEED_KEY+STATUS_LESEN
 * on the SGBD, etc.). The precheck stays chassis-agnostic.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import { startNfsRuntime } from '@emdzej/nfsx-runtime';
import { FscManager } from '@emdzej/nfsx-fsc';
import type { EcuTarget, PrecheckOptions } from './types.js';

export interface PrecheckReport {
  ok: boolean;
  hwReferenz: PrecheckEntry & { kennung?: string; projekt?: string };
  sgStatus: PrecheckEntry & {
    /** `SG_STATUS` byte — diagnostic context, NOT a hard gate (WinKFP logs to REF.OUT, doesn't fail on it). */
    status?: number;
    /** Programming type (1/2/3) — only present in multi-block (BSU/D2) flash scenarios. */
    progTyp?: number;
    /** Programming order (1/2) — paired with `progTyp`. */
    progOrder?: number;
  };
  sgIdent: PrecheckEntry & {
    bmwNr?: string;
    swNr?: string;
    hwNr?: string;
    diagIndex?: string;
    prodNr?: string;
  };
  sgAif: PrecheckEntry & {
    fgNr?: string;
    zbNr?: string;
    swNr?: string;
    aenderungsIndex?: string;
    datum?: string;
  };
  hwnrMatch: PrecheckEntry & {
    /** What the ECU reports (`ID_BMW_NR`). */
    actual?: string;
    /** What `target.expectedHwnr` said we should see. */
    expected?: string;
  };
  fsc: PrecheckEntry;
  /** Full cabd-par snapshot from the precheck dispatches — diagnostic context. */
  cabdPars: Record<string, string>;
}

export interface PrecheckEntry {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

export async function runPrecheck(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  opts: PrecheckOptions = {},
): Promise<PrecheckReport> {
  const skip = new Set(opts.skip ?? []);
  const report: PrecheckReport = {
    ok: false,
    hwReferenz: { ok: false },
    sgStatus: { ok: false },
    sgIdent: { ok: false },
    sgAif: { ok: false },
    hwnrMatch: { ok: false },
    fsc: { ok: false },
    cabdPars: {},
  };

  // One VM, four dispatches — cabd-pars accumulate across calls,
  // matching how WinKFP runs against a long-lived cabimain context.
  const allFour = ['hw_referenz', 'sg_status', 'sg_ident', 'sg_aif'] as const;
  const runAny = allFour.some((c) => !skip.has(c));

  if (runAny) {
    let handle: Awaited<ReturnType<typeof startNfsRuntime>>;
    try {
      handle = await startNfsRuntime({ ipoPath: ecu.ipoPath, sgbd: ecu.sgbd, ediabas, workingDir: ecu.workingDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failure = { ok: false, reason: `IPO load failed: ${msg}` };
      report.hwReferenz = skip.has('hw_referenz') ? { ok: true, skipped: true } : failure;
      report.sgStatus = skip.has('sg_status') ? { ok: true, skipped: true } : failure;
      report.sgIdent = skip.has('sg_ident') ? { ok: true, skipped: true } : failure;
      report.sgAif = skip.has('sg_aif') ? { ok: true, skipped: true } : failure;
      report.hwnrMatch = skip.has('hwnr_match') ? { ok: true, skipped: true } : failure;
      report.fsc = await runFscCheck(ecu, ediabas, skip.has('fsc'));
      report.ok = false;
      return report;
    }

    report.hwReferenz = await dispatchHwReferenz(handle, skip.has('hw_referenz'));
    report.sgStatus = await dispatchSgStatus(handle, skip.has('sg_status'));
    report.sgIdent = await dispatchSgIdent(handle, skip.has('sg_ident'));
    report.sgAif = await dispatchSgAif(handle, skip.has('sg_aif'));

    // Snapshot cabd-pars for diagnostics.
    for (const [k, v] of handle.state.cabdPars) report.cabdPars[k] = v;
  } else {
    // Everything skipped — runtime not needed.
    report.hwReferenz = { ok: true, skipped: true };
    report.sgStatus = { ok: true, skipped: true };
    report.sgIdent = { ok: true, skipped: true };
    report.sgAif = { ok: true, skipped: true };
  }

  report.hwnrMatch = checkHwnrMatch(ecu, report.sgIdent, skip.has('hwnr_match'));
  report.fsc = await runFscCheck(ecu, ediabas, skip.has('fsc'));

  report.ok =
    (report.hwReferenz.skipped || report.hwReferenz.ok) &&
    (report.sgStatus.skipped || report.sgStatus.ok) &&
    (report.sgIdent.skipped || report.sgIdent.ok) &&
    (report.sgAif.skipped || report.sgAif.ok) &&
    (report.hwnrMatch.skipped || report.hwnrMatch.ok) &&
    (report.fsc.skipped || report.fsc.ok);

  return report;
}

type Handle = Awaited<ReturnType<typeof startNfsRuntime>>;

async function dispatchHwReferenz(
  handle: Handle,
  skip: boolean,
): Promise<PrecheckReport['hwReferenz']> {
  if (skip) return { ok: true, skipped: true };
  try {
    await handle.runCabimain('HW_REFERENZ');
    const status = handle.state.lastJobStatus;
    if (status !== 0) {
      return { ok: false, reason: `HW_REFERENZ setjobstatus=${status}` };
    }
    const kennung = handle.state.cabdPars.get('HW_REF_SG_KENNUNG');
    const projekt = handle.state.cabdPars.get('HW_REF_PROJEKT');
    return { ok: true, kennung, projekt };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatchSgStatus(
  handle: Handle,
  skip: boolean,
): Promise<PrecheckReport['sgStatus']> {
  if (skip) return { ok: true, skipped: true };
  try {
    // WinKFP seeds HWNR_IS_NEW=0 before SG_STATUS_LESEN (FUN_00432990,
    // FUN_004423e0). We do the same — some IPOs branch on it.
    handle.state.cabdPars.set('HWNR_IS_NEW', '0');
    await handle.runCabimain('SG_STATUS_LESEN');
    const status = handle.state.lastJobStatus;
    if (status !== 0) {
      return { ok: false, reason: `SG_STATUS_LESEN setjobstatus=${status}` };
    }
    const out: PrecheckReport['sgStatus'] = { ok: true };
    const sgStatus = handle.state.cabdPars.get('SG_STATUS');
    if (sgStatus !== undefined) out.status = parseStatusByte(sgStatus);
    const progTyp = handle.state.cabdPars.get('PROG_TYP');
    if (progTyp !== undefined) out.progTyp = Number.parseInt(progTyp, 10);
    const progOrder = handle.state.cabdPars.get('PROG_ORDER');
    if (progOrder !== undefined) out.progOrder = Number.parseInt(progOrder, 10);
    return out;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatchSgIdent(
  handle: Handle,
  skip: boolean,
): Promise<PrecheckReport['sgIdent']> {
  if (skip) return { ok: true, skipped: true };
  try {
    await handle.runCabimain('SG_IDENT_LESEN');
    const status = handle.state.lastJobStatus;
    if (status !== 0) {
      return { ok: false, reason: `SG_IDENT_LESEN setjobstatus=${status}` };
    }
    return {
      ok: true,
      bmwNr: handle.state.cabdPars.get('ID_BMW_NR'),
      swNr: handle.state.cabdPars.get('ID_SW_NR'),
      hwNr: handle.state.cabdPars.get('ID_HW_NR'),
      diagIndex: handle.state.cabdPars.get('ID_DIAG_IND'),
      prodNr: handle.state.cabdPars.get('ID_PROD_NR'),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatchSgAif(
  handle: Handle,
  skip: boolean,
): Promise<PrecheckReport['sgAif']> {
  if (skip) return { ok: true, skipped: true };
  try {
    await handle.runCabimain('SG_AIF_LESEN');
    const status = handle.state.lastJobStatus;
    if (status !== 0) {
      return { ok: false, reason: `SG_AIF_LESEN setjobstatus=${status}` };
    }
    return {
      ok: true,
      fgNr: handle.state.cabdPars.get('AIF_FG_NR'),
      zbNr: handle.state.cabdPars.get('AIF_ZB_NR'),
      swNr: handle.state.cabdPars.get('AIF_SW_NR'),
      aenderungsIndex: handle.state.cabdPars.get('AIF_AENDERUNGS_INDEX'),
      datum: handle.state.cabdPars.get('AIF_DATUM'),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function checkHwnrMatch(
  ecu: EcuTarget,
  sgIdent: PrecheckReport['sgIdent'],
  skip: boolean,
): PrecheckReport['hwnrMatch'] {
  if (skip) return { ok: true, skipped: true };
  if (!ecu.expectedHwnr) {
    // No expectation set — nothing to compare against. Treat as skipped
    // rather than as a failure; this matches WinKFP's posture where
    // the HWNR check is only performed when an explicit HWNR_SOLL is
    // provided (see FUN_00447d10).
    return { ok: true, skipped: true, reason: 'no expectedHwnr set on EcuTarget' };
  }
  const actual = sgIdent.bmwNr;
  if (!actual) {
    // sg_ident skipped or failed — nothing to compare against. Auto-skip
    // rather than fail; the sg_ident failure (if any) is already surfaced
    // separately.
    return { ok: true, skipped: true, expected: ecu.expectedHwnr, reason: 'ID_BMW_NR unavailable from SG_IDENT_LESEN' };
  }
  if (actual !== ecu.expectedHwnr) {
    return {
      ok: false,
      actual,
      expected: ecu.expectedHwnr,
      reason: `ECU reports ID_BMW_NR=${actual} but target expects ${ecu.expectedHwnr}`,
    };
  }
  return { ok: true, actual, expected: ecu.expectedHwnr };
}

async function runFscCheck(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  skip: boolean,
): Promise<PrecheckEntry> {
  if (skip) return { ok: true, skipped: true };
  try {
    const mgr = new FscManager({
      ipoPath: ecu.swtIpoPath,
      sgbd: ecu.sgbd,
      ediabas,
    });
    const result = await mgr.checkFsc();
    if (!result.ok) {
      return { ok: false, reason: result.error?.message ?? `FSC check failed: ${result.jobStatus}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function parseStatusByte(raw: string): number {
  // SG_STATUS comes through as a stringified decimal int (cabd-par
  // convention). WinKFP formats it as %02X when logging — keep it
  // numeric here and let consumers format.
  return Number.parseInt(raw, 10);
}
