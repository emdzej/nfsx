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
  type HwnrFile,
  type KfConfFile,
  type KmmSitFile,
} from '@emdzej/nfsx-data-files';

export interface SpDaten {
  hwnr?: HwnrFile;
  kfConf?: KfConfFile;
  kmmSit?: KmmSitFile;
  /** Files that were expected but missing on disk. */
  warnings: string[];
  /**
   * Lines that failed to parse across all loaded files, with their
   * source file annotated so the consumer can point users at the
   * right spot.
   */
  parseErrors: Array<{ source: string; lineNo: number; reason: string }>;
}

export interface SpDatenPaths {
  /** Absolute path to HWNR.DA2 (or override). */
  hwnr: string;
  /** Absolute path to KFCONF10.DA2 (or override). */
  kfConf: string;
  /** Absolute path to kmm_SIT.txt (or override). */
  kmmSit: string;
}

/**
 * Default-path layout for an extracted SP-Daten chassis drop. The
 * three known paths today; this grows as more parsers land.
 */
export function defaultSpDatenPaths(rootDir: string): SpDatenPaths {
  return {
    hwnr: join(rootDir, 'data', 'gdaten', 'HWNR.DA2'),
    kfConf: join(rootDir, 'data', 'gdaten', 'KFCONF10.DA2'),
    kmmSit: join(rootDir, 'kmmData', 'kmm_SIT.txt'),
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

  return out;
}
