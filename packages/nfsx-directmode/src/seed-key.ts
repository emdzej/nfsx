/**
 * BMW DS2 SEED/KEY authentication.
 *
 * Per `docs/raw-ds2-flashing.md` §3.2:
 *
 *   1. Host sends `[ADDR] 07 90 42 4D 57 <NONCE> [XOR]` — "BMW" + 1-byte
 *      nonce in 1..23.
 *   2. ECU responds with a 64-byte seed buffer.
 *   3. Host computes a 4-byte key:
 *
 *        key[i] = (seed[(nonce + i) mod seed[1]]
 *               +  seed[18 + i]
 *               +  seed[41 + i]) mod 256        for i = 0..3
 *
 *   4. Host sends `[ADDR] 0A 91 <key0..key3> [XOR]` — "submit key".
 *   5. ECU returns status `0xA0` (accept) or an error.
 *
 * Nonce MUST be in 1..23 inclusive; 0 and ≥24 give undefined behaviour.
 */
import { Buffer } from 'node:buffer';

export const SEED_KEY_PREFIX = Buffer.from([0x42, 0x4d, 0x57]); // "BMW"
export const SEED_REQUEST_CMD = 0x90;
export const KEY_SUBMIT_CMD = 0x91;
/** Some ECUs use a 2-byte programming-prefix for SEED/KEY; MS-class uses just 0x90 / 0x91. */

export class SeedKeyError extends Error {
  constructor(message: string) {
    super(`SEED/KEY: ${message}`);
    this.name = 'SeedKeyError';
  }
}

/**
 * Build the seed-request payload (the bytes after LEN and before XOR
 * in a DS2 frame). The full frame is `[ADDR] LEN <payload> XOR`.
 *
 * Payload: `0x90 0x42 0x4D 0x57 <nonce>` (5 bytes).
 */
export function buildSeedRequestPayload(nonce: number): Buffer {
  if (nonce < 1 || nonce > 23 || !Number.isInteger(nonce)) {
    throw new SeedKeyError(`nonce must be an integer in 1..23 (got ${nonce})`);
  }
  return Buffer.concat([Buffer.from([SEED_REQUEST_CMD]), SEED_KEY_PREFIX, Buffer.from([nonce])]);
}

/**
 * Compute the 4-byte key from the seed buffer and nonce.
 *
 * The seed buffer is the DS2 *payload* of the response (i.e. after
 * LEN/STATUS, before XOR — the actual seed material). Layout:
 *   seed[0..1]   header / status bytes (the wraparound modulus uses seed[1])
 *   seed[2..17]  variant material
 *   seed[18..21] key-derivation table A (used directly for indices 0..3)
 *   seed[22..40] more variant material
 *   seed[41..44] key-derivation table B
 *   ...
 *
 * `seed[1]` is the modulus used when wrapping the nonce index —
 * different ECUs may use a different field. If your ECU rejects the
 * derived key, dump the seed and check whether `seed[1]` is the actual
 * modulus on that variant.
 */
export function deriveKey(seed: Buffer, nonce: number): Buffer {
  if (seed.length < 45) {
    throw new SeedKeyError(
      `seed buffer too short: ${seed.length} bytes (need ≥ 45 to compute key)`,
    );
  }
  if (nonce < 1 || nonce > 23) {
    throw new SeedKeyError(`nonce must be in 1..23 (got ${nonce})`);
  }
  const modulus = seed[1];
  if (modulus === 0) {
    throw new SeedKeyError(`seed[1] (the wraparound modulus) is 0 — refusing to divide by zero`);
  }
  const key = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const idx = (nonce + i) % modulus;
    key[i] = (seed[idx] + seed[18 + i] + seed[41 + i]) & 0xff;
  }
  return key;
}

/**
 * Build the key-submit payload: `0x91 <key0..key3>` (5 bytes).
 */
export function buildKeySubmitPayload(key: Buffer): Buffer {
  if (key.length !== 4) {
    throw new SeedKeyError(`key must be exactly 4 bytes (got ${key.length})`);
  }
  return Buffer.concat([Buffer.from([KEY_SUBMIT_CMD]), key]);
}
