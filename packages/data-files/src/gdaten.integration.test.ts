import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseSgId } from './sgid.js';
import { parseNpv } from './npv.js';
import { parsePrgIfSel } from './prgifsel.js';

/**
 * Integration tests for the four GDATEN parsers
 * (SGIDC.AS2, SGIDD.AS2, npv.dat, prgifsel.dat) against the real
 * `~/Downloads/E46_v74/data/gdaten/` SP-Daten drop.
 */

const ROOT = `${process.env.HOME}/Downloads/E46_v74/data/gdaten`;

const SGIDC = `${ROOT}/SGIDC.AS2`;
const SGIDD = `${ROOT}/SGIDD.AS2`;
const NPV = `${ROOT}/npv.dat`;
const PRGIFSEL = `${ROOT}/prgifsel.dat`;

describe.skipIf(!existsSync(SGIDC))('parseSgId — real SGIDC.AS2', () => {
  it('parses every line', () => {
    const file = parseSgId(readFileSync(SGIDC, { encoding: 'latin1' }));
    if (file.unparsed.length > 0) console.warn('SGIDC unparsed:', file.unparsed);
    expect(file.unparsed).toEqual([]);
    expect(file.directives.get('L')).toBe('3');
    expect(file.entries.length).toBeGreaterThan(10);
    // SG_TYPs appear in both pure-hex and prefixed-hex shapes.
    const prefixed = file.entries.filter((e) => !/^[0-9A-F]/.test(e.payload));
    console.log(
      `SGIDC: ${file.entries.length} entries, ${prefixed.length} prefixed (e.g. ${prefixed[0]?.sgTyp ?? '-'})`,
    );
  });
});

describe.skipIf(!existsSync(SGIDD))('parseSgId — real SGIDD.AS2', () => {
  it('parses every line', () => {
    const file = parseSgId(readFileSync(SGIDD, { encoding: 'latin1' }));
    if (file.unparsed.length > 0) console.warn('SGIDD unparsed:', file.unparsed);
    expect(file.unparsed).toEqual([]);
    expect(file.directives.get('L')).toBe('4');
    expect(file.entries.length).toBeGreaterThan(10);
    // SGIDD has known same-SG_TYP duplicates (ECO65 appears twice).
    let dupCount = 0;
    for (const bucket of file.bySgTyp.values()) {
      if (bucket.length > 1) dupCount++;
    }
    console.log(`SGIDD: ${file.entries.length} entries, ${dupCount} SG_TYPs with multiple variants`);
  });
});

describe.skipIf(!existsSync(NPV))('parseNpv — real npv.dat', () => {
  it('parses every line', () => {
    const file = parseNpv(readFileSync(NPV, { encoding: 'latin1' }));
    if (file.unparsed.length > 0) console.warn('NPV unparsed:', file.unparsed);
    expect(file.unparsed).toEqual([]);
    expect(file.rows.length).toBeGreaterThan(5);
    expect(file.comments.length).toBeGreaterThan(0);

    // Every row should have a 7-digit ZB-ALT.
    for (const row of file.rows) {
      expect(row.zbAlt).toMatch(/^\d{7}$/);
      expect(row.zbNeu).toMatch(/^\d{7}$/);
    }

    console.log(
      `NPV: ${file.rows.length} upgrade rules, e.g. ZB ${file.rows[0]!.zbAlt} → ${file.rows[0]!.zbNeu} via NP-SW ${file.rows[0]!.npSw}`,
    );
  });
});

describe.skipIf(!existsSync(PRGIFSEL))('parsePrgIfSel — real prgifsel.dat', () => {
  it('parses every line', () => {
    const file = parsePrgIfSel(readFileSync(PRGIFSEL, { encoding: 'latin1' }));
    if (file.unparsed.length > 0) console.warn('PRGIFSEL unparsed:', file.unparsed);
    expect(file.unparsed).toEqual([]);
    expect(file.rows.length).toBeGreaterThan(0);
    expect(file.stationId).toBeDefined();

    // Spot-check: most rows should use a real protocol name.
    const protocols = [...new Set(file.rows.map((r) => r.protocol))];
    console.log(
      `PRGIFSEL: stationId=${file.stationId}, ${file.rows.length} SGs, protocols=${protocols.join(', ')}`,
    );
  });
});
