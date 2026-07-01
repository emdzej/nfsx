/**
 * MS45 firmware RSA-512 signing.
 *
 * A parameter or program blob is signed by:
 *
 *   1. Reading a segment table from the blob header (count, then
 *      (start, length) descriptors). Program segments span both the
 *      external and MPC flash spaces — see `regions.ts`.
 *   2. Concatenating the raw bytes named by those segments into a
 *      single buffer.
 *   3. MD5 hashing that buffer → 16-byte digest.
 *   4. Treating the digest as a little-endian 128-bit integer M,
 *      computing C = M^d mod n with the DME's private key, where
 *      (n, d) is the RSA-512 key pair.
 *   5. Serialising C as a 64-byte block: 16 words, least-significant
 *      word first, each word stored big-endian internally.
 *   6. Writing the 64-byte block at the header's stored-signature
 *      offset (0x174 for the parameter blob, 0x60074 for the program).
 *
 * That LSW-first / BE-within-word storage is exactly what the C#
 * reference produces. Verify = re-sign and compare — signing is
 * deterministic so the recomputed block must match the stored one
 * byte-for-byte.
 *
 * Attribution
 * -----------
 * The RSA modulus and private exponent below were reverse-engineered
 * by hassmaschine and first published in the GPL-3.0
 * terraphantm/MS45-Flasher project's Checksums_Signatures.cs. This is
 * a clean-room reimplementation of the algorithm; the constants are
 * facts (numbers), not code.
 */

import { createHash } from 'node:crypto';
import {
  PARAM_SIG_STORED_OFFSET,
  PARAM_SIG_LENGTH,
  PROG_SIG_STORED_OFFSET,
  PROG_SIG_LENGTH,
  parseParameterSignedSegments,
  parseProgramSignedSegments,
} from './regions.js';

// ── RSA-512 firmware-signing key ────────────────────────────────────

/**
 * Modulus (n) of the RSA-512 key the DME uses to authenticate
 * parameter and program blobs. Public key material; would be
 * embedded in a real signature-verify path but here it's a companion
 * constant kept next to `d` for clarity.
 */
export const FIRMWARE_MODULUS = BigInt(
  '8470472580328006956677424405159809178175955696534718361218518906571634405286747173565502454089691240931470915432212928785673566143706092135925769557255439',
);

/** Private exponent (d) of the RSA-512 firmware-signing key. */
export const FIRMWARE_PRIVATE_EXPONENT = BigInt(
  '7260405068852577391437792347279836438436533454172615738187301919918543775959908116508429649500721130520546364846625732843778800986047617824899475327781303',
);

// ── low-level primitives ────────────────────────────────────────────

/** MD5 → 16 bytes. Thin wrapper around node:crypto for testability. */
export function md5(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(data).digest());
}

/**
 * Modular exponentiation via square-and-multiply. All-BigInt so
 * numbers up to a few hundred bytes are fine; the RSA-512 case is
 * well within our runtime budget (a few milliseconds).
 */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 0n) throw new RangeError('modPow: mod must be non-zero');
  let result = 1n;
  let b = base % mod;
  if (b < 0n) b += mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/**
 * Interpret a byte array as a little-endian unsigned integer
 * (byte[0] is the LSB). Matches C#'s `new BigInteger(byte[])`.
 */
export function bytesLEToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}

/**
 * Serialise a non-negative BigInt as a fixed-length little-endian
 * byte array. Higher bits are silently discarded if the value
 * doesn't fit; callers must size `outLen` to the modulus (64 bytes
 * for RSA-512).
 */
export function bigIntToBytesLE(value: bigint, outLen: number): Uint8Array {
  if (value < 0n) throw new RangeError('bigIntToBytesLE: negative value');
  const out = new Uint8Array(outLen);
  let v = value;
  for (let i = 0; i < outLen; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Convert an RSA output block (64 bytes, little-endian) to the ECU's
 * storage layout: 16 words, LSW-first, each word encoded big-endian
 * internally. Inverse of `decodeSignatureBytes`.
 */
export function encodeSignatureBytes(encryptedLE: Uint8Array): Uint8Array {
  if (encryptedLE.length !== 64) {
    throw new RangeError(`encodeSignatureBytes: expected 64 bytes, got ${encryptedLE.length}`);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    out[4 * i + 0] = encryptedLE[4 * i + 3]!;
    out[4 * i + 1] = encryptedLE[4 * i + 2]!;
    out[4 * i + 2] = encryptedLE[4 * i + 1]!;
    out[4 * i + 3] = encryptedLE[4 * i + 0]!;
  }
  return out;
}

/**
 * Sign a message (already MD5-hashed) with the firmware key,
 * returning the 64-byte block in ECU-storage layout.
 */
export function signHashedFirmware(hash: Uint8Array): Uint8Array {
  if (hash.length !== 16) {
    throw new RangeError(`signHashedFirmware: expected 16-byte MD5, got ${hash.length}`);
  }
  const m = bytesLEToBigInt(hash);
  const c = modPow(m, FIRMWARE_PRIVATE_EXPONENT, FIRMWARE_MODULUS);
  return encodeSignatureBytes(bigIntToBytesLE(c, 64));
}

// ── segment concatenation ──────────────────────────────────────────

function collectParameterSignedBytes(paramBlob: Uint8Array): Uint8Array {
  const segments = parseParameterSignedSegments(paramBlob);
  let total = 0;
  for (const seg of segments) total += seg.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const seg of segments) {
    if (seg.hostOffset < 0 || seg.hostOffset + seg.length > paramBlob.length) {
      throw new RangeError(
        `parameter signed segment [0x${seg.hostOffset.toString(16)} +${seg.length}] out of blob bounds (len 0x${paramBlob.length.toString(16)})`,
      );
    }
    out.set(paramBlob.subarray(seg.hostOffset, seg.hostOffset + seg.length), offset);
    offset += seg.length;
  }
  return out;
}

function collectProgramSignedBytes(external: Uint8Array, mpc: Uint8Array): Uint8Array {
  const segments = parseProgramSignedSegments(external);
  let total = 0;
  for (const seg of segments) total += seg.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const seg of segments) {
    const src = seg.space === 'external' ? external : mpc;
    if (seg.hostOffset < 0 || seg.hostOffset + seg.length > src.length) {
      throw new RangeError(
        `program signed segment [${seg.space} 0x${seg.hostOffset.toString(16)} +${seg.length}] out of bounds (region size 0x${src.length.toString(16)})`,
      );
    }
    out.set(src.subarray(seg.hostOffset, seg.hostOffset + seg.length), offset);
    offset += seg.length;
  }
  return out;
}

// ── public verify/rewrite surface ──────────────────────────────────

export interface SignatureCheckResult {
  stored: Uint8Array;
  computed: Uint8Array;
  ok: boolean;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function computeParameterSignature(paramBlob: Uint8Array): Uint8Array {
  return signHashedFirmware(md5(collectParameterSignedBytes(paramBlob)));
}

function computeProgramSignature(external: Uint8Array, mpc: Uint8Array): Uint8Array {
  return signHashedFirmware(md5(collectProgramSignedBytes(external, mpc)));
}

export function verifyParameterSignature(paramBlob: Uint8Array): SignatureCheckResult {
  const stored = paramBlob.slice(
    PARAM_SIG_STORED_OFFSET,
    PARAM_SIG_STORED_OFFSET + PARAM_SIG_LENGTH,
  );
  const computed = computeParameterSignature(paramBlob);
  return { stored, computed, ok: equalBytes(stored, computed) };
}

export function rewriteParameterSignature(paramBlob: Uint8Array): Uint8Array {
  const sig = computeParameterSignature(paramBlob);
  paramBlob.set(sig, PARAM_SIG_STORED_OFFSET);
  return paramBlob;
}

export function verifyProgramSignature(
  external: Uint8Array,
  mpc: Uint8Array,
): SignatureCheckResult {
  const stored = external.slice(
    PROG_SIG_STORED_OFFSET,
    PROG_SIG_STORED_OFFSET + PROG_SIG_LENGTH,
  );
  const computed = computeProgramSignature(external, mpc);
  return { stored, computed, ok: equalBytes(stored, computed) };
}

export function rewriteProgramSignature(
  external: Uint8Array,
  mpc: Uint8Array,
): Uint8Array {
  const sig = computeProgramSignature(external, mpc);
  external.set(sig, PROG_SIG_STORED_OFFSET);
  return external;
}
