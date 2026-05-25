import { describe, expect, it } from 'vitest';
import { parseNpv } from './npv.js';

describe('parseNpv', () => {
  it('parses the canonical upgrade row', () => {
    const file = parseNpv(
      `;ZB-ALT,ZB-NEU ,NP-SW    ,AM         ,S,M CS\n` +
        `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.rows).toHaveLength(1);

    const row = file.rows[0]!;
    expect(row.zbAlt).toBe('1703643');
    expect(row.zbNeu).toBe('1744493');
    expect(row.npSw).toBe('1427105NA');
    expect(row.am).toBe('1FFFFFFFFFD');
    expect(row.s).toBe(1);
    expect(row.m).toBe(1);
    expect(row.cs).toBe('6');
  });

  it('handles non-numeric CS characters (real data: H, M, Z, …)', () => {
    const file = parseNpv(
      `1703645,1744495,1427106NA,1FFFFFFFFFD,1,1 H\n` +
        `1703653,1744509,1427109NA,1FFFFFFFFFD,1,1 Z\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows.map((r) => r.cs)).toEqual(['H', 'Z']);
  });

  it('builds byZbAlt index for O(1) upgrade lookups', () => {
    const file = parseNpv(
      `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\n` +
        `1703645,1744495,1427106NA,1FFFFFFFFFD,1,1 H\n`,
    );
    expect(file.byZbAlt.get('1703643')?.zbNeu).toBe('1744493');
    expect(file.byZbAlt.get('1703645')?.zbNeu).toBe('1744495');
    expect(file.byZbAlt.get('9999999')).toBeUndefined();
  });

  it('collects header comments separately', () => {
    const file = parseNpv(
      `;Zusbauvorschrift fuer NP Kaltstart M50TUE\n` +
        `;mit Logistik MS40.0 May & Christie\n` +
        `;ZB-ALT,ZB-NEU ,NP-SW    ,AM         ,S,M CS\n` +
        `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\n`,
    );
    expect(file.comments).toHaveLength(3);
    expect(file.comments[0]).toMatch(/Zusbauvorschrift/);
    expect(file.rows).toHaveLength(1);
  });

  it('flags rows with the wrong column count', () => {
    const file = parseNpv(
      `1703643,1744493,1427105NA\n`, // too few fields
    );
    expect(file.rows).toEqual([]);
    expect(file.unparsed[0]!.reason).toMatch(/expected 6 fields/);
  });

  it('flags duplicate ZB-ALT (keeps the first)', () => {
    const file = parseNpv(
      `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\n` +
        `1703643,9999999,9999999XX,FFFFFFFFFFF,9,9 X\n`,
    );
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]!.zbNeu).toBe('1744493');
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toMatch(/duplicate ZB-ALT 1703643/);
  });

  it('tolerates CRLF line endings', () => {
    const file = parseNpv(
      `;header\r\n1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\r\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows[0]!.zbAlt).toBe('1703643');
  });

  it('handles missing CS gracefully (single-token last field)', () => {
    // Defensive: if the M+CS field only has one token, accept it
    // as M with empty CS rather than throwing.
    const file = parseNpv(
      `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows[0]!.m).toBe(1);
    expect(file.rows[0]!.cs).toBe('');
  });
});
