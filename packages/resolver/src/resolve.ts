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

import type { HwnrRow, KfConfRow, KmmSitRow } from '@emdzej/nfsx-data-files';
import type { SpDaten } from './load.js';

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
    // shortName, or vice versa). We expose the SIT row alone for
    // now.
    out.push({
      sgTyp: sit.shortName,
      hwnrRows: [],
      kfConfRows: [],
      sit,
    });
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

  const candidate: FlashCandidate = {
    sgTyp,
    hwnrRows,
    kfConfRows,
    sit,
  };
  if (hwnr !== undefined) candidate.hwnr = hwnr;
  return candidate;
}
