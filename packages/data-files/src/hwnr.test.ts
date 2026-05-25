import { describe, expect, it } from 'vitest';
import { parseHwnr } from './hwnr.js';

describe('parseHwnr', () => {
  it('parses a minimal grouped HWNR.DA2', () => {
    const file = parseHwnr(
      `;Hardwaredatei vom 24.04.2009 10:17\n` +
        `;HWNR    AT_HWNR EP_TSNR SG_TYP\n` +
        `;--------------------------\n` +
        `;$SG ACC65               \n` +
        `4010581,0000000,0000000,ACC65               \n` +
        `4011919,0000000,0000000,ACC65               \n` +
        `;--------------------------\n` +
        `;$SG AFS60               \n` +
        `4011118,0000000,0000000,AFS60               \n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.header).toBe('Hardwaredatei vom 24.04.2009 10:17');
    expect(file.rows).toHaveLength(3);

    // SG_TYP gets trimmed of the source's space padding.
    expect(file.rows.map((r) => r.sgTyp)).toEqual(['ACC65', 'ACC65', 'AFS60']);

    // Indexes built.
    expect(file.bySgTyp.get('ACC65')).toHaveLength(2);
    expect(file.bySgTyp.get('AFS60')).toHaveLength(1);
    // byHwnr is multi-valued (a single HWNR can map to several SG_TYP variants).
    expect(file.byHwnr.get('4010581')?.[0]?.sgTyp).toBe('ACC65');
    expect(file.byHwnr.get('4011118')?.[0]?.sgTyp).toBe('AFS60');
  });

  it('preserves the HWNR as a string (leading zeros + decimal-shape part numbers)', () => {
    // Parsing as `number` would lose the canonical 7-digit form.
    const file = parseHwnr(
      `;$SG TEST\n` +
        `0010581,0000000,0000000,TEST\n`,
    );
    expect(file.rows[0]!.hwnr).toBe('0010581');
    expect(file.byHwnr.get('0010581')?.[0]?.hwnr).toBe('0010581');
  });

  it('flags a row whose SG_TYP disagrees with the surrounding section', () => {
    const file = parseHwnr(
      `;$SG ACC65\n` +
        `4010581,0000000,0000000,DIFFERENT\n`,
    );
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toMatch(/doesn't match section/);
    // The row is still indexed under its declared SG_TYP, not the
    // section's — we trust the row's own field over the marker.
    expect(file.byHwnr.get('4010581')?.[0]?.sgTyp).toBe('DIFFERENT');
  });

  it('flags a non-numeric HWNR', () => {
    const file = parseHwnr(
      `;$SG TEST\n` +
        `ABCDEFG,0000000,0000000,TEST\n`,
    );
    expect(file.rows).toEqual([]);
    expect(file.unparsed).toHaveLength(1);
    expect(file.unparsed[0]!.reason).toMatch(/HWNR/);
  });

  it('silently collapses same-SG_TYP duplicate HWNRs (real E46 data has ~4 of these)', () => {
    const file = parseHwnr(
      `;$SG TEST\n` +
        `4010581,0000000,0000000,TEST\n` +
        `4010581,0000000,0000000,TEST\n`,
    );
    expect(file.rows).toHaveLength(1);
    expect(file.unparsed).toEqual([]); // benign duplicate, not flagged
    expect(file.byHwnr.get('4010581')).toHaveLength(1);
  });

  it('accepts a cross-SG_TYP HWNR mapping as multi-valued (real E46: EK726 ↔ EK726L ↔ EK726M)', () => {
    const file = parseHwnr(
      `;$SG EK726\n` +
        `4463157,0000000,0000000,EK726\n` +
        `;$SG EK726L\n` +
        `4463157,0000000,0000000,EK726L\n` +
        `;$SG EK726M\n` +
        `4463157,0000000,0000000,EK726M\n`,
    );

    expect(file.unparsed).toEqual([]); // not flagged — it's a real BMW pattern
    expect(file.rows).toHaveLength(3); // all three rows kept

    // byHwnr is multi-valued.
    const bucket = file.byHwnr.get('4463157');
    expect(bucket).toHaveLength(3);
    expect(bucket?.map((r) => r.sgTyp).sort()).toEqual(['EK726', 'EK726L', 'EK726M']);
  });

  it('tolerates rows without surrounding section markers', () => {
    // Some files might be flat without `;$SG` headers. Don't require them.
    const file = parseHwnr(
      `4010581,0000000,0000000,ACC65\n` +
        `4011919,0000000,0000000,ACC65\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows).toHaveLength(2);
  });

  it('strips trailing whitespace from SG_TYP across the file', () => {
    // Source uses fixed-column padding; consumers shouldn't see it.
    const file = parseHwnr(
      `;$SG ACC65\n` +
        `4010581,0000000,0000000,ACC65               \n`,
    );
    expect(file.rows[0]!.sgTyp).toBe('ACC65');
    expect(file.bySgTyp.has('ACC65')).toBe(true);
    expect(file.bySgTyp.has('ACC65               ')).toBe(false);
  });

  it('tolerates CRLF line endings', () => {
    const file = parseHwnr(
      `;$SG ACC65\r\n` +
        `4010581,0000000,0000000,ACC65\r\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.rows[0]!.hwnr).toBe('4010581');
  });

  it('flags row with wrong column count', () => {
    const file = parseHwnr(
      `4010581,0000000,ACC65\n`, // only 3 fields
    );
    expect(file.rows).toEqual([]);
    expect(file.unparsed[0]!.reason).toMatch(/expected 4 fields/);
  });
});
