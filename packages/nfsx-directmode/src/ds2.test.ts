import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  Ds2FrameError,
  DS2_CMD_IDENT,
  DS2_CMD_MEMORY_READ,
} from './ds2.js';

describe('DS2 framing', () => {
  it('encodes IDENT request as [ADDR=0x12][LEN=0x04][CMD=0x00][XOR=0x16]', () => {
    const out = encodeFrame(0x12, new Uint8Array([DS2_CMD_IDENT]));
    expect([...out]).toEqual([0x12, 0x04, 0x00, 0x16]);
  });

  it('LEN counts the entire frame including ADDR', () => {
    const out = encodeFrame(0x32, new Uint8Array([0x07, 0x06, 0xa0, 0x00, 0x00, 0x00]));
    expect(out.length).toBe(9);
    expect(out[1]).toBe(9);
  });

  it('XOR includes ADDR', () => {
    const out = encodeFrame(0x12, new Uint8Array([0x00]));
    expect(out[out.length - 1]).toBe(0x12 ^ 0x04 ^ 0x00);
  });

  it('round-trips an arbitrary payload', () => {
    const original = new Uint8Array([0x07, 0x02, 0x12, 0x34, 0x56, 0xaa, 0xbb]);
    const wire = encodeFrame(0x32, original);
    const { frame, consumed } = decodeFrame(wire);
    expect(consumed).toBe(wire.length);
    expect(frame.addr).toBe(0x32);
    expect([...frame.data]).toEqual([...original]);
  });

  it('memory-read request round-trips', () => {
    const payload = new Uint8Array([DS2_CMD_MEMORY_READ, 0x12, 0x34, 0x56, 0x10]);
    const wire = encodeFrame(0x12, payload);
    const { frame } = decodeFrame(wire);
    expect([...frame.data]).toEqual([...payload]);
  });

  it('throws on XOR mismatch', () => {
    const wire = encodeFrame(0x12, new Uint8Array([0x00]));
    wire[wire.length - 1] ^= 0x01;
    expect(() => decodeFrame(wire)).toThrow(Ds2FrameError);
    expect(() => decodeFrame(wire)).toThrow(/XOR mismatch/);
  });

  it('throws when payload would overflow LEN field', () => {
    const huge = new Uint8Array(254);
    expect(() => encodeFrame(0x12, huge)).toThrow(/exceeds 0xFF/);
  });

  it('throws when truncated', () => {
    expect(() => decodeFrame(new Uint8Array([0x12, 0x04]))).toThrow(Ds2FrameError);
  });

  it('XOR includes ADDR (so different ADDRs produce different XORs)', () => {
    const payload = new Uint8Array([0x07, 0x06, 0x10, 0x00, 0x00, 0x00]);
    const a = encodeFrame(0x12, payload);
    const b = encodeFrame(0x32, payload);
    expect(a[a.length - 1]).not.toBe(b[b.length - 1]);
    expect(a[a.length - 1] ^ b[b.length - 1]).toBe(0x12 ^ 0x32);
  });
});
