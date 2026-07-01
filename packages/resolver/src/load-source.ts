/**
 * Async, source-based SP-Daten loader. Mirrors the sync `loadSpDaten`
 * / `loadSpDatenFromDir` API but reads through a `SpDatenSource`
 * abstraction so browser consumers (VFS-backed) and CLI consumers
 * (Node fs) drive the same parser code.
 *
 * Missing files are tolerated the same way the sync loader tolerates
 * them: absences go into `warnings`, parse errors into `parseErrors`.
 */
import {
  parseHwnr,
  parseKfConf,
  parseKmmSit,
  parseNpv,
  parsePrgIfSel,
  parseSgId,
  parseZbNrTab,
  type ZbNrTabFile,
} from '@emdzej/nfsx-data-files';
import type { SpDatenSource } from './source.js';
import type { SpDaten, SpDatenPaths } from './types.js';

// Latin-1 is BMW's on-disk encoding — preserves umlauts in comments.
const latin1Decoder = new TextDecoder('windows-1252');

/**
 * Default POSIX-relative layout that a chassis-drop `SpDatenSource`
 * uses. Mirrors `defaultSpDatenPaths` but without an absolute prefix
 * — the source knows its own root.
 */
export function defaultSpDatenRelativePaths(): SpDatenPaths {
  return {
    hwnr: 'data/gdaten/HWNR.DA2',
    kfConf: 'data/gdaten/KFCONF10.DA2',
    kmmSit: 'kmmData/kmm_SIT.txt',
    sgIdc: 'data/gdaten/SGIDC.AS2',
    sgIdd: 'data/gdaten/SGIDD.AS2',
    npv: 'data/gdaten/npv.dat',
    prgIfSel: 'data/gdaten/prgifsel.dat',
  };
}

async function readTextIfExists(
  source: SpDatenSource,
  path: string,
): Promise<string | null> {
  if (!(await source.exists(path))) return null;
  const bytes = await source.read(path);
  return latin1Decoder.decode(bytes);
}

/**
 * Load + parse the SP-Daten files from a source. Uses the canonical
 * chassis-drop relative layout by default; pass `paths` to override
 * individual files.
 */
export async function loadSpDatenFromSource(
  source: SpDatenSource,
  paths: Partial<SpDatenPaths> = defaultSpDatenRelativePaths(),
): Promise<SpDaten> {
  const merged = { ...defaultSpDatenRelativePaths(), ...paths };
  const out: SpDaten = { warnings: [], parseErrors: [] };

  const hwnrText = await readTextIfExists(source, merged.hwnr);
  if (hwnrText !== null) {
    out.hwnr = parseHwnr(hwnrText);
    for (const u of out.hwnr.unparsed) {
      out.parseErrors.push({ source: merged.hwnr, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`HWNR.DA2 not found at ${merged.hwnr}`);
  }

  const kfConfText = await readTextIfExists(source, merged.kfConf);
  if (kfConfText !== null) {
    out.kfConf = parseKfConf(kfConfText);
    for (const u of out.kfConf.unparsed) {
      out.parseErrors.push({ source: merged.kfConf, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`KFCONF10.DA2 not found at ${merged.kfConf}`);
  }

  const kmmSitText = await readTextIfExists(source, merged.kmmSit);
  if (kmmSitText !== null) {
    out.kmmSit = parseKmmSit(kmmSitText);
    for (const u of out.kmmSit.unparsed) {
      out.parseErrors.push({ source: merged.kmmSit, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`kmm_SIT.txt not found at ${merged.kmmSit}`);
  }

  const sgIdcText = await readTextIfExists(source, merged.sgIdc);
  if (sgIdcText !== null) {
    out.sgIdc = parseSgId(sgIdcText);
    for (const u of out.sgIdc.unparsed) {
      out.parseErrors.push({ source: merged.sgIdc, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`SGIDC.AS2 not found at ${merged.sgIdc}`);
  }

  const sgIddText = await readTextIfExists(source, merged.sgIdd);
  if (sgIddText !== null) {
    out.sgIdd = parseSgId(sgIddText);
    for (const u of out.sgIdd.unparsed) {
      out.parseErrors.push({ source: merged.sgIdd, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`SGIDD.AS2 not found at ${merged.sgIdd}`);
  }

  const npvText = await readTextIfExists(source, merged.npv);
  if (npvText !== null) {
    out.npv = parseNpv(npvText);
    for (const u of out.npv.unparsed) {
      out.parseErrors.push({ source: merged.npv, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`npv.dat not found at ${merged.npv}`);
  }

  const prgIfSelText = await readTextIfExists(source, merged.prgIfSel);
  if (prgIfSelText !== null) {
    out.prgIfSel = parsePrgIfSel(prgIfSelText);
    for (const u of out.prgIfSel.unparsed) {
      out.parseErrors.push({ source: merged.prgIfSel, lineNo: u.lineNo, reason: u.reason });
    }
  } else {
    out.warnings.push(`prgifsel.dat not found at ${merged.prgIfSel}`);
  }

  return out;
}

/**
 * Async companion to `loadZbNrTabForSg` — reads the per-SG `.DAT`
 * mapping table through a `SpDatenSource`. Returns undefined when
 * the file is absent (older SP-Daten drops legitimately lack it).
 */
export async function loadZbNrTabForSgFromSource(
  source: SpDatenSource,
  sgTyp: string,
  datFileName: string,
): Promise<ZbNrTabFile | undefined> {
  const path = `data/${sgTyp}/${datFileName}`;
  const text = await readTextIfExists(source, path);
  if (text === null) return undefined;
  return parseZbNrTab(text);
}
