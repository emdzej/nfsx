/**
 * BMW DS2 SEED/KEY authentication. Engine ECUs and TCUs share the
 * same algorithm.
 *
 * Flow:
 *   1. Host sends `[ADDR] 0x07 0x90 0x42 0x4D 0x57 <NONCE> [XOR]`
 *      Payload = `[0x90, 0x42, 0x4D, 0x57, NONCE]` (NO `0x07` prog
 *      prefix — that turned out to be wrong in our earlier doc).
 *      `NONCE` is a random byte in 1..23 inclusive.
 *   2. ECU response framed as `[ADDR] LEN STATUS …seed bytes… XOR`.
 *      - If `LEN == 5` → ECU is already authorised; skip step 3.
 *      - If `LEN == 46` (0x2E) → seed material follows. Anything else
 *        is a protocol error.
 *   3. Compute the 4-byte key from the **full received frame**:
 *
 *        key[i] = (frame[(NONCE + i) mod frame[1]]
 *               +  frame[18 + i]
 *               +  frame[41 + i]) mod 256          for i = 0..3
 *
 *      Note: indices are into the FRAME (including ADDR at [0] and LEN
 *      at [1]), not into the payload — earlier versions of this file
 *      used payload-relative indices and produced wrong keys.
 *   4. Host sends `[ADDR] LEN 0x90 <k0..k3> [XOR]`
 *      Payload = `[0x90, k0, k1, k2, k3]`. Key submit uses the **same**
 *      command byte `0x90` as the seed request — the ECU disambiguates
 *      by payload length / shape, not by opcode.
 *   5. ECU returns status `0xA0` (accept) or an error.
 */
export const SEED_KEY_PREFIX = new Uint8Array([0x42, 0x4d, 0x57]); // "BMW"
export const SEED_REQUEST_CMD = 0x90;
/**
 * Key submit uses the same opcode as the seed request (verified in
 * upstream tooling). Our earlier impl had `0x91` which
 * the ECU rejects.
 */
export const KEY_SUBMIT_CMD = 0x90;

/** Successful seed-request response LEN values. */
export const SEED_RESP_LEN_AUTHORISED = 5; // ECU is already authed
export const SEED_RESP_LEN_FULL = 46; // 0x2E — seed material present

export class SeedKeyError extends Error {
  constructor(message: string) {
    super(`SEED/KEY: ${message}`);
    this.name = 'SeedKeyError';
  }
}

/**
 * Build the seed-request payload (the bytes after LEN and before XOR
 * in a DS2 frame). The full frame the transport sends will be
 * `[ADDR] LEN <payload> XOR`.
 *
 * Payload: `0x90 0x42 0x4D 0x57 <nonce>` (5 bytes).
 */
export function buildSeedRequestPayload(nonce: number): Uint8Array {
  if (nonce < 1 || nonce > 23 || !Number.isInteger(nonce)) {
    throw new SeedKeyError(`nonce must be an integer in 1..23 (got ${nonce})`);
  }
  const out = new Uint8Array(5);
  out[0] = SEED_REQUEST_CMD;
  out.set(SEED_KEY_PREFIX, 1);
  out[4] = nonce;
  return out;
}

/**
 * Compute the 4-byte key from the **full received DS2 frame** and the
 * nonce that was sent in the seed request.
 *
 * `frame` must be the complete received frame:
 *   frame[0]      = ADDR (echoed back)
 *   frame[1]      = LEN  (= 46 for a full seed response)
 *   frame[2]      = STATUS (= 0xA0)
 *   frame[3..]    = seed material
 *   frame[LEN-1]  = XOR
 *
 * Algorithm (verified vs):
 *   key[i] = ( frame[(NONCE + i) mod frame[1]]
 *           +  frame[18 + i]
 *           +  frame[41 + i] ) mod 256       for i = 0..3
 *
 * If your ECU rejects the derived key, dump the frame and double-check
 * frame[1] (the modulus) and the bytes at frame[18..21] and
 * frame[41..44] — those are the variant-specific entropy sources.
 */
export function deriveKey(frame: Uint8Array, nonce: number): Uint8Array {
  if (frame.length < 45) {
    throw new SeedKeyError(
      `frame too short: ${frame.length} bytes (need ≥ 45 to read frame[41..44])`,
    );
  }
  if (nonce < 1 || nonce > 23) {
    throw new SeedKeyError(`nonce must be in 1..23 (got ${nonce})`);
  }
  const modulus = frame[1];
  if (modulus === 0) {
    throw new SeedKeyError('frame[1] (LEN / modulus) is 0 — invalid frame');
  }
  const key = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const idx = (nonce + i) % modulus;
    key[i] = (frame[idx] + frame[18 + i] + frame[41 + i]) & 0xff;
  }
  return key;
}

/**
 * Build the key-submit payload: `0x90 <key0..key3>` (5 bytes).
 * Note the leading byte is `0x90`, the same as the seed-request cmd —
 * the ECU disambiguates by frame length / contents.
 */
export function buildKeySubmitPayload(key: Uint8Array): Uint8Array {
  if (key.length !== 4) {
    throw new SeedKeyError(`key must be exactly 4 bytes (got ${key.length})`);
  }
  const out = new Uint8Array(5);
  out[0] = KEY_SUBMIT_CMD;
  out.set(key, 1);
  return out;
}
