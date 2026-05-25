import { describe, expect, it } from 'vitest';
import { parseLine, parseS37, computeChecksum, dataRecords, startRecord } from './s37.js';

/**
 * Helper — build a syntactically correct S-record line. Lets tests
 * focus on parser behaviour without me hand-computing checksums.
 */
function buildLine(type: number, address: number, data: Uint8Array): string {
  const addressBytes = type === 0 || type === 1 || type === 5 || type === 9 ? 2 : type === 2 || type === 6 || type === 8 ? 3 : 4;
  const count = addressBytes + data.length + 1; // +1 for checksum byte
  const cs = computeChecksum(count, address, addressBytes, data);
  const addrHex = address.toString(16).padStart(addressBytes * 2, '0').toUpperCase();
  const dataHex = [...data].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const csHex = cs.toString(16).padStart(2, '0').toUpperCase();
  const countHex = count.toString(16).padStart(2, '0').toUpperCase();
  return `S${type}${countHex}${addrHex}${dataHex}${csHex}`;
}

describe('s37 — record parser', () => {
  describe('parseLine', () => {
    it('parses an S0 header record', () => {
      const line = buildLine(0, 0, new Uint8Array(0));
      const rec = parseLine(line, 1);
      expect(rec.type).toBe(0);
      expect(rec.address).toBe(0);
      expect(rec.data.length).toBe(0);
      expect(rec.checksumOk).toBe(true);
    });

    it('parses an S1 data record (16-bit address)', () => {
      const data = new Uint8Array([0x0a, 0x0a, 0x0d, 0x0a, 0x68, 0x69, 0x21]);
      const line = buildLine(1, 0x7af0, data);
      const rec = parseLine(line, 1);
      expect(rec.type).toBe(1);
      expect(rec.address).toBe(0x7af0);
      expect([...rec.data]).toEqual([...data]);
      expect(rec.checksumOk).toBe(true);
    });

    it('parses an S3 data record (32-bit address, the BMW common case)', () => {
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const line = buildLine(3, 0, data);
      const rec = parseLine(line, 1);
      expect(rec.type).toBe(3);
      expect(rec.address).toBe(0);
      expect([...rec.data]).toEqual([0xde, 0xad, 0xbe, 0xef]);
      expect(rec.checksumOk).toBe(true);
    });

    it('parses an S7 terminator record (32-bit start address)', () => {
      const line = buildLine(7, 0x12345678, new Uint8Array(0));
      const rec = parseLine(line, 1);
      expect(rec.type).toBe(7);
      expect(rec.address).toBe(0x12345678);
      expect(rec.data.length).toBe(0);
      expect(rec.checksumOk).toBe(true);
    });

    it('detects a bad checksum', () => {
      const good = buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      // Replace the last 2 chars (checksum) with a known-wrong value.
      const bad = good.slice(0, -2) + 'FF';
      const rec = parseLine(bad, 1);
      // If FF happens to equal the real checksum, this test would be
      // useless — but for this input it doesn't, so we're fine.
      expect(rec.checksumOk).toBe(false);
    });

    it('throws on a line that is too short', () => {
      expect(() => parseLine('S0', 1)).toThrow(/too short/);
    });

    it('throws on a missing S prefix', () => {
      expect(() => parseLine('X0030000FC', 1)).toThrow(/missing S/);
    });

    it('throws on an unsupported S-record type (S4 reserved)', () => {
      expect(() => parseLine('S4030000FC', 1)).toThrow(/unsupported.*S4/);
    });

    it('throws on truncated body (count says more than line provides)', () => {
      expect(() => parseLine('S30A00000000DE', 1)).toThrow(/truncated/);
    });
  });

  describe('computeChecksum — known check vectors', () => {
    it('returns the one\'s-complement of LSB(count + address bytes + data)', () => {
      // count=9, addr=0 (4 bytes), data=DE AD BE EF
      //   sum = 9 + 0 + 0 + 0 + 0 + 0xDE + 0xAD + 0xBE + 0xEF
      //       = 833 = 0x341, lsb=0x41, ~=0xBE
      const cs = computeChecksum(9, 0, 4, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
      expect(cs).toBe(0xbe);
    });

    it('count=3, addr=0 (2 bytes), no data → sum=3 → ~3 = 0xFC', () => {
      // Classic empty S0 record.
      const cs = computeChecksum(3, 0, 2, new Uint8Array(0));
      expect(cs).toBe(0xfc);
    });
  });

  describe('parseS37', () => {
    it('parses a multi-line file', () => {
      const file = [
        buildLine(0, 0, new Uint8Array(0)),
        buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
        buildLine(3, 4, new Uint8Array([0xca, 0xfe, 0xba, 0xbe])),
        buildLine(7, 0x12345678, new Uint8Array(0)),
      ].join('\n');
      const result = parseS37(file);
      expect(result.records).toHaveLength(4);
      expect(result.records[0]!.type).toBe(0);
      expect(result.records[1]!.type).toBe(3);
      expect(result.records[2]!.type).toBe(3);
      expect(result.records[3]!.type).toBe(7);
      expect(result.skipped).toHaveLength(0);
      // All checksums valid.
      expect(result.records.every((r) => r.checksumOk)).toBe(true);
    });

    it('skips empty lines + non-S lines without failing the parse', () => {
      const file = [
        '; vendor comment',
        buildLine(0, 0, new Uint8Array(0)),
        '# another comment',
        '',
        buildLine(7, 0x12345678, new Uint8Array(0)),
      ].join('\n');
      const result = parseS37(file);
      expect(result.records).toHaveLength(2);
      expect(result.skipped).toHaveLength(2);
      expect(result.skipped[0]!.reason).toMatch(/no S prefix/);
    });

    it('accepts Uint8Array input (ASCII bytes)', () => {
      const text = [
        buildLine(0, 0, new Uint8Array(0)),
        buildLine(7, 0x12345678, new Uint8Array(0)),
      ].join('\n');
      const bytes = new TextEncoder().encode(text);
      const result = parseS37(bytes);
      expect(result.records).toHaveLength(2);
    });
  });

  describe('dataRecords / startRecord', () => {
    it('filters to S1/S2/S3 only', () => {
      const file = [
        buildLine(0, 0, new Uint8Array(0)),
        buildLine(3, 0, new Uint8Array([0xde, 0xad])),
        buildLine(7, 0x12345678, new Uint8Array(0)),
      ].join('\n');
      const { records } = parseS37(file);
      expect(dataRecords(records)).toHaveLength(1);
      expect(dataRecords(records)[0]!.type).toBe(3);
    });

    it('finds the terminator', () => {
      const file = [
        buildLine(0, 0, new Uint8Array(0)),
        buildLine(7, 0x12345678, new Uint8Array(0)),
      ].join('\n');
      const { records } = parseS37(file);
      expect(startRecord(records)?.type).toBe(7);
      expect(startRecord(records)?.address).toBe(0x12345678);
    });
  });
});
