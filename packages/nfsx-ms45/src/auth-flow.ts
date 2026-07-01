/**
 * Security-access wire flow — the full choreography that culminates
 * in a successful `authentisierung_start`.
 *
 *   1. Read the DME's serial number       (seriennummer_lesen)
 *      → extract the last 4 significant bytes.
 *   2. Pick a random 4-byte user-ID.
 *   3. Ask the ECU for a seed              (authentisierung_zufallszahl_lesen "3;0xUUUUUUUU")
 *      → ECU replies with N seed bytes in `ZUFALLSZAHL`.
 *   4. Compute the RSA-signed auth blob    (buildAuthenticationStartArg)
 *      → hand the 90-byte binary payload to `authentisierung_start`.
 *      → OKAY status means level-3 access granted for this session.
 *
 * Everything runs on the same SGBD as the identity probes; nothing
 * about baud rate or comm parameters changes yet — that's the job
 * of `enterProgrammingMode` (see `session-control.ts`).
 */

import { randomBytes } from 'node:crypto';
import type { IEdiabas } from '@emdzej/ediabasx-core';
import {
  buildAuthenticationStartArg,
  extractSerialNumber,
  formatSeedRequestArg,
} from './auth.js';
import { runJob, requireResultBinary } from './ms45-ediabas.js';

export interface AuthRandomSource {
  /** Return 4 random bytes for the user-ID. */
  userID(): Uint8Array;
}

/** Default random source — `crypto.randomBytes(4)`. */
export function defaultAuthRandom(): AuthRandomSource {
  return {
    userID(): Uint8Array {
      return new Uint8Array(randomBytes(4));
    },
  };
}

export interface AuthOptions {
  /**
   * Optional random source. Tests pin this to get deterministic
   * userIDs; production leaves it undefined to get `crypto.randomBytes`.
   */
  random?: AuthRandomSource;
}

export interface AuthResult {
  userID: Uint8Array;
  serialNumber: Uint8Array;
  seed: Uint8Array;
}

/**
 * Drive the whole security-access handshake. Throws Ms45JobError if
 * any job returns non-OKAY (typically `authentisierung_start` if the
 * cipher doesn't decrypt to the expected MD5 on the DME side).
 */
export async function requestSecurityAccess(
  ediabas: IEdiabas,
  sgbd: string,
  options?: AuthOptions,
): Promise<AuthResult> {
  const random = options?.random ?? defaultAuthRandom();

  const serialResp = await runJob(ediabas, sgbd, 'seriennummer_lesen');
  const serialTel = requireResultBinary(serialResp, 'seriennummer_lesen', '_TEL_ANTWORT');
  const serialNumber = extractSerialNumber(serialTel);

  const userID = random.userID();

  const seedResp = await runJob(
    ediabas,
    sgbd,
    'authentisierung_zufallszahl_lesen',
    formatSeedRequestArg(userID),
  );
  const seed = requireResultBinary(
    seedResp,
    'authentisierung_zufallszahl_lesen',
    'ZUFALLSZAHL',
  );

  const authMessage = buildAuthenticationStartArg({ userID, serialNumber, seed });
  await runJob(ediabas, sgbd, 'authentisierung_start', authMessage);

  return { userID, serialNumber, seed };
}
