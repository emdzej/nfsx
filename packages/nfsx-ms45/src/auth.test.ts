import { describe, it, expect } from 'vitest';
import {
  buildAuthenticationStartArg,
  formatSeedRequestArg,
  extractSerialNumber,
  AUTH_MESSAGE_HEADER,
  AUTH_MESSAGE_TRAILER,
  AUTH_MESSAGE_LENGTH,
  AUTH_MODULUS,
  AUTH_PRIVATE_EXPONENT,
} from './auth.js';
import { modPow, bytesLEToBigInt, md5 } from './signature.js';

describe('formatSeedRequestArg', () => {
  it('formats BE userID bytes as a big-endian hex string', () => {
    expect(formatSeedRequestArg(new Uint8Array([0x12, 0x34, 0x56, 0x78]))).toBe('3;0x12345678');
  });

  it('strips leading zeros in the hex representation', () => {
    expect(formatSeedRequestArg(new Uint8Array([0x00, 0x00, 0x00, 0x01]))).toBe('3;0x1');
  });

  it('rejects non-4-byte userIDs', () => {
    expect(() => formatSeedRequestArg(new Uint8Array(3))).toThrow(/4 bytes/);
    expect(() => formatSeedRequestArg(new Uint8Array(5))).toThrow(/4 bytes/);
  });
});

describe('extractSerialNumber', () => {
  it('takes the 4 bytes preceding the terminator', () => {
    // Fake reply: prefix bytes + serial + terminator
    const tel = new Uint8Array([0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03, 0x04, 0xff]);
    expect(Array.from(extractSerialNumber(tel))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('rejects short buffers', () => {
    expect(() => extractSerialNumber(new Uint8Array(4))).toThrow(/at least 5/);
  });
});

// ── message assembly ───────────────────────────────────────────────

describe('buildAuthenticationStartArg', () => {
  const userID = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  const serialNumber = new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4]);
  const seed = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);

  it('produces exactly AUTH_MESSAGE_LENGTH bytes', () => {
    const msg = buildAuthenticationStartArg({ userID, serialNumber, seed });
    expect(msg.length).toBe(AUTH_MESSAGE_LENGTH);
    expect(AUTH_MESSAGE_LENGTH).toBe(90);
  });

  it('starts with the EDIABAS header prologue', () => {
    const msg = buildAuthenticationStartArg({ userID, serialNumber, seed });
    expect(Array.from(msg.subarray(0, AUTH_MESSAGE_HEADER.length))).toEqual(
      Array.from(AUTH_MESSAGE_HEADER),
    );
  });

  it('ends with the trailer byte', () => {
    const msg = buildAuthenticationStartArg({ userID, serialNumber, seed });
    expect(msg[msg.length - 1]).toBe(AUTH_MESSAGE_TRAILER);
  });

  it('is deterministic — same input, same output', () => {
    const a = buildAuthenticationStartArg({ userID, serialNumber, seed });
    const b = buildAuthenticationStartArg({ userID, serialNumber, seed });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different seeds produce different ciphers', () => {
    const a = buildAuthenticationStartArg({ userID, serialNumber, seed });
    const b = buildAuthenticationStartArg({
      userID,
      serialNumber,
      seed: new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]),
    });
    // Header + trailer identical; the 64-byte cipher in the middle
    // must differ.
    const startOfCipher = AUTH_MESSAGE_HEADER.length;
    const cipherA = a.subarray(startOfCipher, startOfCipher + 64);
    const cipherB = b.subarray(startOfCipher, startOfCipher + 64);
    expect(Array.from(cipherA)).not.toEqual(Array.from(cipherB));
  });

  it('cipher (decoded back to LE) is a valid RSA output: 0 < c < n', () => {
    const msg = buildAuthenticationStartArg({ userID, serialNumber, seed });
    const cipherBE = msg.subarray(AUTH_MESSAGE_HEADER.length, AUTH_MESSAGE_HEADER.length + 64);
    // Reverse the encodeSignatureBytes per-word byte swap.
    const le = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      le[4 * i + 0] = cipherBE[4 * i + 3]!;
      le[4 * i + 1] = cipherBE[4 * i + 2]!;
      le[4 * i + 2] = cipherBE[4 * i + 1]!;
      le[4 * i + 3] = cipherBE[4 * i + 0]!;
    }
    const c = bytesLEToBigInt(le);
    expect(c).toBeGreaterThan(0n);
    expect(c).toBeLessThan(AUTH_MODULUS);
  });

  it('cipher matches manual m = MD5(userID||serial||seed) then c = m^d mod n', () => {
    const msg = buildAuthenticationStartArg({ userID, serialNumber, seed });

    const toHash = new Uint8Array(4 + 4 + seed.length);
    toHash.set(userID, 0);
    toHash.set(serialNumber, 4);
    toHash.set(seed, 8);
    const hash = md5(toHash);
    const m = bytesLEToBigInt(hash);
    const cRef = modPow(m, AUTH_PRIVATE_EXPONENT, AUTH_MODULUS);

    // Decode the message's cipher back to a BigInt via the LE layout.
    const cipherBE = msg.subarray(AUTH_MESSAGE_HEADER.length, AUTH_MESSAGE_HEADER.length + 64);
    const le = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      le[4 * i + 0] = cipherBE[4 * i + 3]!;
      le[4 * i + 1] = cipherBE[4 * i + 2]!;
      le[4 * i + 2] = cipherBE[4 * i + 1]!;
      le[4 * i + 3] = cipherBE[4 * i + 0]!;
    }
    expect(bytesLEToBigInt(le)).toBe(cRef);
  });

  it('rejects non-4-byte userID / serialNumber', () => {
    expect(() =>
      buildAuthenticationStartArg({
        userID: new Uint8Array(3),
        serialNumber,
        seed,
      }),
    ).toThrow(/userID/);
    expect(() =>
      buildAuthenticationStartArg({
        userID,
        serialNumber: new Uint8Array(5),
        seed,
      }),
    ).toThrow(/serialNumber/);
  });
});
