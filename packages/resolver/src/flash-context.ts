/**
 * `resolveFlashContext` — given just an SP-Daten root + HWNR, derive
 * everything the FlashSession needs: the target IPO path, the SGBD
 * basename, the SWT IPO path, the per-SG working directory, the ZB
 * candidates, and the chosen firmware/data file pair.
 *
 * This is the helper that makes `nfsx flash --hwnr 7544721` viable
 * — the operator should not have to spell `--ipo` / `--swt` /
 * `--sgbd` / `--working-dir` / `--firmware` when all of that is
 * derivable from KFCONF + the per-SG `.DAT` table + the standard
 * SP-Daten layout.
 *
 * Mirrors WinKFP's coapiKfProgSgD2 setup: KFCONF.ipoFile resolves the
 * target IPO; KFCONF.flashSgbd resolves the SGBD (minus `.PRG`); the
 * SWT IPO comes from `sgdat/00swt*.ipo` keyed by transport (currently
 * a single-file glob — E46 only ships `00swtds2.ipo`).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  findByHwNr,
  findByZbNr,
  type KfConfRow,
  type ZbNrTabRow,
} from '@emdzej/nfsx-data-files';
import {
  loadZbNrTabForSg,
  loadSpDatenFromDir,
  type SpDaten,
} from './load.js';
import { resolveByHwnr, resolveUpgrade } from './resolve.js';

/**
 * Everything the CLI / FlashSession need, derived from `--hwnr` alone
 * (plus optional selectors).
 */
export interface FlashContext {
  /** SP-Daten root used to derive paths. */
  spDatenRoot: string;
  /** The queried HWNR (echoed back). */
  hwnr: string;
  /** SG short name from HWNR.DA2 (and the KFCONF join key). */
  sgTyp: string;
  /** Selected KFCONF row (first if multiple variants — see `kfConfCandidates`). */
  kfConfRow: KfConfRow;
  /** All KFCONF rows for the SG_TYP (when there are coding variants). */
  kfConfCandidates: KfConfRow[];

  /** Absolute path to the target IPO under `<sp>/sgdat/`. */
  ipoPath: string;
  /** SGBD basename for the runtime (KFCONF.flashSgbd minus `.PRG`). */
  sgbd: string;
  /** Absolute path to the SWT IPO under `<sp>/sgdat/`. */
  swtIpoPath: string;
  /** Absolute path to the per-SG working directory `<sp>/data/<SG_TYP>/`. */
  workingDir: string;

  /** All ZB rows in `<SG_TYP>.DAT` that match this HWNR. */
  zbCandidates: ZbNrTabRow[];
  /** The chosen ZB row (default: the first; or the one matching `--zb`). */
  selectedZb: ZbNrTabRow;
  /** Absolute path to the chosen ZB's `.0PA` (program firmware). */
  firmwarePath: string;
  /** Absolute path to the chosen ZB's `.0DA` (calibration), if any. */
  dataFilePath?: string;

  /** True when an NPV upgrade rule pointed to a different ZB than the one currently burned. */
  npvUpgrade?: {
    zbAlt: string;
    zbNeu: string;
    npSw: string;
  };
}

export interface ResolveFlashContextOptions {
  /** Pre-loaded SpDaten (avoid re-parsing on repeat calls). */
  spDaten?: SpDaten;
  /** Pick a specific ZB row (otherwise: NPV-upgrade-of `zbAlt` if set, else first match). */
  zb?: string;
  /** Currently-burned ZB (e.g. from `SG_AIF_LESEN`'s `AIF_ZB_NR`); enables NPV upgrade lookup. */
  zbAlt?: string;
  /** Override the SWT IPO path (skip the auto-glob). */
  swtIpoPath?: string;
  /**
   * Filter the `00swt*.ipo` glob to one matching this transport tag.
   * Common values: `ds2`, `kwp`, `kws`, `dsc`. Case-insensitive.
   * Only consulted when there are multiple `00swt*.ipo` files.
   */
  transport?: string;
  /** Pick a specific KFCONF row by zero-based index (default 0). */
  kfConfIndex?: number;
}

export class FlashContextError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unknown_hwnr'
      | 'no_kfconf'
      | 'no_dat'
      | 'no_zb_for_hwnr'
      | 'zb_not_found'
      | 'ambiguous_zb'
      | 'no_swt_ipo'
      | 'ambiguous_swt_ipo'
      | 'missing_firmware',
  ) {
    super(message);
    this.name = 'FlashContextError';
  }
}

/**
 * Resolve everything from HWNR. Throws `FlashContextError` when the
 * inputs can't pin down a flashable target; the CLI translates these
 * into actionable error messages.
 */
export function resolveFlashContext(
  spDatenRoot: string,
  hwnr: string,
  options: ResolveFlashContextOptions = {},
): FlashContext {
  const sp = options.spDaten ?? loadSpDatenFromDir(spDatenRoot);

  const candidates = resolveByHwnr(sp, hwnr);
  if (candidates.length === 0) {
    throw new FlashContextError(
      `HWNR ${hwnr} not in HWNR.DA2 under ${spDatenRoot}/gdaten/`,
      'unknown_hwnr',
    );
  }
  // resolveByHwnr already dedupes by SG_TYP. If multiple SG_TYPs share
  // an HWNR we just pick the first that has a KFCONF row.
  const candidate = candidates.find((c) => c.kfConfRows.length > 0) ?? candidates[0]!;
  const sgTyp = candidate.sgTyp;

  if (candidate.kfConfRows.length === 0) {
    throw new FlashContextError(
      `SG_TYP ${sgTyp} has no KFCONF row — not flashable in this SP-Daten drop`,
      'no_kfconf',
    );
  }

  const kfIndex = options.kfConfIndex ?? 0;
  const kfConfRow = candidate.kfConfRows[kfIndex];
  if (!kfConfRow) {
    throw new FlashContextError(
      `KFCONF row #${kfIndex} out of range (have ${candidate.kfConfRows.length})`,
      'no_kfconf',
    );
  }

  const ipoPath = resolvePath(spDatenRoot, 'sgdat', kfConfRow.ipoFile);
  const sgbd = stripPrgExt(kfConfRow.flashSgbd);
  const workingDir = resolvePath(spDatenRoot, 'data', sgTyp);
  const swtIpoPath = options.swtIpoPath
    ? resolvePath(options.swtIpoPath)
    : resolveSwtIpo(spDatenRoot, options.transport);

  const tab = loadZbNrTabForSg(spDatenRoot, sgTyp, kfConfRow.datFile);
  if (!tab) {
    throw new FlashContextError(
      `Missing per-SG mapping table: ${spDatenRoot}/data/${sgTyp}/${kfConfRow.datFile}`,
      'no_dat',
    );
  }
  const zbCandidates = findByHwNr(tab, hwnr);
  if (zbCandidates.length === 0) {
    throw new FlashContextError(
      `HWNR ${hwnr} not in ${kfConfRow.datFile} — SP-Daten doesn't list this part`,
      'no_zb_for_hwnr',
    );
  }

  // NPV upgrade resolution: if caller supplied the currently-burned ZB
  // (zbAlt), check npv.dat for an upgrade rule and prefer the target.
  let npvUpgrade: FlashContext['npvUpgrade'] | undefined;
  if (options.zbAlt) {
    const upgrade = resolveUpgrade(sp, options.zbAlt);
    if (upgrade) {
      npvUpgrade = { zbAlt: options.zbAlt, zbNeu: upgrade.zbNeu, npSw: upgrade.npSw };
    }
  }

  // ZB selection priority:
  //   1. explicit --zb
  //   2. NPV upgrade target (zb-alt → zb-neu via npv.dat)
  //   3. single-candidate auto-pick
  //   4. otherwise error — the operator MUST pick
  let selectedZbNr: string | undefined;
  if (options.zb) selectedZbNr = options.zb;
  else if (npvUpgrade) selectedZbNr = npvUpgrade.zbNeu;
  else if (zbCandidates.length === 1) selectedZbNr = zbCandidates[0]!.zbNr;
  else {
    const list = zbCandidates
      .map((r) => `${r.zbNr} (CS=${r.csRaw} S=${r.s})`)
      .join(', ');
    throw new FlashContextError(
      `HWNR ${hwnr} has ${zbCandidates.length} ZB candidates in ${kfConfRow.datFile}: ${list}. Pass --zb <number> or --zb-alt <currently-burned-ZB> to resolve.`,
      'ambiguous_zb',
    );
  }

  const selectedZb =
    findByZbNr(tab, selectedZbNr) ??
    zbCandidates.find((r) => r.zbNr === selectedZbNr);
  if (!selectedZb) {
    throw new FlashContextError(
      `ZB ${selectedZbNr} not in ${kfConfRow.datFile}` +
        (npvUpgrade ? ` (NPV pointed here from ZB ${npvUpgrade.zbAlt})` : ''),
      'zb_not_found',
    );
  }

  const firmwarePath = resolvePath(workingDir, selectedZb.programFile);
  if (!existsSync(firmwarePath)) {
    throw new FlashContextError(
      `Firmware not on disk: ${firmwarePath}`,
      'missing_firmware',
    );
  }

  const ctx: FlashContext = {
    spDatenRoot,
    hwnr,
    sgTyp,
    kfConfRow,
    kfConfCandidates: candidate.kfConfRows,
    ipoPath,
    sgbd,
    swtIpoPath,
    workingDir,
    zbCandidates,
    selectedZb,
    firmwarePath,
  };
  if (selectedZb.dataFile) {
    ctx.dataFilePath = resolvePath(workingDir, selectedZb.dataFile);
  }
  if (npvUpgrade) ctx.npvUpgrade = npvUpgrade;
  return ctx;
}

/**
 * Lite resolver for read-only operations (backup / verify) that need
 * IPO + SGBD + working-dir but don't pick a ZB to flash.
 *
 * Same lookup chain as `resolveFlashContext` but stops before ZB
 * selection, so multi-ZB HWNRs don't error out.
 */
export interface FlashContextLite {
  spDatenRoot: string;
  hwnr: string;
  sgTyp: string;
  kfConfRow: KfConfRow;
  ipoPath: string;
  sgbd: string;
  workingDir: string;
}

export function resolveFlashContextLite(
  spDatenRoot: string,
  hwnr: string,
  options: Pick<ResolveFlashContextOptions, 'spDaten' | 'kfConfIndex'> = {},
): FlashContextLite {
  const sp = options.spDaten ?? loadSpDatenFromDir(spDatenRoot);

  const candidates = resolveByHwnr(sp, hwnr);
  if (candidates.length === 0) {
    throw new FlashContextError(
      `HWNR ${hwnr} not in HWNR.DA2 under ${spDatenRoot}/gdaten/`,
      'unknown_hwnr',
    );
  }
  const candidate = candidates.find((c) => c.kfConfRows.length > 0) ?? candidates[0]!;
  const sgTyp = candidate.sgTyp;
  if (candidate.kfConfRows.length === 0) {
    throw new FlashContextError(
      `SG_TYP ${sgTyp} has no KFCONF row — not flashable in this SP-Daten drop`,
      'no_kfconf',
    );
  }

  const kfIndex = options.kfConfIndex ?? 0;
  const kfConfRow = candidate.kfConfRows[kfIndex];
  if (!kfConfRow) {
    throw new FlashContextError(
      `KFCONF row #${kfIndex} out of range (have ${candidate.kfConfRows.length})`,
      'no_kfconf',
    );
  }

  const ipoPath = resolvePath(spDatenRoot, 'sgdat', kfConfRow.ipoFile);
  const sgbd = stripPrgExt(kfConfRow.flashSgbd);
  const workingDir = resolvePath(spDatenRoot, 'data', sgTyp);

  return { spDatenRoot, hwnr, sgTyp, kfConfRow, ipoPath, sgbd, workingDir };
}

function stripPrgExt(s: string): string {
  return s.replace(/\.PRG$/i, '');
}

/**
 * Pick the right `00swt*.ipo` from `<sp>/sgdat/`. Strategy:
 *   - glob `00swt*.ipo` (case-insensitive)
 *   - if exactly one match → use it
 *   - if multiple and `transport` given → match `00swt<transport>.ipo`
 *   - otherwise → throw (operator must pass `--swt` / `--transport`)
 */
function resolveSwtIpo(spDatenRoot: string, transport?: string): string {
  const sgdat = resolvePath(spDatenRoot, 'sgdat');
  if (!existsSync(sgdat)) {
    throw new FlashContextError(`Missing sgdat directory: ${sgdat}`, 'no_swt_ipo');
  }
  const all = readdirSync(sgdat);
  const swts = all.filter((f) => /^00swt[a-z0-9_]*\.ipo$/i.test(f));
  if (swts.length === 0) {
    throw new FlashContextError(
      `No 00swt*.ipo files in ${sgdat} — FSC stage cannot proceed`,
      'no_swt_ipo',
    );
  }
  if (swts.length === 1) return join(sgdat, swts[0]!);

  if (transport) {
    const wanted = `00swt${transport.toLowerCase()}.ipo`;
    const hit = swts.find((f) => f.toLowerCase() === wanted);
    if (hit) return join(sgdat, hit);
    throw new FlashContextError(
      `--transport=${transport} not found; available: ${swts.join(', ')}`,
      'ambiguous_swt_ipo',
    );
  }
  throw new FlashContextError(
    `Multiple 00swt*.ipo files in ${sgdat} (${swts.join(', ')}); pass --transport <name> or --swt <path>`,
    'ambiguous_swt_ipo',
  );
}
