import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseIntelHex, flattenIntelHex, IntelHexParseError } from './intel-hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundled = resolve(here, '..', 'bundled');

describe('parseIntelHex', () => {
  it('parses a minimal data + EOF stream', () => {
    const hex = [
      ':03000000010203F7',
      ':00000001FF',
    ].join('\n');
    const r = parseIntelHex(hex);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].address).toBe(0);
    expect([...r.blocks[0].data]).toEqual([0x01, 0x02, 0x03]);
    expect(r.totalBytes).toBe(3);
  });

  it('honours extended-linear-address records', () => {
    const hex = [
      ':020000040001F9',         // upper 16 bits = 0x0001
      ':020010000A0BD9',         // 2 bytes at offset 0x0010 → linear 0x00010010
      ':00000001FF',
    ].join('\n');
    const r = parseIntelHex(hex);
    expect(r.blocks[0].address).toBe(0x00010010);
  });

  it('honours extended-segment-address records', () => {
    const hex = [
      ':020000021000EC',         // segment = 0x1000 → adds 0x10000
      ':020020000A0BC9',         // 2 bytes at offset 0x0020 → linear 0x00010020
      ':00000001FF',
    ].join('\n');
    const r = parseIntelHex(hex);
    expect(r.blocks[0].address).toBe(0x00010020);
  });

  it('rejects a record with the wrong checksum', () => {
    const hex = ':03000000010203FF\n:00000001FF';
    expect(() => parseIntelHex(hex)).toThrow(IntelHexParseError);
  });

  it('rejects a record without EOF', () => {
    expect(() => parseIntelHex(':03000000010203F7\n')).toThrow(/missing EOF/);
  });

  it('rejects data after EOF', () => {
    const hex = ':00000001FF\n:03000000010203F7';
    expect(() => parseIntelHex(hex)).toThrow(/data after EOF/);
  });

  it('captures the start-linear entry point', () => {
    const hex = [
      ':04000005000000ABFB',     // EIP = 0x000000AB? wait checksum
      ':00000001FF',
    ].join('\n');
    // recompute: 04 + 00 + 00 + 05 + 00 + 00 + 00 + AB = 0xB4 → chk = 0x4C
    const ok = [
      ':0400000500000010E7',     // EIP = 0x00000010 → sum=04+00+00+05+00+00+00+10=0x19 → chk=E7
      ':00000001FF',
    ].join('\n');
    const r = parseIntelHex(ok);
    expect(r.entryPoint).toBe(0x10);
  });
});

describe('flattenIntelHex', () => {
  it('produces a contiguous buffer from sorted blocks', () => {
    // :02000000ABCD86 — sum = 02+00+00+00+AB+CD = 0x17A → chk = 0x86
    // :02000200EF12FB — sum = 02+00+02+00+EF+12 = 0x105 → chk = 0xFB
    const hex = [
      ':02000000ABCD86',
      ':02000200EF12FB',
      ':00000001FF',
    ].join('\n');
    const r = parseIntelHex(hex);
    const flat = flattenIntelHex(r);
    expect([...flat]).toEqual([0xab, 0xcd, 0xef, 0x12]);
  });

  it('fills gaps with 0xFF (erased flash convention)', () => {
    // :02000400EF12F9 — sum = 02+00+04+00+EF+12 = 0x107 → chk = 0xF9
    const hex = [
      ':02000000ABCD86',
      ':02000400EF12F9',
      ':00000001FF',
    ].join('\n');
    const r = parseIntelHex(hex);
    const flat = flattenIntelHex(r);
    expect([...flat]).toEqual([0xab, 0xcd, 0xff, 0xff, 0xef, 0x12]);
  });
});

describe('bundled MiniMon binaries', () => {
  it('parses LOADK.hex into exactly 32 bytes (matches C167 BSL primary-loader cap)', () => {
    const text = readFileSync(resolve(bundled, 'LOADK.hex'), 'utf8');
    const r = parseIntelHex(text);
    expect(r.totalBytes).toBe(32);
    const flat = flattenIntelHex(r);
    expect(flat.length).toBe(32);
  });

  it('parses MINIMONK.hex into a non-empty contiguous buffer', () => {
    const text = readFileSync(resolve(bundled, 'MINIMONK.hex'), 'utf8');
    const r = parseIntelHex(text);
    expect(r.totalBytes).toBeGreaterThan(0);
    expect(r.totalBytes).toBeLessThan(2048);
    const flat = flattenIntelHex(r);
    expect(flat.length).toBe(r.totalBytes);
  });

  it('parses A29F400B.hex into a non-empty contiguous buffer', () => {
    const text = readFileSync(resolve(bundled, 'A29F400B.hex'), 'utf8');
    const r = parseIntelHex(text);
    expect(r.totalBytes).toBeGreaterThan(0);
  });
});
