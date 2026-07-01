/**
 * Post-write flash signature verification.
 *
 * After streaming a block to the DME, the ECU internally recomputes
 * the RSA-signed hash of the freshly-flashed segments and compares it
 * against the signature bytes stored inside the blob's header (see
 * `signature.ts`). The `FLASH_SIGNATUR_PRUEFEN` job triggers that
 * check and returns non-OKAY if the signature doesn't match.
 *
 * Args:
 *
 *   FLASH_SIGNATUR_PRUEFEN "Daten;64"      after a tune (parameter) flash
 *   FLASH_SIGNATUR_PRUEFEN "Programm;64"   after a full-program flash
 *
 * The 64 is the signature length in bytes (matches PARAM_SIG_LENGTH /
 * PROG_SIG_LENGTH).
 *
 * Also here: `flashProgrammingStatus()` — thin wrapper for
 * `FLASH_PROGRAMMIER_STATUS_LESEN`, called both before and after the
 * signature check in the reference flasher.
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import { runJob, requireResultString } from './ms45-ediabas.js';

export type FlashBlobKind = 'tune' | 'program';

function argForKind(kind: FlashBlobKind): string {
  return kind === 'tune' ? 'Daten;64' : 'Programm;64';
}

/**
 * Ask the DME to verify the signature over the blob it just received.
 * OKAY → signature valid; anything else throws (Ms45JobError).
 */
export async function verifyFlashSignature(
  ediabas: IEdiabas,
  sgbd: string,
  kind: FlashBlobKind,
): Promise<void> {
  await runJob(ediabas, sgbd, 'FLASH_SIGNATUR_PRUEFEN', argForKind(kind));
}

/** Read the DME's flash programming status text. Non-destructive. */
export async function flashProgrammingStatus(
  ediabas: IEdiabas,
  sgbd: string,
): Promise<string> {
  const resp = await runJob(ediabas, sgbd, 'FLASH_PROGRAMMIER_STATUS_LESEN');
  return requireResultString(
    resp,
    'FLASH_PROGRAMMIER_STATUS_LESEN',
    'FLASH_PROGRAMMIER_STATUS_TEXT',
  );
}

/** Reboot the DME. Standard post-flash step. */
export async function resetEcu(ediabas: IEdiabas, sgbd: string): Promise<void> {
  await runJob(ediabas, sgbd, 'STEUERGERAETE_RESET');
}
