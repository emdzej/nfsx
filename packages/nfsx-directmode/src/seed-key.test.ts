import { describe, it, expect } from 'vitest';
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
    const key = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    expect([...buildKeySubmitPayload(key)]).toEqual([0x90, 0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('derives a 4-byte key from a full received frame', () => {
    const frame = new Uint8Array(46);
    frame[0] = 0x12;
    frame[1] = 46;
    frame[2] = 0xa0;
    frame[5] = 0x10;
    frame[6] = 0x20;
    frame[7] = 0x30;
    frame[8] = 0x40;
    frame[18] = 0x01;
    frame[19] = 0x02;
    frame[20] = 0x03;
    frame[21] = 0x04;
    frame[41] = 0x05;
    frame[42] = 0x06;
    frame[43] = 0x07;
    frame[44] = 0x08;

    const key = deriveKey(frame, 5);
    expect([...key]).toEqual([
      (0x10 + 0x01 + 0x05) & 0xff,
      (0x20 + 0x02 + 0x06) & 0xff,
      (0x30 + 0x03 + 0x07) & 0xff,
      (0x40 + 0x04 + 0x08) & 0xff,
    ]);
  });

  it('wraps the nonce index modulo frame[1] (LEN)', () => {
    const frame = new Uint8Array(48);
    frame[1] = 8;
    frame[0] = 0xff;
    frame[7] = 0xaa;
    const key = deriveKey(frame, 7);
    expect(key[0]).toBe(0xaa);
    expect(key[1]).toBe(0xff);
  });

  it('throws when frame is too short to index frame[41..44]', () => {
    expect(() => deriveKey(new Uint8Array(40), 5)).toThrow(SeedKeyError);
  });

  it('throws when frame[1] (modulus / LEN) is 0', () => {
    const frame = new Uint8Array(48);
    frame[1] = 0;
    expect(() => deriveKey(frame, 5)).toThrow(/modulus|LEN/);
  });

  it('exposes the two recognised seed-response LEN values', () => {
    expect(SEED_RESP_LEN_AUTHORISED).toBe(5);
    expect(SEED_RESP_LEN_FULL).toBe(46);
  });
});
