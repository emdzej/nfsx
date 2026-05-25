import { describe, expect, it } from 'vitest';
import { parsePrgIfSel } from './prgifsel.js';

describe('parsePrgIfSel', () => {
  it('parses a minimal file with ID + SG rows', () => {
    const file = parsePrgIfSel(
      `; Allgemeine Konfigurationsinfo Deutsch\n` +
        `ID 1.1-0003-progstatline03-123.123.123.123\n` +
        `;SG ECU      Interface Hardware       Information        Protokoll     Paramater1                    P2       P3 P4 r  r\n` +
        `SG EK924    -         -              -                  KWP2000*      -                             -        -  -  -  -\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.stationId).toBe('1.1-0003-progstatline03-123.123.123.123');
    expect(file.rows).toHaveLength(1);

    const row = file.rows[0]!;
    expect(row.sgName).toBe('EK924');
    expect(row.iface).toBe('-');
    expect(row.protocol).toBe('KWP2000*');
    expect(row.raw).toHaveLength(11);
  });

  it('collapses runs of whitespace as delimiters (heavily padded source)', () => {
    // Real prgifsel.dat pads with many spaces for visual alignment.
    const heavyPad =
      `SG EKB924   -         -              -                  KWP2000*      -                             -        -  -  -  -\n`;
    const file = parsePrgIfSel(heavyPad);
    expect(file.unparsed).toEqual([]);
    expect(file.rows[0]!.sgName).toBe('EKB924');
    expect(file.rows[0]!.protocol).toBe('KWP2000*');
  });

  it('indexes rows by SG name', () => {
    const file = parsePrgIfSel(
      `SG EK924  - - - KWP2000* - - - - - -\n` +
        `SG EKB924 - - - KWP2000* - - - - - -\n` +
        `SG EK927  - - - KWP1281 - - - - - -\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.bySgName.get('EK924')?.protocol).toBe('KWP2000*');
    expect(file.bySgName.get('EKB924')?.protocol).toBe('KWP2000*');
    expect(file.bySgName.get('EK927')?.protocol).toBe('KWP1281');
    expect(file.bySgName.get('UNKNOWN')).toBeUndefined();
  });

  it('flags duplicate SG names (keeps the first)', () => {
    const file = parsePrgIfSel(
      `SG EK924 - - - KWP2000* - - - - - -\n` +
        `SG EK924 - - - DIFFERENT - - - - - -\n`,
    );
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]!.protocol).toBe('KWP2000*');
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toMatch(/duplicate SG EK924/);
  });

  it('flags SG rows with wrong field count', () => {
    const file = parsePrgIfSel(
      `SG EK924 - - - KWP2000*\n`, // only 5 fields after SG, expected 11
    );
    expect(file.rows).toEqual([]);
    expect(file.unparsed[0]!.reason).toMatch(/expected 11 fields after `SG`/);
  });

  it('skips `;` comment lines', () => {
    const file = parsePrgIfSel(
      `; comment 1\n` +
        `;Beispielzeile\n` +
        `;SG ECU Interface Hardware …\n` + // example legend
        `SG EK924 - - - KWP2000* - - - - - -\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows).toHaveLength(1);
  });

  it('tolerates ID line with multi-token value', () => {
    const file = parsePrgIfSel(
      `ID some-station-with-many-dashes-and-numbers-1.2.3.4\n`,
    );
    expect(file.stationId).toBe('some-station-with-many-dashes-and-numbers-1.2.3.4');
  });

  it('handles files without an ID line', () => {
    const file = parsePrgIfSel(
      `SG EK924 - - - KWP2000* - - - - - -\n`,
    );
    expect(file.stationId).toBeUndefined();
    expect(file.rows).toHaveLength(1);
  });

  it('tolerates CRLF line endings', () => {
    const file = parsePrgIfSel(
      `ID test\r\n` +
        `SG EK924 - - - KWP2000* - - - - - -\r\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.stationId).toBe('test');
    expect(file.rows).toHaveLength(1);
  });

  it('flags unrecognised line shapes', () => {
    const file = parsePrgIfSel(
      `RANDOM stuff that is not ID or SG\n`,
    );
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toMatch(/unrecognised line shape/);
  });
});
