import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  buildSeedRequestPayload,
  buildKeySubmitPayload,
  deriveKey,
  SeedKeyError,
} from './seed-key.js';

describe('SEED/KEY', () => {
  it('builds the seed request: 0x90 "BMW" <nonce>', () => {
    const out = buildSeedRequestPayload(7);
    expect([...out]).toEqual([0x90, 0x42, 0x4d, 0x57, 0x07]);
  });

  it('rejects nonce outside 1..23', () => {
    expect(() => buildSeedRequestPayload(0)).toThrow(SeedKeyError);
    expect(() => buildSeedRequestPayload(24)).toThrow(SeedKeyError);
    expect(() => buildSeedRequestPayload(1.5)).toThrow(SeedKeyError);
  });

  it('builds the key-submit payload: 0x91 + 4 key bytes', () => {
    const key = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    expect([...buildKeySubmitPayload(key)]).toEqual([0x91, 0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('derives a 4-byte key from seed + nonce', () => {
    // Synthetic seed with known bytes to make the math easy to verify.
    const seed = Buffer.alloc(64, 0);
    seed[1] = 16; // modulus
    // For nonce=5 and i=0..3, (nonce+i) % 16 = 5, 6, 7, 8 → seed[5..8]
    seed[5] = 0x10;
    seed[6] = 0x20;
    seed[7] = 0x30;
    seed[8] = 0x40;
    // seed[18..21] = key-derivation table A
    seed[18] = 0x01;
    seed[19] = 0x02;
    seed[20] = 0x03;
    seed[21] = 0x04;
    // seed[41..44] = key-derivation table B
    seed[41] = 0x05;
    seed[42] = 0x06;
    seed[43] = 0x07;
    seed[44] = 0x08;

    const key = deriveKey(seed, 5);
    expect([...key]).toEqual([
      (0x10 + 0x01 + 0x05) & 0xff, // 0x16
      (0x20 + 0x02 + 0x06) & 0xff, // 0x28
      (0x30 + 0x03 + 0x07) & 0xff, // 0x3a
      (0x40 + 0x04 + 0x08) & 0xff, // 0x4c
    ]);
  });

  it('wraps the nonce index modulo seed[1]', () => {
    const seed = Buffer.alloc(64, 0);
    seed[1] = 8;
    seed[0] = 0xff;
    // nonce=7, i=1 → (7+1) % 8 = 0 → seed[0] = 0xff
    seed[7] = 0xaa;
    seed[18] = seed[19] = seed[20] = seed[21] = 0;
    seed[41] = seed[42] = seed[43] = seed[44] = 0;
    const key = deriveKey(seed, 7);
    expect(key[0]).toBe(0xaa); // (7+0) % 8 = 7 → seed[7]
    expect(key[1]).toBe(0xff); // (7+1) % 8 = 0 → seed[0]
  });

  it('throws when seed buffer is too short', () => {
    expect(() => deriveKey(Buffer.alloc(40), 5)).toThrow(SeedKeyError);
  });

  it('throws when seed[1] is zero', () => {
    const seed = Buffer.alloc(64, 0);
    seed[1] = 0;
    expect(() => deriveKey(seed, 5)).toThrow(/modulus/);
  });
});
