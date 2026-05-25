import { describe, expect, it } from 'vitest';
import { parseKmmSit } from './kmm-sit.js';

/**
 * Test fixtures are synthetic but column-structurally identical to
 * real BMW kmm_SIT.txt rows. We DON'T ship real BMW data in the
 * test fixtures — the field shape is what we're testing, not BMW's
 * actual deployment data.
 */

describe('parseKmmSit', () => {
  it('parses a minimal single-row file', () => {
    const file = parseKmmSit(
      `# minimal\n` +
        `12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.rows).toHaveLength(1);

    const row = file.rows[0]!;
    expect(row.diagAddr).toBe(0x12);
    expect(row.shortName).toBe('me9_4n');
    expect(row.groupId).toBe('d_0012');
    expect(row.hwIdMode).toBe('MehrfachHwSNr');
    expect(row.aifMode).toBe('AIFLesen');
    expect(row.flashLimit).toBe(14);
    expect(row.transport).toBe('KLINE');
    expect(row.timeoutMs).toBe(1000);
    expect(row.category).toBe('MOT');
    expect(row.raw).toHaveLength(16);
    expect(row.lineNo).toBe(2);
  });

  it('parses diagAddr as hex, not decimal — KmmSrv assertion uses %02X', () => {
    // diagAddr "34" in source = 0x34 = 52 decimal.
    // If we parsed as decimal we'd get 34. The hex interpretation
    // matches the LSZ on E46 case (file extension `.C34` is hex).
    const file = parseKmmSit(
      `34;some_ecu;d_0034;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;KAR;60;;;0;80\n`,
    );
    expect(file.rows[0]!.diagAddr).toBe(0x34);
    expect(file.rows[0]!.diagAddr).toBe(52);
  });

  it('skips `#` comment lines and blank lines', () => {
    const file = parseKmmSit(
      `# header section\n` +
        `# another comment\n` +
        `\n` +
        `   \n` +
        `12;ecu1;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n` +
        `\n` +
        `# trailing comment\n` +
        `14;ecu2;d_0014;MehrfachHwSNr;AIFLesen;1;14;CAN;1000;1;KAR;60;;;0;80\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.rows.map((r) => r.shortName)).toEqual(['ecu1', 'ecu2']);
    expect(file.rows.map((r) => r.lineNo)).toEqual([5, 8]);
  });

  it('tolerates CRLF line endings (Windows-shipped files)', () => {
    const file = parseKmmSit(
      `# header\r\n` +
        `12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\r\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows[0]!.shortName).toBe('me9_4n');
  });

  it('returns blank optional numerics as `undefined`, not 0', () => {
    // Empty fields 6 (flashLimit) and 8 (timeoutMs) — must NOT collapse to 0.
    const file = parseKmmSit(
      `12;ecu1;d_0012;MehrfachHwSNr;AIFLesen;1;;KLINE;;1;MOT;60;;;0;80\n`,
    );
    expect(file.rows[0]!.flashLimit).toBeUndefined();
    expect(file.rows[0]!.timeoutMs).toBeUndefined();
  });

  it('keeps all 16 raw fields verbatim for forward-compat', () => {
    const file = parseKmmSit(
      `12;a;b;c;d;e;f;g;h;i;j;k;l;m;n;o\n`,
    );
    expect(file.rows[0]!.raw).toEqual(['12', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o']);
  });

  it('flags rows with the wrong field count rather than throwing', () => {
    const file = parseKmmSit(
      `# good row first to make sure the bad one doesn't sink it\n` +
        `12;ecu1;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n` +
        `14;ecu2;only;three;fields\n` +
        `16;ecu3;d_0016;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n`,
    );

    expect(file.rows.map((r) => r.shortName)).toEqual(['ecu1', 'ecu3']);
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.lineNo).toBe(3);
    expect(file.unparsed[0]!.reason).toContain('expected 16 fields');
  });

  it('flags a non-hex diagAddr as unparsed', () => {
    const file = parseKmmSit(
      `ZZ;ecu_bad;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n`,
    );
    expect(file.rows).toEqual([]);
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toContain('diagAddr');
  });

  it('flags an out-of-range diagAddr (> 0xff) as unparsed', () => {
    const file = parseKmmSit(
      `100;ecu_oor;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n`,
    );
    expect(file.rows).toEqual([]);
    expect(file.unparsed).toHaveLength(1);
  });

  it('handles section headers that look almost like rows', () => {
    const file = parseKmmSit(
      `#       ME9 4 Zylinder\n` +
        `12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n`,
    );
    // The section header is a `#` comment — must NOT show up in rows.
    expect(file.rows).toHaveLength(1);
    expect(file.unparsed).toEqual([]);
  });
});
