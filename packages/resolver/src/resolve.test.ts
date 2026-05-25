import { describe, expect, it } from 'vitest';
import {
  parseHwnr,
  parseKfConf,
  parseKmmSit,
  parseNpv,
  parsePrgIfSel,
  parseSgId,
} from '@emdzej/nfsx-data-files';
import type { SpDaten } from './load.js';
import { resolveByHwnr, resolveBySgTyp, resolveByDiagAddr, resolveUpgrade } from './resolve.js';

function fakeSpDaten(opts: {
  hwnr?: string;
  kfConf?: string;
  kmmSit?: string;
  sgIdc?: string;
  sgIdd?: string;
  npv?: string;
  prgIfSel?: string;
}): SpDaten {
  return {
    hwnr: opts.hwnr ? parseHwnr(opts.hwnr) : undefined,
    kfConf: opts.kfConf ? parseKfConf(opts.kfConf) : undefined,
    kmmSit: opts.kmmSit ? parseKmmSit(opts.kmmSit) : undefined,
    sgIdc: opts.sgIdc ? parseSgId(opts.sgIdc) : undefined,
    sgIdd: opts.sgIdd ? parseSgId(opts.sgIdd) : undefined,
    npv: opts.npv ? parseNpv(opts.npv) : undefined,
    prgIfSel: opts.prgIfSel ? parsePrgIfSel(opts.prgIfSel) : undefined,
    warnings: [],
    parseErrors: [],
  };
}

describe('resolveByHwnr', () => {
  it('resolves a HWNR through the full chain', () => {
    const sp = fakeSpDaten({
      hwnr: `;$SG ACC65\n4010581,0000000,0000000,ACC65\n`,
      kfConf: `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n`,
    });

    const candidates = resolveByHwnr(sp, '4010581');
    expect(candidates).toHaveLength(1);

    const c = candidates[0]!;
    expect(c.hwnr).toBe('4010581');
    expect(c.sgTyp).toBe('ACC65');
    expect(c.hwnrRows).toHaveLength(1);
    expect(c.kfConfRows).toHaveLength(1);
    expect(c.kfConfRows[0]!.ipoFile).toBe('25ACC65.IPO');
    expect(c.kfConfRows[0]!.flashSgbd).toBe('02FLASH.PRG');
    expect(c.sit).toBeUndefined(); // no SIT in this fixture
    expect(c.sgIdc).toEqual([]); // no SGIDC loaded
    expect(c.sgIdd).toEqual([]); // no SGIDD loaded
    expect(c.prgIfSel).toBeUndefined(); // no prgifsel loaded
  });

  it('returns multiple candidates for a multi-SG_TYP HWNR', () => {
    const sp = fakeSpDaten({
      hwnr:
        `;$SG EK726\n4463157,0000000,0000000,EK726\n` +
        `;$SG EK726L\n4463157,0000000,0000000,EK726L\n` +
        `;$SG EK726M\n4463157,0000000,0000000,EK726M\n`,
      kfConf:
        `ME L1 21 01 EK726 00EK726.IPO 00FLASH.PRG XXFLKP EK726.HIS EK726.DAT A EK726D.DIR EK726.HWH\n` +
        `ME L2 21 01 EK726L 00EK726L.IPO 00FLASH.PRG XXFLKP EK726L.HIS EK726L.DAT A EK726LD.DIR EK726L.HWH\n` +
        // Deliberately no KFCONF row for EK726M to test the partial-resolve path
        ``,
    });

    const candidates = resolveByHwnr(sp, '4463157');
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.sgTyp).sort()).toEqual(['EK726', 'EK726L', 'EK726M']);

    // EK726 + EK726L have KFCONF rows; EK726M doesn't.
    const ek726 = candidates.find((c) => c.sgTyp === 'EK726')!;
    const ek726m = candidates.find((c) => c.sgTyp === 'EK726M')!;
    expect(ek726.kfConfRows).toHaveLength(1);
    expect(ek726m.kfConfRows).toEqual([]); // not flashable in this drop
  });

  it('returns [] for an unknown HWNR', () => {
    const sp = fakeSpDaten({
      hwnr: `;$SG ACC65\n4010581,0000000,0000000,ACC65\n`,
    });
    expect(resolveByHwnr(sp, '9999999')).toEqual([]);
  });

  it('returns [] when no HWNR.DA2 is loaded', () => {
    const sp = fakeSpDaten({});
    expect(resolveByHwnr(sp, '4010581')).toEqual([]);
  });
});

describe('resolveBySgTyp', () => {
  it('resolves an SG_TYP without needing a HWNR', () => {
    const sp = fakeSpDaten({
      hwnr: `;$SG ACC65\n4010581,0000000,0000000,ACC65\n`,
      kfConf: `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n`,
    });
    const c = resolveBySgTyp(sp, 'ACC65');
    expect(c).toBeDefined();
    expect(c!.hwnr).toBeUndefined(); // no specific HWNR — the lookup is by SG
    expect(c!.sgTyp).toBe('ACC65');
    expect(c!.hwnrRows).toHaveLength(1);
    expect(c!.kfConfRows).toHaveLength(1);
  });

  it('returns undefined when SG_TYP has no KFCONF entry', () => {
    const sp = fakeSpDaten({
      hwnr: `;$SG ACC65\n4010581,0000000,0000000,ACC65\n`,
    });
    expect(resolveBySgTyp(sp, 'ACC65')).toBeUndefined();
    expect(resolveBySgTyp(sp, 'NONEXISTENT')).toBeUndefined();
  });

  it('joins kmm_SIT.txt when the shortName matches the SG_TYP case-insensitively', () => {
    const sp = fakeSpDaten({
      hwnr: `;$SG ME9_4N\n4010581,0000000,0000000,ME9_4N\n`,
      kfConf: `ME A1 12 01 ME9_4N 00ME9_4N.IPO 12FLASH.PRG XXFLKP ME9_4N.HIS ME9_4N.DAT A ME9_4ND.DIR ME9_4N.HWH\n`,
      kmmSit: `12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n`,
    });

    const c = resolveBySgTyp(sp, 'ME9_4N')!;
    expect(c.sit).toBeDefined();
    expect(c.sit!.transport).toBe('KLINE');
    expect(c.sit!.flashLimit).toBe(14);
    expect(c.sit!.category).toBe('MOT');
  });

  it('joins SGIDC + SGIDD + prgifsel.dat when all three are loaded', () => {
    const sp = fakeSpDaten({
      hwnr: `;$SG ACC65\n4010581,0000000,0000000,ACC65\n`,
      kfConf: `ME A7 21 01 ACC65 25ACC65.IPO 02FLASH.PRG XXFLKP ACC65.HIS ACC65.DAT A ACC65D.DIR ACC65.HWH\n`,
      sgIdc: `$L 3\n$K ACC65 A721000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2\n`,
      sgIdd: `$L 4\n$K ACC65 A721000069ABA6A385D909B83074C62D43A5EBCA9D\n`,
      prgIfSel: `SG ACC65 - - - KWP2000* - - - - - -\n`,
    });

    const c = resolveBySgTyp(sp, 'ACC65')!;
    expect(c.sgIdc).toHaveLength(1);
    expect(c.sgIdc[0]!.payload).toMatch(/^A721/);
    expect(c.sgIdd).toHaveLength(1);
    expect(c.sgIdd[0]!.payload).toMatch(/^A721/);
    // Same first 4 chars (HW prefix bytes) — different content
    // after that (different cert levels).
    expect(c.sgIdc[0]!.payload).not.toBe(c.sgIdd[0]!.payload);
    expect(c.prgIfSel).toBeDefined();
    expect(c.prgIfSel!.protocol).toBe('KWP2000*');
  });
});

describe('resolveByDiagAddr', () => {
  it('resolves a DiagAddr to all SIT rows on that address', () => {
    const sp = fakeSpDaten({
      kmmSit:
        `12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n` +
        `12;me9k42;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80\n` +
        `14;other;d_0014;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;KAR;60;;;0;80\n`,
    });

    const results = resolveByDiagAddr(sp, 0x12);
    expect(results.map((c) => c.sit?.shortName).sort()).toEqual(['me9_4n', 'me9k42']);

    expect(resolveByDiagAddr(sp, 0x14)).toHaveLength(1);
    expect(resolveByDiagAddr(sp, 0xff)).toEqual([]);
  });

  it('returns [] when kmm_SIT.txt is not loaded', () => {
    const sp = fakeSpDaten({});
    expect(resolveByDiagAddr(sp, 0x12)).toEqual([]);
  });
});

describe('resolveUpgrade', () => {
  it('finds the upgrade row for a current ZB-Nummer', () => {
    const sp = fakeSpDaten({
      npv:
        `;ZB-ALT,ZB-NEU,NP-SW,AM,S,M CS\n` +
        `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\n` +
        `1703645,1744495,1427106NA,1FFFFFFFFFD,1,1 H\n`,
    });

    const upgrade = resolveUpgrade(sp, '1703643');
    expect(upgrade).toBeDefined();
    expect(upgrade!.zbNeu).toBe('1744493');
    expect(upgrade!.npSw).toBe('1427105NA');
    expect(upgrade!.am).toBe('1FFFFFFFFFD');
    expect(upgrade!.cs).toBe('6');
  });

  it('returns undefined when the ZB has no upgrade rule', () => {
    const sp = fakeSpDaten({
      npv: `1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6\n`,
    });
    expect(resolveUpgrade(sp, '9999999')).toBeUndefined();
  });

  it('returns undefined when npv.dat is not loaded', () => {
    const sp = fakeSpDaten({});
    expect(resolveUpgrade(sp, '1703643')).toBeUndefined();
  });
});
