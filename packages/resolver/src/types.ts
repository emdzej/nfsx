/**
 * Shared browser-safe type definitions extracted from `load.ts` so
 * consumers importing from the main entry (`@emdzej/nfsx-resolver`)
 * don't drag in `node:fs` / `node:path` transitively.
 */
import type {
  HwnrFile,
  KfConfFile,
  KmmSitFile,
  NpvFile,
  PrgIfSelFile,
  SgIdFile,
} from '@emdzej/nfsx-data-files';

export interface SpDaten {
  hwnr?: HwnrFile;
  kfConf?: KfConfFile;
  kmmSit?: KmmSitFile;
  /** SGIDC.AS2 — level-3 authentication material. */
  sgIdc?: SgIdFile;
  /** SGIDD.AS2 — level-4 authentication material. */
  sgIdd?: SgIdFile;
  /** npv.dat — ZB upgrade rules. */
  npv?: NpvFile;
  /** prgifsel.dat — per-SG transport selection. */
  prgIfSel?: PrgIfSelFile;
  /** Files that were expected but missing on disk. */
  warnings: string[];
  /**
   * Lines that failed to parse across all loaded files, with their
   * source file annotated so the consumer can point users at the
   * right spot.
   */
  parseErrors: Array<{ source: string; lineNo: number; reason: string }>;
}

/**
 * Path overrides for the SP-Daten loader. Meaning depends on the
 * loader in use:
 *
 *   - The sync `loadSpDaten(paths)` (Node-only) takes absolute paths.
 *   - The async `loadSpDatenFromSource(source, paths)` (browser-safe)
 *     takes POSIX-style relative paths joined by the source itself.
 */
export interface SpDatenPaths {
  /** HWNR.DA2. */
  hwnr: string;
  /** KFCONF10.DA2. */
  kfConf: string;
  /** kmm_SIT.txt. */
  kmmSit: string;
  /** SGIDC.AS2. */
  sgIdc: string;
  /** SGIDD.AS2. */
  sgIdd: string;
  /** npv.dat. */
  npv: string;
  /** prgifsel.dat. */
  prgIfSel: string;
}
