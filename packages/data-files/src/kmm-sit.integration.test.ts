import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseKmmSit } from './kmm-sit.js';

/**
 * Integration test against a real BMW SP-Daten drop. This file is
 * NOT shipped with the repo (BMW data, not ours to redistribute) —
 * the test self-skips when the path isn't present so CI on other
 * machines + the published-package consumer don't see failures.
 *
 * To run locally: have `E46_v74` (or any other SP-Daten with a
 * `kmmData/kmm_SIT.txt`) extracted under `~/Downloads/`.
 */

const SP_DATEN_PATHS = [
  `${process.env.HOME}/Downloads/E46_v74/kmmData/kmm_SIT.txt`,
];

const real = SP_DATEN_PATHS.find((p) => existsSync(p));

describe.skipIf(!real)('parseKmmSit (real SP-Daten)', () => {
  it(`parses ${real} without losing any non-comment line`, () => {
    // Latin-1 — comment lines have German umlauts.
    const content = readFileSync(real!, { encoding: 'latin1' });
    const file = parseKmmSit(content);

    // Sanity: a real E46 kmm_SIT.txt has dozens of ECU rows.
    expect(file.rows.length).toBeGreaterThan(10);

    // Every row's diagAddr is a valid byte.
    for (const row of file.rows) {
      expect(row.diagAddr).toBeGreaterThanOrEqual(0);
      expect(row.diagAddr).toBeLessThanOrEqual(0xff);
    }

    // Every row keeps all 16 fields.
    for (const row of file.rows) {
      expect(row.raw).toHaveLength(16);
    }

    // No row should land in `unparsed` — if it does, the parser
    // has a real bug (or BMW snuck in a new shape).
    if (file.unparsed.length > 0) {
      console.warn(`unparsed lines in ${real}:`, file.unparsed);
    }
    expect(file.unparsed).toEqual([]);

    // Spot-check: at least one row should have transport=KLINE
    // (E46 is K-line heavy).
    const klineRows = file.rows.filter((r) => r.transport === 'KLINE');
    expect(klineRows.length).toBeGreaterThan(0);

    // Spot-check: at least one row should have category=MOT.
    const motRows = file.rows.filter((r) => r.category === 'MOT');
    expect(motRows.length).toBeGreaterThan(0);
  });
});
