import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePaDa, paDaToRegions, parseHexRecord } from './pa-da.js';

const REAL_PA = join(homedir(), 'Downloads', 'E46_v74', 'data', 'GD20', '7544721A.0PA');
const skipReal = !existsSync(REAL_PA);

/** Build a valid Intel HEX record line with computed checksum. */
function hexRec(type: number, addr: number, data: readonly number[] = []): string {
  const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  const cs = (-sum) & 0xff;
  return ':' + [...bytes, cs].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

describe('parseHexRecord', () => {
  it('parses a standard data record + verifies checksum', () => {
    const r = parseHexRecord(hexRec(0x00, 0x1000, [0xde, 0xad, 0xbe, 0xef]), 1);
    expect('record' in r).toBe(true);
    if (!('record' in r)) return;
    expect(r.record.type).toBe(0x00);
    expect(r.record.localAddress).toBe(0x1000);
    expect([...r.record.data]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(r.record.checksumOk).toBe(true);
  });

  it('parses an EOF record (type 0x01)', () => {
    // The canonical Intel HEX EOF.
    const r = parseHexRecord(':00000001FF', 1);
    expect('record' in r).toBe(true);
    if (!('record' in r)) return;
    expect(r.record.type).toBe(0x01);
    expect(r.record.data.length).toBe(0);
    expect(r.record.checksumOk).toBe(true);
  });

  it('parses an extended-linear-address record (type 0x04)', () => {
    // From real GS20 footer.
    const r = parseHexRecord(':020000040008F2', 1);
    expect('record' in r).toBe(true);
    if (!('record' in r)) return;
    expect(r.record.type).toBe(0x04);
    expect(r.record.data.length).toBe(2);
    expect(r.record.data[0]).toBe(0x00);
    expect(r.record.data[1]).toBe(0x08);
    expect(r.record.checksumOk).toBe(true);
  });

  it('parses the BMW-specific type 0x10 marker', () => {
    // From real GS20 footer.
    const r = parseHexRecord(':00000010F0', 1);
    expect('record' in r).toBe(true);
    if (!('record' in r)) return;
    expect(r.record.type).toBe(0x10);
    expect(r.record.data.length).toBe(0);
    expect(r.record.checksumOk).toBe(true);
  });

  it('flags a checksum mismatch', () => {
    // EOF with wrong checksum (should be FF).
    const r = parseHexRecord(':00000001AA', 1);
    expect('record' in r).toBe(true);
    if (!('record' in r)) return;
    expect(r.record.checksumOk).toBe(false);
  });

  it('rejects non-hex chars', () => {
    const r = parseHexRecord(':02000004XYZZ', 1);
    expect('error' in r).toBe(true);
  });

  it('rejects byte-count mismatch', () => {
    // Claims 4 data bytes but only supplies 2 (plus checksum).
    const r = parseHexRecord(':0410000012345600', 1);
    expect('error' in r).toBe(true);
  });
});

describe('parsePaDa', () => {
  it('parses a synthetic file end-to-end', () => {
    const text = [
      ';==========================================',
      ';Austausch-Datei    Daten/Programm',
      ';==========================================',
      ';',
      ';;ZL_System:      GS20',
      ';;ZL_Projekt:     10_',
      ';;ZL_Referenz:    G2210_0089D0',
      ';;KK_Bearbeiter   Saiko Guenther',
      '',
      '$REFERENZ G2210_0089D0 Q',
      ':020000040000FA', // ext linear high = 0x0000
      ':02000002A0005C', // ext segment = 0xA000 (base = 0xA0000)
      hexRec(0x00, 0x0000, [0xde, 0xad, 0xbe, 0xef]),
      ':00000010F0',
      '$CHECKSUMME 7029 R',
      ';$CARB_MODE_9_CVN 0000B78D 9',
      ':00000001FF',
    ].join('\r\n');

    const result = parsePaDa(text);
    expect(result.skipped).toEqual([]);

    // Metadata
    expect(result.metadata.fields['ZL_System']).toBe('GS20');
    expect(result.metadata.fields['ZL_Referenz']).toBe('G2210_0089D0');
    expect(result.metadata.fields['KK_Bearbeiter']).toBe('Saiko Guenther');
    expect(result.metadata.referenz).toEqual({ ref: 'G2210_0089D0', flag: 'Q' });
    expect(result.metadata.checksum).toEqual({ value: '7029', flag: 'R' });
    expect(result.metadata.carbCvn).toEqual({ value: '0000B78D', num: '9' });

    // Records — in source order.
    const types = result.records.map((r) => r.type);
    expect(types).toEqual([0x04, 0x02, 0x00, 0x10, 0x01]);

    // The data record's absolute address must reflect segment+linear.
    const dataRecord = result.records.find((r) => r.type === 0x00);
    expect(dataRecord).toBeDefined();
    expect(dataRecord!.address).toBe(0xa0000);
    expect([...dataRecord!.data]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('handles whitespace-separated metadata', () => {
    const text = ';;KK_Abteilung      EA-70\r\n';
    const r = parsePaDa(text);
    expect(r.metadata.fields['KK_Abteilung']).toBe('EA-70');
  });

  it('reports unrecognized line prefixes in skipped', () => {
    const text = 'garbage line not starting with ; $ or :\r\n';
    const r = parsePaDa(text);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toBe('unrecognized line prefix');
  });

  it('accepts a Uint8Array input (BMW files are CRLF ASCII on disk)', () => {
    const text = ';;ZL_System: TEST\r\n:00000001FF\r\n';
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    const r = parsePaDa(bytes);
    expect(r.metadata.fields['ZL_System']).toBe('TEST');
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.type).toBe(0x01);
  });
});

describe('paDaToRegions', () => {
  it('merges adjacent records into a single region', () => {
    const text = [
      '$REFERENZ X Q',
      ':020000040000FA',
      ':02000002A0005C', // base 0xA0000
      hexRec(0x00, 0x0000, [0xde, 0xad, 0xbe, 0xef]), // 0xA0000..0xA0003
      hexRec(0x00, 0x0004, [0x11, 0x22, 0x33, 0x44]), // 0xA0004..0xA0007 — adjacent
      ':00000001FF',
    ].join('\n');
    const r = parsePaDa(text);
    expect(r.skipped).toEqual([]);
    const regions = paDaToRegions(r);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.startAddress).toBe(0xa0000);
    expect(regions[0]!.bytes.length).toBe(8);
    expect([...regions[0]!.bytes]).toEqual([0xde, 0xad, 0xbe, 0xef, 0x11, 0x22, 0x33, 0x44]);
  });

  it('splits non-adjacent records into separate regions', () => {
    const text = [
      '$REFERENZ X Q',
      ':020000040000FA',
      ':02000002A0005C',
      hexRec(0x00, 0x0000, [0xde, 0xad, 0xbe, 0xef]), // 0xA0000
      hexRec(0x00, 0x0100, [0xde, 0xad, 0xbe, 0xef]), // 0xA0100 — gap
      ':00000001FF',
    ].join('\n');
    const r = parsePaDa(text);
    expect(r.skipped).toEqual([]);
    const regions = paDaToRegions(r);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.startAddress).toBe(0xa0000);
    expect(regions[1]!.startAddress).toBe(0xa0100);
  });
});

describe.skipIf(skipReal)('parsePaDa — real bench-ECU firmware', () => {
  it('parses 7544721A.0PA without errors', () => {
    const bytes = readFileSync(REAL_PA);
    const result = parsePaDa(bytes);
    expect(result.skipped).toEqual([]);
    expect(result.metadata.fields['ZL_System']).toBe('GS20');
    expect(result.metadata.fields['ZL_Referenz']).toMatch(/^G2210_/);
    expect(result.metadata.referenz?.ref).toMatch(/^G2210_/);
    expect(result.metadata.checksum).toBeDefined();

    // Should have a healthy number of data records.
    const data = result.records.filter((r) => r.type === 0x00);
    expect(data.length).toBeGreaterThan(100);

    // Every checksum should validate — if this fails, BMW shipped a
    // file with a broken record, OR our checksum algorithm is wrong.
    const bad = result.records.filter((r) => !r.checksumOk);
    expect(bad).toEqual([]);

    // EOF record present.
    const eof = result.records.find((r) => r.type === 0x01);
    expect(eof).toBeDefined();
  });

  it('collapses 7544721A.0PA into contiguous regions', () => {
    const bytes = readFileSync(REAL_PA);
    const result = parsePaDa(bytes);
    const regions = paDaToRegions(result);
    expect(regions.length).toBeGreaterThan(0);
    const total = regions.reduce((n, r) => n + r.bytes.length, 0);
    // GS20 program is ~600KB on disk; even with packing overhead the
    // payload alone should be at least 100KB.
    expect(total).toBeGreaterThan(100_000);
  });
});
