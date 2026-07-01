/**
 * The lookup-chain resolver. Joins HWNR.DA2 + KFCONF10.DA2 + kmm_SIT.txt
 * into composite "flash candidates" — what the planner needs to know
 * about an ECU before generating a CPlanElement.
 *
 * Anchor: docs/architecture.md §9.1 (the visualised chain).
 *
 *   HWNR  →  bySgTyp (multi-valued)
 *           ↓
 *         SG_TYP  →  KFCONF rows (variants by coding-index)
 *                   ↓
 *                 IPO + Flash SGBD + working files
 *                   ↓
 *                 kmm_SIT (optional; transport + flash-limit per
 *                          DiagAddr; not all SG_TYPs have a SIT row)
 *
 * The resolver tolerates partial data: when a SIT row is missing it
 * returns the candidate without transport/flash-limit context, and
 * the consumer decides whether to proceed.
 */

import type {
  HwnrRow,
  KfConfRow,
  KmmSitRow,
  NpvRow,
  PrgIfSelRow,
  SgIdEntry,
} from '@emdzej/nfsx-data-files';
import type { SpDaten } from './types.js';

export interface FlashCandidate {
  /**
   * The Hardware-Nummer this candidate was resolved from. `undefined`
   * when entry was by SG_TYP — i.e. the user knows the SG short name
   * but doesn't have a specific HWNR yet.
   */
  hwnr?: string;
  /** SG short name (the join key). */
  sgTyp: string;
  /**
   * All HWNR.DA2 rows that map to this SG_TYP — useful when the
   * caller wants to see all part numbers that fit (e.g. for a UI
   * dropdown of "compatible ECUs").
   */
  hwnrRows: HwnrRow[];
  /**
   * All KFCONF10.DA2 rows for this SG_TYP — multi-valued because
   * some SGs have several coding-index variants (different
   * `variantHex` per row).
   */
  kfConfRows: KfConfRow[];
  /**
   * The kmm_SIT.txt row that describes the runtime configuration
   * for this SG, if any. May be undefined when:
   *   - the SP-Daten drop's kmm_SIT.txt doesn't cover this ECU
   *     (real E46 only ships a partial SIT — older chassis pattern)
   *   - the SG_TYP doesn't have an entry under any DiagAddr we know
   *
   * When undefined, the caller can't determine transport / flash
   * limit / category from this lookup — those need other sources.
   */
  sit?: KmmSitRow;
  /**
   * SGIDC.AS2 (level 3) entries for this SG_TYP. Multi-valued
   * because some SGs ship multiple key blobs per file. Empty when
   * SGIDC isn't loaded or the SG isn't listed.
   */
  sgIdc: SgIdEntry[];
  /** SGIDD.AS2 (level 4) entries for this SG_TYP. */
  sgIdd: SgIdEntry[];
  /**
   * prgifsel.dat row for this SG, if any. Provides the
   * transport / protocol selection (e.g. KWP2000*, DS2, KWP2000)
   * plus per-protocol parameters. Joined by SG short name —
   * may be undefined when the SG name doesn't match a prgifsel
   * row exactly.
   */
  prgIfSel?: PrgIfSelRow;
}

/**
 * Resolve a part number (HWNR) to one or more `FlashCandidate`s.
 *
 * **Multi-valued** because a single HWNR can map to multiple SG_TYP
 * variants (real E46 data: ~hundreds of cases like EK726 / EK726L /
 * EK726M sharing physical part numbers). The caller picks the right
 * variant using other context (FA codes, current SW version, etc.).
 *
 * Returns an empty array if the HWNR is unknown.
 */
export function resolveByHwnr(spDaten: SpDaten, hwnr: string): FlashCandidate[] {
  if (!spDaten.hwnr) return [];
  const hwnrRows = spDaten.hwnr.byHwnr.get(hwnr);
  if (!hwnrRows || hwnrRows.length === 0) return [];

  const seen = new Set<string>();
  const out: FlashCandidate[] = [];
  for (const row of hwnrRows) {
    if (seen.has(row.sgTyp)) continue;
    seen.add(row.sgTyp);
    out.push(buildCandidate(spDaten, row.sgTyp, hwnr));
  }
  return out;
}

/**
 * Resolve an SG short name directly to a `FlashCandidate` (single,
 * since SG_TYP is the canonical join key). Returns `undefined` when
 * no KFCONF entry exists — meaning this SG_TYP isn't flashable in
 * the current data drop.
 */
export function resolveBySgTyp(spDaten: SpDaten, sgTyp: string): FlashCandidate | undefined {
  if (!spDaten.kfConf?.bySgTyp.has(sgTyp)) return undefined;
  return buildCandidate(spDaten, sgTyp);
}

/**
 * Resolve a `kmm_SIT.txt` diagnostic address to all the SG_TYPs
 * that share it (typically one, but variants may share — e.g. ME9
 * variants on DiagAddr 0x12).
 *
 * SIT is the only table where DiagAddr lives, so this lookup is
 * limited to whatever subset of ECUs the SIT covers. On a partial
 * SIT (real E46 case) this resolves a few dozen ECUs out of
 * hundreds in HWNR.DA2.
 */
export function resolveByDiagAddr(spDaten: SpDaten, diagAddr: number): FlashCandidate[] {
  if (!spDaten.kmmSit) return [];
  const sitRows = spDaten.kmmSit.rows.filter((r) => r.diagAddr === diagAddr);
  const seen = new Set<string>();
  const out: FlashCandidate[] = [];
  for (const sit of sitRows) {
    if (seen.has(sit.shortName)) continue;
    seen.add(sit.shortName);
    // kmm_SIT uses a "shortName" that's the SGBD basename — we
    // don't have a direct join key to SG_TYP, so the consumer of
    // this lookup gets the SIT row + has to bridge to KFCONF
    // through whichever heuristic fits (often SG_TYP starts-with
    // shortName, or vice versa). Route through buildCandidate so
    // the candidate gets the full shape (HWNR rows / KFCONF /
    // SGIDC / SGIDD / prgifsel — mostly empty when shortName ≠
    // SG_TYP, which is fine).
    const candidate = buildCandidate(spDaten, sit.shortName);
    candidate.sit = sit;
    out.push(candidate);
  }
  return out;
}

function buildCandidate(spDaten: SpDaten, sgTyp: string, hwnr?: string): FlashCandidate {
  const hwnrRows = spDaten.hwnr?.bySgTyp.get(sgTyp) ?? [];
  const kfConfRows = spDaten.kfConf?.bySgTyp.get(sgTyp) ?? [];
  // SIT rows aren't keyed by SG_TYP — they're keyed by shortName,
  // which is roughly the SGBD basename. Look for any SIT row whose
  // shortName matches the SG_TYP (case-insensitive). When the
  // mapping is more complex (e.g. KFCONF says SG_TYP=ME9k_4 and
  // SIT has shortName=me9k_4n), this won't find anything — that's
  // fine, the candidate just doesn't have SIT context.
  const sgTypLower = sgTyp.toLowerCase();
  const sit = spDaten.kmmSit?.rows.find((r) => r.shortName.toLowerCase() === sgTypLower);

  // SGIDC / SGIDD use SG_TYP exactly (no case fuzzing needed —
  // these files use the canonical KFCONF spelling).
  const sgIdc = spDaten.sgIdc?.bySgTyp.get(sgTyp) ?? [];
  const sgIdd = spDaten.sgIdd?.bySgTyp.get(sgTyp) ?? [];

  // prgifsel.dat uses SG short names that match the KFCONF SG_TYP
  // in most cases (EK924, EKB924, EK927) but not always (KFCONF
  // ACC65 vs prgifsel may use a slightly different label).
  // Try exact match first, then case-insensitive.
  let prgIfSel = spDaten.prgIfSel?.bySgName.get(sgTyp);
  if (!prgIfSel && spDaten.prgIfSel) {
    for (const row of spDaten.prgIfSel.rows) {
      if (row.sgName.toLowerCase() === sgTypLower) {
        prgIfSel = row;
        break;
      }
    }
  }

  const candidate: FlashCandidate = {
    sgTyp,
    hwnrRows,
    kfConfRows,
    sgIdc,
    sgIdd,
  };
  if (hwnr !== undefined) candidate.hwnr = hwnr;
  if (sit) candidate.sit = sit;
  if (prgIfSel) candidate.prgIfSel = prgIfSel;
  return candidate;
}

/**
 * Resolve a current ZB-Nummer to the upgrade rule in `npv.dat`,
 * if any. Returns the `NpvRow` describing the target ZB-NEU +
 * NP-SW + flash-mask, or undefined when no upgrade exists for
 * this ZB.
 *
 * This is a separate lookup from `resolveByHwnr` / `resolveBySgTyp`
 * because npv keys on the CURRENT ZB-Nummer (read from the ECU via
 * IDENT), not on the part number or short name. The planner
 * typically uses BOTH — `resolveByHwnr` for the IPO/SGBD/transport,
 * `resolveUpgrade` for the target ZB.
 */
export function resolveUpgrade(spDaten: SpDaten, zbAlt: string): NpvRow | undefined {
  return spDaten.npv?.byZbAlt.get(zbAlt);
}
