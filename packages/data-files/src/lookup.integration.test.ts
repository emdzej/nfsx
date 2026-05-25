import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseHwnr } from './hwnr.js';
import { parseKfConf } from './kfconf.js';

/**
 * End-to-end test of the part-number → IPO lookup chain against
 * the real `~/Downloads/E46_v74/data/gdaten/` SP-Daten drop. Joins
 * HWNR.DA2 and KFCONF10.DA2 by SG_TYP and validates the chain
 * the planner depends on.
 *
 * Self-skips when the SP-Daten path isn't present.
 */

const SP_DATEN = `${process.env.HOME}/Downloads/E46_v74/data/gdaten`;
const HWNR_PATH = `${SP_DATEN}/HWNR.DA2`;
const KFCONF_PATH = `${SP_DATEN}/KFCONF10.DA2`;

const hasFixtures = existsSync(HWNR_PATH) && existsSync(KFCONF_PATH);

describe.skipIf(!hasFixtures)('HWNR + KFCONF lookup chain (real SP-Daten)', () => {
  it('joins HWNR.DA2 → KFCONF10.DA2 by SG_TYP', () => {
    const hwnr = parseHwnr(readFileSync(HWNR_PATH, { encoding: 'latin1' }));
    const kfConf = parseKfConf(readFileSync(KFCONF_PATH, { encoding: 'latin1' }));

    // Both files parsed without unrecoverable errors.
    if (hwnr.unparsed.length > 0) console.warn('HWNR unparsed:', hwnr.unparsed);
    if (kfConf.unparsed.length > 0) console.warn('KFCONF unparsed:', kfConf.unparsed);
    expect(hwnr.unparsed).toEqual([]);
    expect(kfConf.unparsed).toEqual([]);

    // Sanity: dataset sizes are non-trivial.
    expect(hwnr.rows.length).toBeGreaterThan(100);
    expect(kfConf.rows.length).toBeGreaterThan(50);

    // Coverage: most SG_TYPs from HWNR.DA2 should resolve to a
    // KFCONF entry. (Not 100% — some HWNR groups exist for ECUs
    // that aren't flash-targets in this drop, e.g. legacy K-line
    // modules that NFS reads but doesn't program.)
    const hwnrSgTyps = new Set([...hwnr.bySgTyp.keys()]);
    const kfConfSgTyps = new Set([...kfConf.bySgTyp.keys()]);
    const covered = [...hwnrSgTyps].filter((s) => kfConfSgTyps.has(s));
    const coverage = covered.length / hwnrSgTyps.size;
    // We don't pin a hard threshold (it varies per drop), but it
    // should be a meaningful fraction. Log it for visibility.
    console.log(
      `HWNR→KFCONF coverage: ${covered.length} / ${hwnrSgTyps.size} (${(coverage * 100).toFixed(1)}%)`,
    );
    expect(coverage).toBeGreaterThan(0.05); // at least 5%
  });

  it('demonstrates the full lookup: HWNR → SG_TYP → IPO + Flash SGBD', () => {
    const hwnr = parseHwnr(readFileSync(HWNR_PATH, { encoding: 'latin1' }));
    const kfConf = parseKfConf(readFileSync(KFCONF_PATH, { encoding: 'latin1' }));

    // Pick the first HWNR row that has a matching KFCONF entry.
    let resolved: { hwnr: string; sgTyp: string; ipo: string; sgbd: string } | undefined;
    for (const row of hwnr.rows) {
      const kfRows = kfConf.bySgTyp.get(row.sgTyp);
      if (kfRows && kfRows.length > 0) {
        resolved = {
          hwnr: row.hwnr,
          sgTyp: row.sgTyp,
          ipo: kfRows[0]!.ipoFile,
          sgbd: kfRows[0]!.flashSgbd,
        };
        break;
      }
    }

    expect(resolved).toBeDefined();
    expect(resolved!.hwnr).toMatch(/^\d{7}$/);
    expect(resolved!.sgTyp.length).toBeGreaterThan(0);
    expect(resolved!.ipo).toMatch(/\.IPO$/i);
    expect(resolved!.sgbd).toMatch(/\.PRG$/i);

    console.log(
      `Lookup chain: HWNR=${resolved!.hwnr} → SG_TYP=${resolved!.sgTyp} → IPO=${resolved!.ipo}, SGBD=${resolved!.sgbd}`,
    );
  });

  it('demonstrates the multi-valued HWNR lookup (real E46 has ~hundreds of these)', () => {
    const hwnr = parseHwnr(readFileSync(HWNR_PATH, { encoding: 'latin1' }));

    // Find a HWNR that maps to multiple SG_TYPs.
    let multiHwnr: string | undefined;
    let multiSgTyps: string[] = [];
    for (const [h, bucket] of hwnr.byHwnr) {
      if (bucket.length > 1) {
        multiHwnr = h;
        multiSgTyps = bucket.map((r) => r.sgTyp);
        break;
      }
    }

    expect(multiHwnr).toBeDefined();
    expect(multiSgTyps.length).toBeGreaterThanOrEqual(2);
    console.log(`Multi-valued HWNR ${multiHwnr} → ${multiSgTyps.join(', ')}`);
  });
});
