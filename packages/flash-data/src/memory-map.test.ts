import { describe, expect, it } from 'vitest';
import { buildMemoryMap, chunkRegion } from './memory-map.js';
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

function recordsFromLines(...lines: string[]) {
  return parseS37(lines.join('\n')).records;
}

describe('memory-map — buildMemoryMap', () => {
  it('coalesces adjacent records into a single region', () => {
    const records = recordsFromLines(
      buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
      buildLine(3, 4, new Uint8Array([0xca, 0xfe, 0xba, 0xbe])),
    );
    const result = buildMemoryMap(records);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]!.startAddress).toBe(0);
    expect(result.regions[0]!.bytes.length).toBe(8);
    expect([...result.regions[0]!.bytes]).toEqual([
      0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
    ]);
    expect(result.totalBytes).toBe(8);
    expect(result.recordCount).toBe(2);
    expect(result.overlaps).toHaveLength(0);
  });

  it('keeps gapped records as separate regions', () => {
    const records = recordsFromLines(
      buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
      buildLine(3, 0x100, new Uint8Array([0xca, 0xfe, 0xba, 0xbe])),
    );
    const result = buildMemoryMap(records);
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0]!.startAddress).toBe(0);
    expect(result.regions[0]!.bytes.length).toBe(4);
    expect(result.regions[1]!.startAddress).toBe(0x100);
    expect(result.regions[1]!.bytes.length).toBe(4);
  });

  it('detects overlapping records', () => {
    const records = recordsFromLines(
      buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
      buildLine(3, 2, new Uint8Array([0xca, 0xfe, 0xba, 0xbe])),
    );
    const result = buildMemoryMap(records);
    expect(result.overlaps.length).toBeGreaterThan(0);
    expect(result.overlaps[0]!.range).toEqual([2, 4]);
  });

  it('returns empty result for input with no data records', () => {
    const records = recordsFromLines(
      buildLine(0, 0, new Uint8Array(0)),
      buildLine(7, 0x12345678, new Uint8Array(0)),
    );
    const result = buildMemoryMap(records);
    expect(result.regions).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
  });

  it('sorts unsorted input by address before coalescing', () => {
    // Adjacent regions but supplied in reverse order — coalescer
    // should sort and produce a single coalesced region.
    const records = recordsFromLines(
      buildLine(3, 4, new Uint8Array([0xca, 0xfe, 0xba, 0xbe])),
      buildLine(3, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    );
    const result = buildMemoryMap(records);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]!.startAddress).toBe(0);
    expect([...result.regions[0]!.bytes]).toEqual([
      0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
    ]);
  });
});

describe('memory-map — chunkRegion', () => {
  it('splits a region into chunks of at most blockSize', () => {
    const region = { startAddress: 0x1000, bytes: new Uint8Array(10).map((_, i) => i) };
    const chunks = chunkRegion(region, 4);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.startAddress).toBe(0x1000);
    expect(chunks[0]!.bytes.length).toBe(4);
    expect(chunks[1]!.startAddress).toBe(0x1004);
    expect(chunks[1]!.bytes.length).toBe(4);
    expect(chunks[2]!.startAddress).toBe(0x1008);
    expect(chunks[2]!.bytes.length).toBe(2);
  });

  it('returns the region as-is when it fits in one chunk', () => {
    const region = { startAddress: 0, bytes: new Uint8Array([1, 2, 3]) };
    const chunks = chunkRegion(region, 16);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(region);
  });

  it('rejects blockSize <= 0', () => {
    const region = { startAddress: 0, bytes: new Uint8Array([1]) };
    expect(() => chunkRegion(region, 0)).toThrow(/blockSize/);
  });
});
