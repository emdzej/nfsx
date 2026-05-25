import { describe, expect, it } from 'vitest';
import { parseKfConf } from './kfconf.js';

describe('parseKfConf', () => {
  it('parses a minimal KFCONF10.DA2', () => {
    const file = parseKfConf(
      `;Konfigdatei fuer NPS vom 24.04.2009 10:17\n` +
        `$ VERSIONKFCONF: kfconf10.da2\n` +
        `;--------------------------\n` +
        `ME A7 21 01 ACC65   25ACC65.IPO   02FLASH.PRG   XXFLKP   ACC65.HIS   ACC65.DAT   A   ACC65D.DIR   ACC65.HWH\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.header).toBe('Konfigdatei fuer NPS vom 24.04.2009 10:17');
    expect(file.directives.get('VERSIONKFCONF')).toBe('kfconf10.da2');
    expect(file.rows).toHaveLength(1);

    const row = file.rows[0]!;
    expect(row.marker).toBe('ME');
    expect(row.code).toBe('A7');
    expect(row.variantHex).toBe('21');
    expect(row.version).toBe('01');
    expect(row.sgTyp).toBe('ACC65');
    expect(row.ipoFile).toBe('25ACC65.IPO');
    expect(row.flashSgbd).toBe('02FLASH.PRG');
    expect(row.control).toBe('XXFLKP');
    expect(row.hisFile).toBe('ACC65.HIS');
    expect(row.datFile).toBe('ACC65.DAT');
    expect(row.versionTag).toBe('A');
    expect(row.dirFile).toBe('ACC65D.DIR');
    expect(row.hwhFile).toBe('ACC65.HWH');
  });

  it('indexes multi-variant SG_TYPs (different variantHex per row)', () => {
    // Some ECUs have multiple coding-index variants (see ALBV60 in
    // the real KFCONF10.DA2 which has 59 01 + 5A 02 rows for the
    // same SG_TYP).
    const file = parseKfConf(
      `ME LU 59 01 ALBV60 00ALBV60.IPO 00FLASH.PRG XXFLKP ALBV60.HIS ALBV60.DAT A ALBV60D.DIR ALBV60.HWH\n` +
        `ME LU 5A 02 ALBV60 00ALBV60.IPO 00FLASH.PRG XXFLKP ALBV60.HIS ALBV60.DAT A ALBV60D.DIR ALBV60.HWH\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.bySgTyp.get('ALBV60')).toHaveLength(2);
    expect(file.bySgTyp.get('ALBV60')!.map((r) => r.variantHex)).toEqual(['59', '5A']);
  });

  it('collapses runs of space padding into single delimiters', () => {
    // Real KFCONF10.DA2 pads heavily for visual column alignment.
    const heavilyPadded =
      `ME QY 29 01 ABS56                  00ABS56.IPO                    00FLASH.PRG                    XXFLKP   ABS56.HIS                  ABS56.DAT                  A   ABS56D.DIR                    ABS56.HWH                  \n`;
    const file = parseKfConf(heavilyPadded);
    expect(file.unparsed).toEqual([]);
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]!.ipoFile).toBe('00ABS56.IPO');
    expect(file.rows[0]!.flashSgbd).toBe('00FLASH.PRG');
  });

  it('flags rows with the wrong column count', () => {
    const file = parseKfConf(
      `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n` +
        `ME BAD 99\n` + // too short
        `ME A8 22 02 OK 00OK.IPO 00FLASH.PRG XXFLKP OK.HIS OK.DAT A OKD.DIR OK.HWH\n`,
    );
    expect(file.rows.map((r) => r.sgTyp)).toEqual(['ACC65', 'OK']);
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.lineNo).toBe(2);
  });

  it('parses $-directives at the top of file', () => {
    const file = parseKfConf(
      `$ VERSIONKFCONF: kfconf10.da2\n` +
        `$ FORMAT: NPS\n` +
        `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n`,
    );
    expect(file.directives.get('VERSIONKFCONF')).toBe('kfconf10.da2');
    expect(file.directives.get('FORMAT')).toBe('NPS');
  });

  it('flags a malformed $-directive but keeps parsing rows', () => {
    const file = parseKfConf(
      `$ this is not a valid directive\n` +
        `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n`,
    );
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toMatch(/directive/);
    expect(file.rows).toHaveLength(1);
  });

  it('preserves all 13 raw fields for forward compat', () => {
    const file = parseKfConf(
      `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n`,
    );
    expect(file.rows[0]!.raw).toHaveLength(13);
  });

  it('tolerates CRLF line endings', () => {
    const file = parseKfConf(
      `$ VERSIONKFCONF: kfconf10.da2\r\n` +
        `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\r\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.directives.get('VERSIONKFCONF')).toBe('kfconf10.da2');
    expect(file.rows[0]!.sgTyp).toBe('ACC65');
  });
});
