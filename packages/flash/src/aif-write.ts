/**
 * AIF_WRITE stage — post-flash After-Information-File identity stamp.
 *
 * The SGBD-level write is `apiJob(sgbd, "AIF_SCHREIBEN", para, ...)`
 * where `para` packs the AIF payload fields the SGBD expects. The
 * exact param-packing varies per ECU (KWP-era ECUs use a semicolon-
 * separated string; some older DS2 ECUs take a binary buffer).
 *
 * The simpler direct-apiJob path here is what's correct for the
 * flash orchestrator — the per-ECU `16xxx.ipo` (which has
 * SG_AIF_SCHREIBEN as a job) does the same thing internally,
 * wrapped in cabd-par handling that the C host orchestrator
 * doesn't need.
 *
 * Caller supplies the payload; we serialise the standard fields
 * (datum / swNr / progNr / haendlerNr / km) into a semicolon-joined
 * para string. Per-ECU variants override this via the `para`
 * override.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { EcuTarget } from './types.js';

export interface AifPayload {
  /** Write date — BMW format e.g. "15.03.2008". */
  datum?: string;
  /** Software ID being stamped. */
  swNr?: string;
  /** Programming station / operator ID. */
  progNr?: string;
  /** Dealer / Händler number. */
  haendlerNr?: string;
  /** Odometer reading at flash time. */
  km?: string;
  /**
   * Override the auto-packed `para` string. When set, the AIF
   * payload fields above are ignored; this raw string is passed
   * directly to apiJob. For per-ECU formatting quirks.
   */
  para?: string;
}

export async function runAifWrite(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  payload: AifPayload = {},
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const para = payload.para ?? packPara(payload);
    await ediabas.job(ecu.sgbd, 'AIF_SCHREIBEN', para, '');
    const status = ediabas.hasResult('JOB_STATUS', 1)
      ? ediabas.resultText('JOB_STATUS', 1, '')
      : '';
    if (status !== 'OKAY') {
      return { ok: false, reason: `AIF_SCHREIBEN JOB_STATUS="${status}"` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pack the standard AIF fields into a semicolon-joined para string.
 * Empty fields are preserved as empty positions (the SGBD's
 * field-positional parser depends on placeholders).
 */
function packPara(p: AifPayload): string {
  return [p.datum ?? '', p.swNr ?? '', p.progNr ?? '', p.haendlerNr ?? '', p.km ?? ''].join(';');
}
