import { describe, expect, it } from 'vitest';
import { crc32, crc32Regions, verifyChecksums } from './integrity.js';
import { computeChecksum, parseS37 } from './s37.js';

function buildLine(type: number, address: number, data: Uint8Array): string {
  const addressBytes = type === 0 || type === 1 || type === 5 || type === 9 ? 2 : type === 2 || type === 6 || type === 8 ? 3 : 4;
  const count = addressBytes + data.length + 1;
  const cs = computeChecksum(count, address, addressBytes, data);
  const addrHex = address.toString(16).padStart(addressBytes * 2, '0').toUpperCase();
  const dataHex = [...data].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const csHex = cs.toString(16).padStart(2, '0').toUpperCase();
  const countHex = count.toString(16).padStart(2, '0').toUpperCase();
  return `S${type}${countHex}${addrHex}${dataHex}${csHex}`;
}

describe('integrity — verifyChecksums', () => {
  it('reports ok when every record matches', () => {
    const file = [
      buildLine(0, 0, new Uint8Array(0)),
      buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    ].join('\n');
    const { records } = parseS37(file);
    const result = verifyChecksums(records);
    expect(result.ok).toBe(true);
    expect(result.bad).toEqual([]);
  });

  it('flags records with bad checksums', () => {
    const good = buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    // Tamper the checksum (last 2 chars) to a known wrong value.
    const tampered = good.slice(0, -2) + 'FF';
    const file = [buildLine(0, 0, new Uint8Array(0)), tampered].join('\n');
    const { records } = parseS37(file);
    const result = verifyChecksums(records);
    expect(result.ok).toBe(false);
    expect(result.bad).toHaveLength(1);
    expect(result.bad[0]!.type).toBe(3);
  });
});

describe('integrity — crc32', () => {
  // Canonical CRC-32/ISO-HDLC check vectors.

  it('returns 0 for an empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches the canonical "123456789" check vector', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('matches the canonical "a" check vector', () => {
    const bytes = new TextEncoder().encode('a');
    expect(crc32(bytes)).toBe(0xe8b7be43);
  });

  it('crc32Regions matches crc32 of the concatenation', () => {
    const a = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35]);
    const b = new Uint8Array([0x36, 0x37, 0x38, 0x39]);
    const concat = new Uint8Array([...a, ...b]);
    expect(crc32Regions([{ bytes: a }, { bytes: b }])).toBe(crc32(concat));
  });
});
