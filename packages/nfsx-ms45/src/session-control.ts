/**
 * Session-control choreography for MS45.
 *
 * Two distinct wire realities:
 *
 *   MS45.0 (E46, DS2 K-line)
 *     Sits at 9600 baud by default. To flash or read at usable speed
 *     the host must:
 *       1. Complete auth (see auth-flow.ts).
 *       2. Ask the ECU to switch to programming mode at the higher
 *          baud     — SGBD `diagnose_mode ECUPM;PC115200`.
 *       3. Retune the host UART                  — `SET_PARAMETER ;115200`.
 *       4. Apply BMW-specific KWP timing params  — `ACCESS_TIMING_PARAMETER 00;120;24;240;00`.
 *       5. Retune the UART with a receive timeout — `SET_PARAMETER ;115200;;15`.
 *     Teardown reverses the first two: `diagnose_mode DEFAULT;PC9600`
 *     + `SET_PARAMETER ;9600`.
 *
 *   MS45.1 (E60/E65, BMW-FAST over CAN)
 *     Already at 115200 natively. Enter programming mode with
 *     `diagnose_mode ECUPM`; before write, bracket the flash burst
 *     with `normaler_datenverkehr` toggles so the gateway stops
 *     forwarding chatter that would interleave with the flash frames.
 *     Teardown: `diagnose_mode DEFAULT` + `normaler_datenverkehr ja;nein;ja`.
 *
 * The exact argument strings mirror what the reference flasher sends
 * — they're what the SGBD's job definitions expect.
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import { runJob } from './ms45-ediabas.js';
import { isBmwFast } from './ident.js';

/**
 * After a successful `authentisierung_start`, raise the K-line link
 * to programming baud (MS45.0) or just switch to ECU-programming
 * mode (MS45.1).
 *
 * @param diagProtocol  value from `identifyDme(...).diagProtocol`.
 */
export async function enterProgrammingMode(
  ediabas: IEdiabas,
  sgbd: string,
  diagProtocol: string,
): Promise<void> {
  if (isBmwFast(diagProtocol)) {
    await runJob(ediabas, sgbd, 'diagnose_mode', 'ECUPM');
    return;
  }
  await runJob(ediabas, sgbd, 'diagnose_mode', 'ECUPM;PC115200');
  await runJob(ediabas, sgbd, 'SET_PARAMETER', ';115200');
  await runJob(ediabas, sgbd, 'ACCESS_TIMING_PARAMETER', '00;120;24;240;00');
  await runJob(ediabas, sgbd, 'SET_PARAMETER', ';115200;;15');
}

/**
 * Drop back out of programming mode. Called after read/write finishes
 * so subsequent diagnostic sessions can use the default 9600 baud on
 * MS45.0.
 */
export async function leaveProgrammingMode(
  ediabas: IEdiabas,
  sgbd: string,
  diagProtocol: string,
): Promise<void> {
  if (isBmwFast(diagProtocol)) {
    await runJob(ediabas, sgbd, 'diagnose_mode', 'DEFAULT');
    await runJob(ediabas, sgbd, 'normaler_datenverkehr', 'ja;nein;ja');
    return;
  }
  await runJob(ediabas, sgbd, 'diagnose_mode', 'DEFAULT;PC9600');
  await runJob(ediabas, sgbd, 'SET_PARAMETER', ';9600');
}

/**
 * MS45.1-only: bracket the flash burst by asking the gateway to stop
 * routing normal-traffic frames to the DME (they'd interleave with
 * the flash-write telegrams). No-op on MS45.0 which is on a direct
 * K-line and has no gateway to convince.
 */
export async function suspendNormalTraffic(
  ediabas: IEdiabas,
  sgbd: string,
  diagProtocol: string,
): Promise<void> {
  if (!isBmwFast(diagProtocol)) return;
  await runJob(ediabas, sgbd, 'normaler_datenverkehr', 'nein;nein;ja');
  await runJob(ediabas, sgbd, 'normaler_datenverkehr', 'ja;nein;nein');
}
