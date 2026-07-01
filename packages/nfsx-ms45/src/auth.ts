/**
 * MS45 level-3 security-access payload builder.
 *
 * Wire flow (Stage 2 will drive it via SGBD jobs; this file only
 * builds the binary blob that goes to `authentisierung_start`):
 *
 *   1. Host asks ECU for its serial number       (SGBD: seriennummer_lesen)
 *      → we take the last 4 bytes minus the trailing terminator = 4-byte serialNumber
 *   2. Host picks a random 4-byte userID and asks for a random seed
 *      (SGBD: authentisierung_zufallszahl_lesen "3;0xUUUUUUUU")
 *      → ECU returns an N-byte seed in result ZUFALLSZAHL
 *   3. Host builds an authentication blob:
 *      hash = MD5(userID || serialNumber || seed)
 *      cipher = hash ^ d  mod  n     (RSA-512 sign with the level-3 key)
 *      payload = encodeSignatureBytes(cipher_LE)  || 0x03            (65 bytes)
 *      message = <25-byte EDIABAS header> || payload                 (90 bytes)
 *   4. Send `message` as the binary arg to SGBD authentisierung_start.
 *      ECU decrypts, MD5s (userID||serial||seed) itself, compares. If
 *      they match, level-3 access is granted for this session.
 *
 * The header bytes are EDIABAS binary-arg metadata (length, param
 * count, offsets), extracted from the SGBD's job definition. They're
 * treated as an opaque prologue here — the same 25 bytes are used
 * for every session.
 *
 * Attribution: the RSA modulus + private exponent below, and the
 * layout of the 90-byte message, are from hassmaschine's DME
 * reverse-engineering (as published in terraphantm/MS45-Flasher's
 * Checksums_Signatures.cs, GPL-3.0). Clean-room reimplementation.
 */

import {
  md5,
  modPow,
  bytesLEToBigInt,
  bigIntToBytesLE,
  encodeSignatureBytes,
} from './signature.js';

// ── level-3 auth RSA-512 key ───────────────────────────────────────

/** Modulus (n) of the level-3 security-access key. */
export const AUTH_MODULUS = BigInt(
  '8972339025878534711764289273376673716657892103603163846525142300863027035823902824753024958104010374518577719658056297243325957293507856591918471309133927',
);

/** Private exponent (d) of the level-3 security-access key. */
export const AUTH_PRIVATE_EXPONENT = BigInt(
  '3845288153947943447898981117161431592853382330115641648510775271798440158210161294390718397115404567798616968157688687573437683643982238798574542074351303',
);

/**
 * EDIABAS binary-arg prologue for `authentisierung_start`. Extracted
 * from the SGBD job definition; identical on every invocation.
 */
export const AUTH_MESSAGE_HEADER = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
]);

/** Trailing marker byte the ECU expects after the 64-byte cipher. */
export const AUTH_MESSAGE_TRAILER = 0x03;

/** Total length of the assembled message: 25 header + 64 cipher + 1 trailer. */
export const AUTH_MESSAGE_LENGTH = AUTH_MESSAGE_HEADER.length + 64 + 1;

// ── security-access level ──────────────────────────────────────────

/** Argument string to hand to the `authentisierung_zufallszahl_lesen` job. */
export function formatSeedRequestArg(userID: Uint8Array): string {
  if (userID.length !== 4) {
    throw new RangeError(`formatSeedRequestArg: userID must be 4 bytes, got ${userID.length}`);
  }
  // C# does `BitConverter.ToUInt32(userID.Reverse().ToArray(), 0)` before
  // stringifying — that reverses byte order (BitConverter on x86 is LE,
  // so reversing turns a BE-in-array userID into an LE u32, which then
  // prints in normal MSB-first hex). Match that.
  const u32 =
    (((userID[0]! << 24) | (userID[1]! << 16) | (userID[2]! << 8) | userID[3]!) >>> 0);
  return `3;0x${u32.toString(16).toUpperCase()}`;
}

/**
 * Extract the 4-byte serialNumber slice the auth hash expects from a
 * `seriennummer_lesen` `_TEL_ANTWORT` result buffer. The reply ends
 * with a trailing terminator byte; the four bytes before it are the
 * DME's unique serial suffix.
 */
export function extractSerialNumber(telAntwort: Uint8Array): Uint8Array {
  if (telAntwort.length < 5) {
    throw new RangeError(
      `extractSerialNumber: expected at least 5 bytes, got ${telAntwort.length}`,
    );
  }
  const end = telAntwort.length - 1; // drop terminator
  return telAntwort.slice(end - 4, end);
}

// ── message assembly ───────────────────────────────────────────────

export interface AuthMessageInput {
  /** 4-byte random ID chosen by the host. Must be the same one used
   *  in the preceding `authentisierung_zufallszahl_lesen` request. */
  userID: Uint8Array;
  /** 4-byte serialNumber slice (see `extractSerialNumber`). */
  serialNumber: Uint8Array;
  /** Seed bytes returned by the ECU in `ZUFALLSZAHL`. */
  seed: Uint8Array;
}

/**
 * Build the 90-byte binary argument that `authentisierung_start`
 * expects. The RSA signing is deterministic: same input → same output.
 */
export function buildAuthenticationStartArg(input: AuthMessageInput): Uint8Array {
  if (input.userID.length !== 4) {
    throw new RangeError(`userID must be 4 bytes, got ${input.userID.length}`);
  }
  if (input.serialNumber.length !== 4) {
    throw new RangeError(`serialNumber must be 4 bytes, got ${input.serialNumber.length}`);
  }

  const toHash = new Uint8Array(4 + 4 + input.seed.length);
  toHash.set(input.userID, 0);
  toHash.set(input.serialNumber, 4);
  toHash.set(input.seed, 8);

  const hash = md5(toHash);
  const m = bytesLEToBigInt(hash);
  const c = modPow(m, AUTH_PRIVATE_EXPONENT, AUTH_MODULUS);
  const payload = encodeSignatureBytes(bigIntToBytesLE(c, 64));

  const out = new Uint8Array(AUTH_MESSAGE_LENGTH);
  out.set(AUTH_MESSAGE_HEADER, 0);
  out.set(payload, AUTH_MESSAGE_HEADER.length);
  out[AUTH_MESSAGE_HEADER.length + 64] = AUTH_MESSAGE_TRAILER;
  return out;
}
