import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  buildSeedRequestPayload,
  buildKeySubmitPayload,
  deriveKey,
  SEED_RESP_LEN_AUTHORISED,
  SEED_RESP_LEN_FULL,
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

  it('builds the key-submit payload: 0x90 + 4 key bytes (same opcode as seed req)', () => {
    const key = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    expect([...buildKeySubmitPayload(key)]).toEqual([0x90, 0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('derives a 4-byte key from a full received frame', () => {
    // Frame layout: [ADDR][LEN][STATUS][seed bytes][XOR]
    // For a real MS42 seed response, LEN = 46 (0x2E).
    const frame = Buffer.alloc(46, 0);
    frame[0] = 0x12; // ADDR
    frame[1] = 46; // LEN — also the wrap modulus
    frame[2] = 0xa0; // STATUS
    // For nonce=5: (5+i) % 46 = 5, 6, 7, 8 → frame[5..8]
    frame[5] = 0x10;
    frame[6] = 0x20;
    frame[7] = 0x30;
    frame[8] = 0x40;
    // frame[18..21] = key-derivation entropy block A
    frame[18] = 0x01;
    frame[19] = 0x02;
    frame[20] = 0x03;
    frame[21] = 0x04;
    // frame[41..44] = key-derivation entropy block B
    frame[41] = 0x05;
    frame[42] = 0x06;
    frame[43] = 0x07;
    frame[44] = 0x08;

    const key = deriveKey(frame, 5);
    expect([...key]).toEqual([
      (0x10 + 0x01 + 0x05) & 0xff, // 0x16
      (0x20 + 0x02 + 0x06) & 0xff, // 0x28
      (0x30 + 0x03 + 0x07) & 0xff, // 0x3a
      (0x40 + 0x04 + 0x08) & 0xff, // 0x4c
    ]);
  });

  it('wraps the nonce index modulo frame[1] (LEN)', () => {
    const frame = Buffer.alloc(48, 0);
    frame[1] = 8; // synthetic short modulus to make wrap-around easy
    frame[0] = 0xff; // (7+1) mod 8 = 0 → frame[0]
    frame[7] = 0xaa; // (7+0) mod 8 = 7 → frame[7]
    const key = deriveKey(frame, 7);
    expect(key[0]).toBe(0xaa);
    expect(key[1]).toBe(0xff);
  });

  it('throws when frame is too short to index frame[41..44]', () => {
    expect(() => deriveKey(Buffer.alloc(40), 5)).toThrow(SeedKeyError);
  });

  it('throws when frame[1] (modulus / LEN) is 0', () => {
    const frame = Buffer.alloc(48, 0);
    frame[1] = 0;
    expect(() => deriveKey(frame, 5)).toThrow(/modulus|LEN/);
  });

  it('exposes the two recognised seed-response LEN values', () => {
    expect(SEED_RESP_LEN_AUTHORISED).toBe(5);
    expect(SEED_RESP_LEN_FULL).toBe(46);
  });
});
