/**
 * AUTHENTICATE stage — UDS 0x27 SecurityAccess.
 *
 * Protocol (3-step):
 *   1. RequestSeed:    apiJob "SEED_LESEN" → ECU returns a seed (bytes)
 *   2. Compute key:    apply ECU-specific algorithm to seed → key
 *   3. SendKey:        apiJob "KEY_SCHREIBEN" with key as `para`
 *                      → ECU checks; OKAY = authenticated, else
 *                        access-denied
 *
 * The seed→key algorithm is BMW-internal — it lives in the SGBD's
 * `.PRG` bytecode and isn't published. Real production flashing
 * requires either:
 *   - A real ECU + the matching SGBD already loaded (which knows
 *     the algorithm)
 *   - Reverse-engineering the .PRG bytecode for each ECU type
 *   - Capturing a real seed/key pair from a known-good session
 *
 * For the nfsx orchestrator we accept a `KeyDerivationStrategy`
 * pluggable interface. Default is `PassthroughKeyDerivation` which
 * returns the seed unchanged — only useful when security access
 * is disabled (rare in production).
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { EcuTarget, KeyDerivationStrategy } from './types.js';

/**
 * Returns the seed unchanged. Useful for ECUs with security access
 * disabled, or for tests with a mock that doesn't verify the key.
 */
export const PassthroughKeyDerivation: KeyDerivationStrategy = {
  name: 'passthrough',
  derive(seed) {
    return new Uint8Array(seed);
  },
};

/**
 * Run the security-access handshake. Returns { ok, reason? }.
 * Caller is responsible for surfacing the error in event stream.
 */
export async function runAuthenticate(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  strategy: KeyDerivationStrategy = PassthroughKeyDerivation,
): Promise<{ ok: boolean; reason?: string }> {
  // Step 1: Request seed
  let seed: Uint8Array;
  try {
    await ediabas.job(ecu.sgbd, 'SEED_LESEN', '', '');
    const status = readJobStatus(ediabas);
    if (status !== 'OKAY') {
      return { ok: false, reason: `SEED_LESEN JOB_STATUS="${status}"` };
    }
    if (!ediabas.hasResult('SEED', 1)) {
      return { ok: false, reason: 'SGBD did not publish SEED result' };
    }
    seed = ediabas.resultBinary('SEED', 1);
  } catch (err) {
    return { ok: false, reason: `SEED_LESEN threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: Compute key
  let key: Uint8Array;
  try {
    key = await Promise.resolve(strategy.derive(seed, ecu));
  } catch (err) {
    return {
      ok: false,
      reason: `key derivation (${strategy.name}) threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 3: Send key
  try {
    // BMW's CABI convention packs the key as a hex string in the
    // `para` slot. The SGBD's BEST/2 bytecode reads it via `pari` /
    // `pars` and feeds the underlying UDS 0x27 0x02 frame.
    const keyHex = bytesToHex(key);
    await ediabas.job(ecu.sgbd, 'KEY_SCHREIBEN', keyHex, '');
    const status = readJobStatus(ediabas);
    if (status !== 'OKAY') {
      return { ok: false, reason: `KEY_SCHREIBEN JOB_STATUS="${status}"` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `KEY_SCHREIBEN threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function readJobStatus(ediabas: IEdiabasProvider): string {
  if (!ediabas.hasResult('JOB_STATUS', 1)) return '';
  return ediabas.resultText('JOB_STATUS', 1, '');
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0').toUpperCase();
  }
  return s;
}
