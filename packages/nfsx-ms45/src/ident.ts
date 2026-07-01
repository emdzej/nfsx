/**
 * MS45 DME identification via SGBD jobs.
 *
 * Runs the same five-job probe sequence the reference flasher's
 * "Ident DME" button does:
 *
 *   aif_lesen                       → AIF_FG_NR                (VIN)
 *   hardware_referenz_lesen         → HARDWARE_REFERENZ        (HW ref)
 *   daten_referenz_lesen            → DATEN_REFERENZ           (SW ref)
 *   flash_programmier_status_lesen  → FLASH_PROGRAMMIER_STATUS_TEXT
 *   DIAGNOSEPROTOKOLL_LESEN         → DIAG_PROT_IST            ("BMW-FAST" …)
 *
 * The variant is derived from the hardware-reference string:
 *
 *   "0044560" → MS45.0  (E46 DS2 — needs baudrate raise to flash)
 *   "0044570" → MS45.1  (E60/E65 BMW-FAST — already at 115200)
 *
 * Every result is a plain string in the SGBD — no binary decoding
 * here, that's what makes this stage safe to run before auth.
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import { HW_REF_MS45_0, HW_REF_MS45_1, type Ms45Variant } from './regions.js';
import { runJob, requireResultString } from './ms45-ediabas.js';

export interface DmeIdent {
  /** Derived from HW_REF. Undefined when the ref matches neither known value. */
  variant: Ms45Variant | undefined;
  /** VIN — 17 ASCII chars, or fewer if the DME wasn't dealer-programmed. */
  vin: string;
  /** Hardware reference string — "0044560" for MS45.0, "0044570" for MS45.1. */
  hwRef: string;
  /** Software (data) reference. Contains the tune's part number. */
  swRef: string;
  /** Flash programming status (human-readable string from the SGBD). */
  programmingStatus: string;
  /**
   * Diagnostic protocol currently in use — `"BMW-FAST"` on MS45.1
   * (BMW-FAST / KWP2000 over CAN) or something else on MS45.0 (DS2
   * K-line). We only branch on the `"BMW-FAST"` case downstream.
   */
  diagProtocol: string;
}

export function classifyVariant(hwRef: string): Ms45Variant | undefined {
  if (hwRef === HW_REF_MS45_0) return 'MS45.0';
  if (hwRef === HW_REF_MS45_1) return 'MS45.1';
  return undefined;
}

/** True when the ECU speaks BMW-FAST natively (skip baud raise). */
export function isBmwFast(diagProtocol: string): boolean {
  return diagProtocol === 'BMW-FAST';
}

/** Run the five identity jobs and package the result. */
export async function identifyDme(ediabas: IEdiabas, sgbd: string): Promise<DmeIdent> {
  const aif = await runJob(ediabas, sgbd, 'aif_lesen');
  const vin = requireResultString(aif, 'aif_lesen', 'AIF_FG_NR');

  const hw = await runJob(ediabas, sgbd, 'hardware_referenz_lesen');
  const hwRef = requireResultString(hw, 'hardware_referenz_lesen', 'HARDWARE_REFERENZ');

  const sw = await runJob(ediabas, sgbd, 'daten_referenz_lesen');
  const swRef = requireResultString(sw, 'daten_referenz_lesen', 'DATEN_REFERENZ');

  const status = await runJob(ediabas, sgbd, 'flash_programmier_status_lesen');
  const programmingStatus = requireResultString(
    status,
    'flash_programmier_status_lesen',
    'FLASH_PROGRAMMIER_STATUS_TEXT',
  );

  const proto = await runJob(ediabas, sgbd, 'DIAGNOSEPROTOKOLL_LESEN');
  const diagProtocol = requireResultString(proto, 'DIAGNOSEPROTOKOLL_LESEN', 'DIAG_PROT_IST');

  return {
    variant: classifyVariant(hwRef),
    vin,
    hwRef,
    swRef,
    programmingStatus,
    diagProtocol,
  };
}
