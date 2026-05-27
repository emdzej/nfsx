import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseZbNrTab, findByHwNr, findByZbNr } from './zb-nr-tab.js';

const REAL_GD20_DAT = join(homedir(), 'Downloads', 'E46_v74', 'data', 'GD20', 'GD20.DAT');
const skipReal = !existsSync(REAL_GD20_DAT);

describe('parseZbNrTab', () => {
  it('parses directives + comments + a single row', () => {
    const text = [
      '$ PS10INIT N00326DFF00003CF004598403C8500000000000 5',
      '$ VERSIONKFCONF: kfconf10.dat',
      ';Zusbauvorschrift vom 21.06.2006 10:33',
      ';SG-TYP: GD20',
      ';ZB-NR  TYP-NR  HW-NR  IX SW-NR     AM          PIN S CS',
      '7514050,0000000,7508145,A,7514051DA,0FFFFFFFFFD,134,1 1',
    ].join('\n');

    const t = parseZbNrTab(text);
    expect(t.directives['PS10INIT']).toBe('N00326DFF00003CF004598403C8500000000000 5');
    expect(t.directives['VERSIONKFCONF']).toBe('kfconf10.dat');
    expect(t.comments).toContain('SG-TYP: GD20');
    expect(t.rows).toHaveLength(1);

    const row = t.rows[0]!;
    expect(row.zbNr).toBe('7514050');
    expect(row.typNr).toBe('0000000');
    expect(row.hwNr).toBe('7508145');
    expect(row.ix).toBe('A');
    expect(row.swNr).toBe('7514051DA');
    expect(row.am).toBe('0FFFFFFFFFD');
    expect(row.pin).toBe(134);
    expect(row.s).toBe(1);
    expect(row.cs).toBe(1);
    expect(row.programFile).toBe('7508145A.0PA');
    expect(row.dataFile).toBe('A7514051.0DA');
  });

  it('handles alpha CS codes via base-36', () => {
    const text = '7514052,0000000,7508145,A,7514053DA,0FFFFFFFFFD,134,1 D';
    const t = parseZbNrTab(text);
    expect(t.rows[0]!.cs).toBe(13); // 'D' in base 36
  });

  it('records skipped rows on malformed input', () => {
    const text = 'not,enough,fields';
    const t = parseZbNrTab(text);
    expect(t.skipped).toHaveLength(1);
    expect(t.skipped[0]!.reason).toMatch(/8 comma-separated fields/);
  });

  it('strips the DA suffix when synthesising dataFile', () => {
    const t = parseZbNrTab('7514050,0000000,7508145,A,7514051DA,0FFFFFFFFFD,134,1 1');
    expect(t.rows[0]!.dataFile).toBe('A7514051.0DA');
  });

  it('leaves dataFile undefined when SW-NR has no DA tag', () => {
    const t = parseZbNrTab('7514050,0000000,7508145,A,UNKNOWN,0FFFFFFFFFD,134,1 1');
    expect(t.rows[0]!.dataFile).toBeUndefined();
  });
});

describe('findByHwNr / findByZbNr', () => {
  const fixture = parseZbNrTab(
    [
      '7514050,0000000,7508145,A,7514051DA,0FFFFFFFFFD,134,1 1',
      '7514052,0000000,7508145,A,7514053DA,0FFFFFFFFFD,134,1 D',
      '7552752,1000000,7544721,A,7552753DA,0FFFFFFFFFD,134,1 G',
      '7552754,1000000,7544721,A,7552755DA,0FFFFFFFFFD,134,1 S',
    ].join('\n'),
  );

  it('finds multiple rows for a shared HW-NR', () => {
    const rows = findByHwNr(fixture, '7544721');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.zbNr).sort()).toEqual(['7552752', '7552754']);
  });

  it('finds a single row by ZB-NR', () => {
    const row = findByZbNr(fixture, '7552754');
    expect(row?.programFile).toBe('7544721A.0PA');
    expect(row?.dataFile).toBe('A7552755.0DA');
  });

  it('returns undefined when ZB-NR is missing', () => {
    expect(findByZbNr(fixture, '9999999')).toBeUndefined();
  });
});

describe.skipIf(skipReal)('parseZbNrTab — real SP-Daten', () => {
  it('parses GD20.DAT without errors', () => {
    const bytes = readFileSync(REAL_GD20_DAT);
    const t = parseZbNrTab(bytes);
    expect(t.skipped).toEqual([]);
    expect(t.rows.length).toBeGreaterThan(10);
    expect(t.directives['VERSIONKFCONF']).toBeDefined();
  });

  it('finds bench-ECU HW-NR 7544721 in GD20.DAT (2 rows)', () => {
    const bytes = readFileSync(REAL_GD20_DAT);
    const t = parseZbNrTab(bytes);
    const rows = findByHwNr(t, '7544721');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.programFile).toBe('7544721A.0PA');
      expect(r.dataFile).toMatch(/^A\d+\.0DA$/);
    }
  });
});
