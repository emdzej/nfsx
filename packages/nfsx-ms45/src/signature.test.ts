import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  md5,
  modPow,
  bytesLEToBigInt,
  bigIntToBytesLE,
  encodeSignatureBytes,
  signHashedFirmware,
  verifyParameterSignature,
  rewriteParameterSignature,
  verifyProgramSignature,
  rewriteProgramSignature,
  FIRMWARE_MODULUS,
  FIRMWARE_PRIVATE_EXPONENT,
} from './signature.js';
import {
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  TUNE_BLOB_SIZE,
  PARAM_SIG_SEGMENT_COUNT_OFFSET,
  PARAM_SIG_SEGMENT_STARTS_OFFSET,
  PARAM_SIG_SEGMENT_LENGTHS_OFFSET,
  PARAM_SIG_SEGMENT_BASE,
  PARAM_SIG_STORED_OFFSET,
  PARAM_SIG_LENGTH,
  PROG_SIG_SEGMENT_COUNT_OFFSET,
  PROG_SIG_SEGMENT_STARTS_OFFSET,
  PROG_SIG_SEGMENT_LENGTHS_OFFSET,
  PROG_SIG_STORED_OFFSET,
  PROG_SIG_LENGTH,
  writeU32BE,
} from './regions.js';

// ── low-level primitives ───────────────────────────────────────────

describe('md5', () => {
  it('empty input matches the standard vector', () => {
    const hex = Buffer.from(md5(new Uint8Array(0))).toString('hex');
    expect(hex).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('"abc" matches the standard vector', () => {
    const hex = Buffer.from(md5(new TextEncoder().encode('abc'))).toString('hex');
    expect(hex).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});

describe('modPow', () => {
  it('basic identities', () => {
    expect(modPow(0n, 5n, 7n)).toBe(0n);
    expect(modPow(3n, 0n, 7n)).toBe(1n);
    expect(modPow(3n, 1n, 7n)).toBe(3n);
  });

  it('Fermat: 2^(p-1) mod p == 1 for prime p', () => {
    expect(modPow(2n, 12n, 13n)).toBe(1n);
    expect(modPow(2n, 30n, 31n)).toBe(1n);
  });

  it('handles negative base by canonicalising', () => {
    expect(modPow(-3n, 2n, 7n)).toBe(2n); // (-3)^2 = 9 ≡ 2 mod 7
  });

  it('rejects modulus zero', () => {
    expect(() => modPow(1n, 1n, 0n)).toThrow(/non-zero/);
  });
});

describe('bytesLEToBigInt / bigIntToBytesLE', () => {
  it('LE round-trip preserves value', () => {
    for (const value of [0n, 1n, 0xdeadbeefn, (1n << 500n) + 42n]) {
      const bytes = bigIntToBytesLE(value, 80);
      expect(bytesLEToBigInt(bytes)).toBe(value);
    }
  });

  it('byte[0] is the LSB (matches C# BigInteger constructor)', () => {
    expect(bytesLEToBigInt(new Uint8Array([0x01, 0x00]))).toBe(1n);
    expect(bytesLEToBigInt(new Uint8Array([0x00, 0x01]))).toBe(256n);
  });

  it('bigIntToBytesLE truncates high bits when they overflow outLen', () => {
    expect(Array.from(bigIntToBytesLE(0xff01n, 1))).toEqual([0x01]);
  });
});

describe('encodeSignatureBytes', () => {
  it('reverses byte order within each 4-byte word', () => {
    // Word 0 = [0x00, 0x01, 0x02, 0x03] LE → stored as [0x03, 0x02, 0x01, 0x00]
    // Word 1 = [0x10, 0x11, 0x12, 0x13] LE → stored as [0x13, 0x12, 0x11, 0x10]
    const input = new Uint8Array(64);
    for (let i = 0; i < 64; i++) input[i] = i;
    const out = encodeSignatureBytes(input);
    // Check first two words
    expect(Array.from(out.subarray(0, 4))).toEqual([3, 2, 1, 0]);
    expect(Array.from(out.subarray(4, 8))).toEqual([7, 6, 5, 4]);
    // Check last word
    expect(Array.from(out.subarray(60, 64))).toEqual([63, 62, 61, 60]);
  });

  it('rejects wrong-length input', () => {
    expect(() => encodeSignatureBytes(new Uint8Array(63))).toThrow(/64 bytes/);
  });
});

// ── RSA self-consistency ───────────────────────────────────────────
//
// We don't have the public exponent from the reference source, but we
// can prove the modexp is behaving sanely: (1) signing is deterministic,
// (2) different inputs give different outputs, (3) the ciphertext is
// less than the modulus.

describe('signHashedFirmware', () => {
  it('signing is deterministic', () => {
    const hash = md5(new TextEncoder().encode('MS45 firmware sig test'));
    const a = signHashedFirmware(hash);
    const b = signHashedFirmware(hash);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(64);
  });

  it('different messages produce different signatures', () => {
    const s1 = signHashedFirmware(md5(new Uint8Array([1])));
    const s2 = signHashedFirmware(md5(new Uint8Array([2])));
    expect(Array.from(s1)).not.toEqual(Array.from(s2));
  });

  it('ciphertext (decoded back from ECU-storage layout) is < modulus', () => {
    const hash = md5(new TextEncoder().encode('sig < n'));
    const sig = signHashedFirmware(hash);
    // Reverse encodeSignatureBytes to get the LE 64-byte ciphertext.
    const le = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      le[4 * i + 0] = sig[4 * i + 3]!;
      le[4 * i + 1] = sig[4 * i + 2]!;
      le[4 * i + 2] = sig[4 * i + 1]!;
      le[4 * i + 3] = sig[4 * i + 0]!;
    }
    const c = bytesLEToBigInt(le);
    expect(c).toBeLessThan(FIRMWARE_MODULUS);
    expect(c).toBeGreaterThan(0n);
  });

  it('sign matches manual m^d mod n on the LE-interpreted MD5', () => {
    // This locks the algorithm end-to-end against a hand-recomputed
    // reference — same operation, expressed differently, running the
    // same big-integer arithmetic.
    const hash = new Uint8Array(
      createHash('md5').update(new TextEncoder().encode('golden')).digest(),
    );
    const m = bytesLEToBigInt(hash);
    const c = modPow(m, FIRMWARE_PRIVATE_EXPONENT, FIRMWARE_MODULUS);
    const expectedLE = bigIntToBytesLE(c, 64);
    const expected = encodeSignatureBytes(expectedLE);
    expect(Array.from(signHashedFirmware(hash))).toEqual(Array.from(expected));
  });
});

// ── parameter-signature end-to-end ─────────────────────────────────

function makeTuneBlob(): Uint8Array {
  const blob = new Uint8Array(TUNE_BLOB_SIZE);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 13 + 5) & 0xff;
  return blob;
}

function plantParamSigHeader(
  blob: Uint8Array,
  segments: { hostStart: number; length: number }[],
): void {
  writeU32BE(blob, segments.length, PARAM_SIG_SEGMENT_COUNT_OFFSET);
  for (let i = 0; i < segments.length; i++) {
    writeU32BE(
      blob,
      PARAM_SIG_SEGMENT_BASE + segments[i]!.hostStart,
      PARAM_SIG_SEGMENT_STARTS_OFFSET + i * 8,
    );
    writeU32BE(
      blob,
      segments[i]!.length,
      PARAM_SIG_SEGMENT_LENGTHS_OFFSET + i * 4,
    );
  }
}

describe('parameter signature', () => {
  it('rewrite → verify round-trip', () => {
    const blob = makeTuneBlob();
    plantParamSigHeader(blob, [{ hostStart: 0x200, length: 0x100 }]);

    expect(verifyParameterSignature(blob).ok).toBe(false);
    rewriteParameterSignature(blob);
    const r = verifyParameterSignature(blob);
    expect(r.ok).toBe(true);
    expect(Array.from(r.stored)).toEqual(Array.from(r.computed));
    expect(r.stored.length).toBe(PARAM_SIG_LENGTH);
  });

  it('mutating a byte inside a signed segment invalidates the signature', () => {
    const blob = makeTuneBlob();
    plantParamSigHeader(blob, [{ hostStart: 0x1000, length: 0x200 }]);
    rewriteParameterSignature(blob);
    expect(verifyParameterSignature(blob).ok).toBe(true);

    blob[0x1080]! ^= 0xff;
    expect(verifyParameterSignature(blob).ok).toBe(false);
  });

  it('mutating a byte OUTSIDE any signed segment leaves the signature valid', () => {
    const blob = makeTuneBlob();
    plantParamSigHeader(blob, [{ hostStart: 0x1000, length: 0x200 }]);
    rewriteParameterSignature(blob);

    // 0x5000 is well outside 0x1000..0x11FF.
    blob[0x5000]! ^= 0xff;
    expect(verifyParameterSignature(blob).ok).toBe(true);
  });

  it('handles a multi-segment table', () => {
    const blob = makeTuneBlob();
    plantParamSigHeader(blob, [
      { hostStart: 0x400, length: 0x80 },
      { hostStart: 0x2000, length: 0x40 },
    ]);
    rewriteParameterSignature(blob);
    expect(verifyParameterSignature(blob).ok).toBe(true);
  });

  it('signature is written at the expected offset', () => {
    const blob = makeTuneBlob();
    plantParamSigHeader(blob, [{ hostStart: 0x300, length: 0x40 }]);
    rewriteParameterSignature(blob);
    const stored = blob.slice(PARAM_SIG_STORED_OFFSET, PARAM_SIG_STORED_OFFSET + PARAM_SIG_LENGTH);
    // Non-zero (with overwhelming probability, since it's an RSA output).
    expect(stored.some((b) => b !== 0)).toBe(true);
  });
});

// ── program-signature end-to-end ───────────────────────────────────

function makeExternal(): Uint8Array {
  const buf = new Uint8Array(EXTERNAL_FLASH_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 19 + 7) & 0xff;
  return buf;
}

function makeMpc(): Uint8Array {
  const buf = new Uint8Array(MPC_FLASH_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 23 + 3) & 0xff;
  return buf;
}

function plantProgSigHeader(
  external: Uint8Array,
  segments: { ecuStart: number; length: number }[],
): void {
  writeU32BE(external, segments.length, PROG_SIG_SEGMENT_COUNT_OFFSET);
  for (let i = 0; i < segments.length; i++) {
    writeU32BE(
      external,
      segments[i]!.ecuStart,
      PROG_SIG_SEGMENT_STARTS_OFFSET + i * 8,
    );
    writeU32BE(
      external,
      segments[i]!.length,
      PROG_SIG_SEGMENT_LENGTHS_OFFSET + i * 4,
    );
  }
}

describe('program signature', () => {
  it('rewrite → verify round-trip spanning MPC + external', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgSigHeader(external, [
      { ecuStart: 0x00001000, length: 0x100 }, // MPC
      { ecuStart: 0xfff80000, length: 0x200 }, // external
    ]);

    expect(verifyProgramSignature(external, mpc).ok).toBe(false);
    rewriteProgramSignature(external, mpc);
    const r = verifyProgramSignature(external, mpc);
    expect(r.ok).toBe(true);
    expect(r.stored.length).toBe(PROG_SIG_LENGTH);
  });

  it('mutating a byte in the MPC signed segment invalidates', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgSigHeader(external, [{ ecuStart: 0x00001000, length: 0x100 }]);
    rewriteProgramSignature(external, mpc);
    expect(verifyProgramSignature(external, mpc).ok).toBe(true);

    mpc[0x1010]! ^= 0xff;
    expect(verifyProgramSignature(external, mpc).ok).toBe(false);
  });

  it('mutating a byte in the external signed segment invalidates', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgSigHeader(external, [{ ecuStart: 0xfff80000, length: 0x200 }]);
    rewriteProgramSignature(external, mpc);
    expect(verifyProgramSignature(external, mpc).ok).toBe(true);

    external[0x80080]! ^= 0xff;
    expect(verifyProgramSignature(external, mpc).ok).toBe(false);
  });

  it('signature is stored at PROG_SIG_STORED_OFFSET', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgSigHeader(external, [{ ecuStart: 0x00001000, length: 0x100 }]);
    rewriteProgramSignature(external, mpc);
    const stored = external.slice(PROG_SIG_STORED_OFFSET, PROG_SIG_STORED_OFFSET + PROG_SIG_LENGTH);
    expect(stored.some((b) => b !== 0)).toBe(true);
  });
});
