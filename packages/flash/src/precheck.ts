/**
 * Pre-flash safety checks. Run BEFORE we put the ECU into
 * programming mode — failing any precheck is a clean abort point.
 *
 * Checks (all skippable for lab/test use, NEVER in production):
 *
 *   1. **Battery voltage** — ECUs lose power mid-flash if voltage
 *      drops; brick risk is high below ~12.5V.
 *   2. **Ignition state** — KL15 must be on, engine off. Reading
 *      from the body controller (e.g. `KOMBI` SGBD's
 *      `STATUS_LESEN` job).
 *   3. **ECU comms sanity** — target ECU must answer a basic
 *      `IDENT` job. Catches "wrong cable / wrong gateway" cases.
 *   4. **FSC validity** — via `FscManager.checkFsc`. If the FSC
 *      slot for this part number is invalid, the SG will refuse
 *      to enter programming mode at SESSION stage anyway.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import { FscManager } from '@emdzej/nfsx-fsc';
import type { EcuTarget, PrecheckOptions } from './types.js';

export interface PrecheckReport {
  ok: boolean;
  /** Per-check status. Skipped checks have `skipped: true`. */
  battery: PrecheckEntry & { voltage?: number };
  ignition: PrecheckEntry & { state?: string };
  ecuComms: PrecheckEntry;
  fsc: PrecheckEntry;
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
    battery: { ok: false },
    ignition: { ok: false },
    ecuComms: { ok: false },
    fsc: { ok: false },
  };

  report.battery = await checkBattery(ediabas, opts.minBatteryVoltage ?? 12.5, skip.has('battery'));
  report.ignition = await checkIgnition(ediabas, skip.has('ignition'));
  report.ecuComms = await checkEcuComms(ecu, ediabas, skip.has('ecu_comms'));
  report.fsc = await checkFsc(ecu, ediabas, skip.has('fsc'));

  report.ok =
    (report.battery.skipped || report.battery.ok) &&
    (report.ignition.skipped || report.ignition.ok) &&
    (report.ecuComms.skipped || report.ecuComms.ok) &&
    (report.fsc.skipped || report.fsc.ok);

  return report;
}

async function checkBattery(
  ediabas: IEdiabasProvider,
  minVoltage: number,
  skip: boolean,
): Promise<PrecheckReport['battery']> {
  if (skip) return { ok: true, skipped: true };
  try {
    // The KOMBI SGBD's STATUS_LESEN job typically publishes
    // `STAT_KL_15` / `STAT_UBATT_WERT` (battery voltage) — but the
    // exact SGBD + result names vary per chassis. We try the most
    // common ones; fall back to a "couldn't read" advisory.
    await ediabas.job('KOMBI', 'STATUS_LESEN', '', '');
    let voltage: number | undefined;
    if (ediabas.hasResult('STAT_UBATT_WERT', 1)) {
      voltage = ediabas.resultAnalog('STAT_UBATT_WERT', 1);
    } else if (ediabas.hasResult('STAT_UBATT', 1)) {
      voltage = ediabas.resultAnalog('STAT_UBATT', 1);
    }
    if (voltage === undefined) {
      return { ok: false, reason: 'battery voltage result not available from KOMBI' };
    }
    return {
      ok: voltage >= minVoltage,
      voltage,
      reason: voltage >= minVoltage ? undefined : `${voltage.toFixed(2)}V below ${minVoltage}V threshold`,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function checkIgnition(
  ediabas: IEdiabasProvider,
  skip: boolean,
): Promise<PrecheckReport['ignition']> {
  if (skip) return { ok: true, skipped: true };
  try {
    // KL_15 is the BMW name for ignition-on, engine-off. Read from
    // the body-controller status. Same caveat as battery — exact
    // result name varies; we try common variants.
    await ediabas.job('KOMBI', 'STATUS_LESEN', '', '');
    let state: string | undefined;
    if (ediabas.hasResult('STAT_KL_15_TEXT', 1)) {
      state = ediabas.resultText('STAT_KL_15_TEXT', 1, '');
    } else if (ediabas.hasResult('STAT_KL_15', 1)) {
      state = String(ediabas.resultDigital('STAT_KL_15', 1));
    }
    if (state === undefined) {
      return { ok: false, reason: 'KL_15 result not available from KOMBI' };
    }
    const on = state === 'true' || state === '1' || state.toLowerCase().includes('on') || state.toLowerCase().includes('ein');
    return {
      ok: on,
      state,
      reason: on ? undefined : `KL_15 reports "${state}" — ignition must be on (engine off) for flash`,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function checkEcuComms(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  skip: boolean,
): Promise<PrecheckEntry> {
  if (skip) return { ok: true, skipped: true };
  try {
    // A bare `IDENT` job confirms the SGBD loads and the ECU
    // answers. Any failure here means we'd be flashing into thin
    // air — fail fast.
    await ediabas.job(ecu.sgbd, 'IDENT', '', '');
    const status = ediabas.hasResult('JOB_STATUS', 1)
      ? ediabas.resultText('JOB_STATUS', 1, '')
      : '';
    if (status !== 'OKAY') {
      return { ok: false, reason: `${ecu.sgbd}!IDENT JOB_STATUS="${status}"` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function checkFsc(
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
