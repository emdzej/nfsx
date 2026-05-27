import { describe, expect, it } from 'vitest';
import type { PaDaRecord } from '@emdzej/nfsx-flash-data';
import { buildPaDaRecordSource } from './firmware-source.js';

/**
 * Anchor cases for the BMW BinBuf frame layout the SGBD's pary opcode
 * expects. Layout traced via Ghidra in `docs/architecture.md §11.13`.
 */
describe('buildPaDaRecordSource', () => {
  function rec(type: number, address: number, data: number[]): PaDaRecord {
    return {
      type,
      localAddress: address & 0xffff,
      address,
      data: new Uint8Array(data),
      lineNumber: 1,
      checksumOk: true,
    };
  }

  it('emits one framed chunk per type-00 record', () => {
    const records: PaDaRecord[] = [
      rec(0x00, 0x0000_1234, [0xaa, 0xbb, 0xcc, 0xdd]),
    ];
    const src = buildPaDaRecordSource(records);
    const chunk = src.nextChunk(246);
    expect(chunk.eof).toBe(false);

    const b = chunk.bytes;
    // Total = data length (4) + 22 = 26 bytes
    expect(b.length).toBe(26);

    // 13-byte static header
    expect(b[0x00]).toBe(0x00); // EBX mode (default)
    expect(b[0x01]).toBe(0x01); // word-size from CDHSetDataOrg(1, 0, 0)
    expect(b[0x02]).toBe(0x00);
    expect(b[0x03]).toBe(0x00);
    for (let i = 0x04; i <= 0x0c; i++) expect(b[i]).toBe(0x00);

    // Length L = 4 at 0x0D..0x0E (uint16 LE)
    expect(b[0x0d]).toBe(0x04);
    expect(b[0x0e]).toBe(0x00);

    // Duplicate length at 0x0F..0x10
    expect(b[0x0f]).toBe(0x04);
    expect(b[0x10]).toBe(0x00);

    // Address 0x00001234 at 0x11..0x14 (uint32 LE)
    expect(b[0x11]).toBe(0x34);
    expect(b[0x12]).toBe(0x12);
    expect(b[0x13]).toBe(0x00);
    expect(b[0x14]).toBe(0x00);

    // Data at 0x15..0x18
    expect(b[0x15]).toBe(0xaa);
    expect(b[0x16]).toBe(0xbb);
    expect(b[0x17]).toBe(0xcc);
    expect(b[0x18]).toBe(0xdd);

    // Terminator at 0x19
    expect(b[0x19]).toBe(0x03);
  });

  it('skips non-data records (type-02 / type-04 / type-10) and signals eof', () => {
    const records: PaDaRecord[] = [
      rec(0x04, 0x0000_0000, []), // extended-linear (host-side, skipped)
      rec(0x02, 0x0000_0000, []), // extended-segment (skipped)
      rec(0x10, 0x0000_0000, []), // BMW $REFERENZ (skipped)
      rec(0x00, 0x0000_8000, [0x42]),
      rec(0x01, 0x0000_0000, []), // EOF marker (skipped)
    ];
    const src = buildPaDaRecordSource(records);

    const first = src.nextChunk(246);
    expect(first.eof).toBe(false);
    expect(first.bytes.length).toBe(1 + 22);
    expect(first.bytes[0x11]).toBe(0x00);
    expect(first.bytes[0x12]).toBe(0x80); // 0x0000_8000 LE → 00 80 00 00
    expect(first.bytes[0x15]).toBe(0x42);

    const eof = src.nextChunk(246);
    expect(eof.eof).toBe(true);
    expect(eof.bytes.length).toBe(0);

    // Subsequent calls stay at EOF.
    const eof2 = src.nextChunk(246);
    expect(eof2.eof).toBe(true);
  });

  it('honors absolute address across multiple records', () => {
    const records: PaDaRecord[] = [
      rec(0x00, 0x000a_0000, [0x01]),
      rec(0x00, 0x00ff_ffff, [0x02]),
    ];
    const src = buildPaDaRecordSource(records);

    const a = src.nextChunk(246).bytes;
    expect(a[0x11]).toBe(0x00);
    expect(a[0x12]).toBe(0x00);
    expect(a[0x13]).toBe(0x0a);
    expect(a[0x14]).toBe(0x00);

    const b = src.nextChunk(246).bytes;
    expect(b[0x11]).toBe(0xff);
    expect(b[0x12]).toBe(0xff);
    expect(b[0x13]).toBe(0xff);
    expect(b[0x14]).toBe(0x00);
  });

  it('honors the mode override (EBX byte 0)', () => {
    const src = buildPaDaRecordSource([rec(0x00, 0, [0x00])], { mode: 0x01 });
    const chunk = src.nextChunk(246);
    expect(chunk.bytes[0x00]).toBe(0x01);
  });

  it('throws when a record exceeds maxBytes', () => {
    const data = new Array(256).fill(0xab);
    const src = buildPaDaRecordSource([rec(0x00, 0, data)]);
    expect(() => src.nextChunk(64)).toThrow(/needs 278 bytes but IPO offered only 64/);
  });

  it('zero-length type-00 records are filtered (data records only matter when they carry data)', () => {
    const src = buildPaDaRecordSource([rec(0x00, 0, [])]);
    const chunk = src.nextChunk(246);
    expect(chunk.eof).toBe(true);
    expect(chunk.bytes.length).toBe(0);
  });
});
