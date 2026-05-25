import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { loadSpDatenFromDir } from './load.js';
import { resolveByHwnr } from './resolve.js';

/**
 * End-to-end load + resolve against the real E46_v74 SP-Daten drop.
 * Self-skips when not present.
 */

const ROOT = `${process.env.HOME}/Downloads/E46_v74`;
const present = existsSync(`${ROOT}/data/gdaten/HWNR.DA2`);

describe.skipIf(!present)('loadSpDatenFromDir + resolveByHwnr (real E46)', () => {
  it('loads the three known data files and resolves a known HWNR end-to-end', () => {
    const sp = loadSpDatenFromDir(ROOT);

    expect(sp.warnings).toEqual([]); // all three files present
    expect(sp.parseErrors).toEqual([]); // no per-row parse errors
    expect(sp.hwnr).toBeDefined();
    expect(sp.kfConf).toBeDefined();
    expect(sp.kmmSit).toBeDefined();

    // ACC65 is the canonical "first row" in real E46 KFCONF10.DA2;
    // 4010581 is its first HWNR. Resolve end-to-end and confirm.
    const candidates = resolveByHwnr(sp, '4010581');
    expect(candidates.length).toBeGreaterThan(0);

    const acc65 = candidates.find((c) => c.sgTyp === 'ACC65');
    expect(acc65).toBeDefined();
    expect(acc65!.kfConfRows.length).toBeGreaterThan(0);
    expect(acc65!.kfConfRows[0]!.ipoFile).toMatch(/ACC65/i);
    expect(acc65!.kfConfRows[0]!.flashSgbd).toMatch(/FLASH\.PRG/i);
  });

  it('resolves the multi-valued EK726 case from real data', () => {
    const sp = loadSpDatenFromDir(ROOT);
    const candidates = resolveByHwnr(sp, '4463157');
    // Real E46 maps 4463157 to at least EK726 + EK726L.
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const names = candidates.map((c) => c.sgTyp).sort();
    expect(names).toContain('EK726');
    expect(names).toContain('EK726L');
  });
});
