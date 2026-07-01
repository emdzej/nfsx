/**
 * Load + parse an SP-Daten directory into an in-memory `SpDaten`
 * snapshot. Convenience wrapper over the individual parsers.
 *
 * The default file paths mirror the BMW SP-Daten chassis-drop
 * layout (e.g. `~/Downloads/E46_v74/`):
 *
 *   <rootDir>/data/gdaten/HWNR.DA2
 *   <rootDir>/data/gdaten/KFCONF10.DA2
 *   <rootDir>/kmmData/kmm_SIT.txt
 *
 * Any file can be overridden via `loadSpDaten({ ... })`. Missing
 * files are tolerated: the loader returns whatever could be read
 * and surfaces the absences in `warnings`. The planner consumer
 * checks for presence before using each table.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
import type { SpDaten, SpDatenPaths } from './types.js';

// Re-export the types so existing `import { SpDaten } from './load.js'`
// call sites keep working. The browser-facing consumers should import
// from './types.js' directly (which has no `node:*` dependencies).
export type { SpDaten, SpDatenPaths } from './types.js';

/**
 * Default-path layout for an extracted SP-Daten chassis drop. The
 * three known paths today; this grows as more parsers land.
 */
export function defaultSpDatenPaths(rootDir: string): SpDatenPaths {
  const gdaten = join(rootDir, 'data', 'gdaten');
  return {
    hwnr: join(gdaten, 'HWNR.DA2'),
    kfConf: join(gdaten, 'KFCONF10.DA2'),
    kmmSit: join(rootDir, 'kmmData', 'kmm_SIT.txt'),
    sgIdc: join(gdaten, 'SGIDC.AS2'),
    sgIdd: join(gdaten, 'SGIDD.AS2'),
    npv: join(gdaten, 'npv.dat'),
    prgIfSel: join(gdaten, 'prgifsel.dat'),
  };
}

/**
 * Load + parse the SP-Daten files from `rootDir`. Each absent file
 * is logged in `warnings` and left undefined on the returned struct
 * — the resolver tolerates partial loads.
 *
 * BMW ships files as ISO-8859-1 (Latin-1) — the loader decodes
 * accordingly to preserve umlauts in comments.
 */
export function loadSpDatenFromDir(rootDir: string): SpDaten {
  return loadSpDaten(defaultSpDatenPaths(rootDir));
}

/**
 * Load + parse the SP-Daten files from explicit paths. Use this
 * when the layout doesn't match the canonical SP-Daten chassis-drop
 * structure (e.g. an ISTA extract, a flat custom mirror).
 */
export function loadSpDaten(paths: Partial<SpDatenPaths>): SpDaten {
  const out: SpDaten = { warnings: [], parseErrors: [] };

  if (paths.hwnr) {
    if (existsSync(paths.hwnr)) {
      const content = readFileSync(paths.hwnr, { encoding: 'latin1' });
      out.hwnr = parseHwnr(content);
      for (const u of out.hwnr.unparsed) {
        out.parseErrors.push({ source: paths.hwnr, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`HWNR.DA2 not found at ${paths.hwnr}`);
    }
  }

  if (paths.kfConf) {
    if (existsSync(paths.kfConf)) {
      const content = readFileSync(paths.kfConf, { encoding: 'latin1' });
      out.kfConf = parseKfConf(content);
      for (const u of out.kfConf.unparsed) {
        out.parseErrors.push({ source: paths.kfConf, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`KFCONF10.DA2 not found at ${paths.kfConf}`);
    }
  }

  if (paths.kmmSit) {
    if (existsSync(paths.kmmSit)) {
      const content = readFileSync(paths.kmmSit, { encoding: 'latin1' });
      out.kmmSit = parseKmmSit(content);
      for (const u of out.kmmSit.unparsed) {
        out.parseErrors.push({ source: paths.kmmSit, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`kmm_SIT.txt not found at ${paths.kmmSit}`);
    }
  }

  if (paths.sgIdc) {
    if (existsSync(paths.sgIdc)) {
      const content = readFileSync(paths.sgIdc, { encoding: 'latin1' });
      out.sgIdc = parseSgId(content);
      for (const u of out.sgIdc.unparsed) {
        out.parseErrors.push({ source: paths.sgIdc, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`SGIDC.AS2 not found at ${paths.sgIdc}`);
    }
  }

  if (paths.sgIdd) {
    if (existsSync(paths.sgIdd)) {
      const content = readFileSync(paths.sgIdd, { encoding: 'latin1' });
      out.sgIdd = parseSgId(content);
      for (const u of out.sgIdd.unparsed) {
        out.parseErrors.push({ source: paths.sgIdd, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`SGIDD.AS2 not found at ${paths.sgIdd}`);
    }
  }

  if (paths.npv) {
    if (existsSync(paths.npv)) {
      const content = readFileSync(paths.npv, { encoding: 'latin1' });
      out.npv = parseNpv(content);
      for (const u of out.npv.unparsed) {
        out.parseErrors.push({ source: paths.npv, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`npv.dat not found at ${paths.npv}`);
    }
  }

  if (paths.prgIfSel) {
    if (existsSync(paths.prgIfSel)) {
      const content = readFileSync(paths.prgIfSel, { encoding: 'latin1' });
      out.prgIfSel = parsePrgIfSel(content);
      for (const u of out.prgIfSel.unparsed) {
        out.parseErrors.push({ source: paths.prgIfSel, lineNo: u.lineNo, reason: u.reason });
      }
    } else {
      out.warnings.push(`prgifsel.dat not found at ${paths.prgIfSel}`);
    }
  }

  return out;
}

/**
 * Load the per-SG flash mapping table (`<SG_TYP>.DAT`, e.g. `GD20.DAT`).
 *
 * Lives at `<rootDir>/data/<SG_TYP>/<datFileName>` — distinct from the
 * global tables in `gdaten/`. The filename comes from KFCONF's
 * `datFile` column for the chosen SG_TYP; pass it through so we don't
 * have to redo KFCONF resolution here.
 *
 * Returns `undefined` when the file is missing (some SGs may legitimately
 * lack a `.DAT` table in older SP-Daten drops). Caller treats absence
 * as "no flash-file pairing available" rather than a parse error.
 */
export function loadZbNrTabForSg(
  rootDir: string,
  sgTyp: string,
  datFileName: string,
): ZbNrTabFile | undefined {
  const path = join(rootDir, 'data', sgTyp, datFileName);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, { encoding: 'latin1' });
  return parseZbNrTab(content);
}
