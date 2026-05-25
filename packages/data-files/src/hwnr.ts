/**
 * `HWNR.DA2` parser — Hardware-Nummer → SG_TYP lookup table.
 *
 * The entry-point of the flash-planning lookup chain. Given a
 * part number that came from an ECU's IDENT response (or from a
 * user typing it in), resolve to the SG_TYP short name that
 * `KFCONF10.DA2` is keyed by.
 *
 * Source format (verified against `~/Downloads/E46_v74/data/gdaten/HWNR.DA2`,
 * 3763 data rows on E46):
 *
 *   ;Hardwaredatei vom 24.04.2009 10:17        ← file header comment
 *   ;HWNR    AT_HWNR EP_TSNR SG_TYP            ← column-name comment
 *   ;--------------------------                 ← visual separator
 *   ;$SG ACC65                                  ← section marker (still a comment)
 *   4010581,0000000,0000000,ACC65
 *   4011919,0000000,0000000,ACC65
 *   ;--------------------------
 *   ;$SG AFS60
 *   4011118,0000000,0000000,AFS60
 *
 * - `;` introduces a full-line comment (even when the comment has
 *   semantic meaning like `;$SG <name>` — we extract those as
 *   section markers but they're still on a `;`-prefixed line).
 * - Data rows are **4 comma-separated fields**:
 *     0. HWNR    — Hardware-Nummer (7-digit decimal, the
 *                  primary lookup key on the ECU's label)
 *     1. AT_HWNR — Austauschteil-HWNR (replacement-part HWNR, often
 *                  `0000000` when no AT exists)
 *     2. EP_TSNR — Ersatzteil-Teilesachnummer (spare-part #, also
 *                  often `0000000`)
 *     3. SG_TYP  — SG short name (space-padded to fixed width for
 *                  display, trimmed by us)
 *
 * Columns are stable across BMW SP-Daten generations — same shape
 * in every drop we've sampled.
 */

import { iterLines, type TextLine } from './lexer.js';

export interface HwnrRow {
  /** Hardware-Nummer (7-digit decimal). The primary lookup key. */
  hwnr: string;
  /** Austauschteil-HWNR. Often `"0000000"` (= absent). */
  atHwnr: string;
  /** Ersatzteil-Teilesachnummer. Often `"0000000"`. */
  epTsnr: string;
  /** SG short name — trimmed of the source's space padding. */
  sgTyp: string;
  /** 1-based source line number. */
  lineNo: number;
}

export interface HwnrFile {
  /** Top-of-file `;Hardwaredatei vom ...` comment, if present. */
  header: string | undefined;
  /** Data rows in file order. */
  rows: HwnrRow[];
  /**
   * Per-SG_TYP index for O(1) reverse lookups (SG_TYP → all HWNRs
   * registered for that SG). Built once at parse time.
   */
  bySgTyp: Map<string, HwnrRow[]>;
  /**
   * Per-HWNR index for forward lookups. **Multi-valued** — a single
   * HWNR can be registered under multiple SG_TYP variants (real
   * E46 data: `4463157` is both EK726 and EK726L — different
   * software-feature variants of the same physical ECU family).
   * The planner disambiguates using other inputs (FA, current
   * software version, etc.).
   *
   * Within a single SG_TYP, duplicate HWNRs silently collapse
   * (BMW sometimes lists the same row twice — also benign).
   */
  byHwnr: Map<string, HwnrRow[]>;
  /** Lines we couldn't parse. */
  unparsed: { lineNo: number; raw: string; reason: string }[];
}

const SECTION_MARKER = /^;\s*\$SG\s+(\S+)/;

export function parseHwnr(content: string): HwnrFile {
  const rows: HwnrRow[] = [];
  const bySgTyp = new Map<string, HwnrRow[]>();
  const byHwnr = new Map<string, HwnrRow[]>();
  const unparsed: HwnrFile['unparsed'] = [];
  let header: string | undefined;

  // Track the current section so we can sanity-check rows against
  // their declared `;$SG <name>` block — when a row's SG_TYP
  // doesn't match the surrounding section, that's a data error in
  // the source file that we want to surface.
  let currentSection: string | undefined;

  for (const line of iterLines(content, ';')) {
    if (line.trimmed.length === 0) continue;

    if (line.trimmed.startsWith(';')) {
      if (header === undefined && line.trimmed.length > 1 && !line.trimmed.startsWith(';-')) {
        header = line.trimmed.replace(/^;\s*/, '');
      }
      const sectionMatch = line.trimmed.match(SECTION_MARKER);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
      }
      continue;
    }

    parseRow(line, currentSection, rows, bySgTyp, byHwnr, unparsed);
  }

  return { header, rows, bySgTyp, byHwnr, unparsed };
}

function parseRow(
  line: TextLine,
  currentSection: string | undefined,
  rows: HwnrRow[],
  bySgTyp: Map<string, HwnrRow[]>,
  byHwnr: Map<string, HwnrRow[]>,
  unparsed: HwnrFile['unparsed'],
): void {
  const fields = line.trimmed.split(',').map((f) => f.trim());

  if (fields.length !== 4) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `expected 4 fields, got ${fields.length}`,
    });
    return;
  }

  const [hwnr, atHwnr, epTsnr, sgTyp] = fields as [string, string, string, string];

  if (!/^\d+$/.test(hwnr)) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `HWNR is not numeric: "${hwnr}"`,
    });
    return;
  }

  if (sgTyp.length === 0) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: 'SG_TYP is empty',
    });
    return;
  }

  // Section / row mismatch — surface so a corrupt file gets caught
  // early. Not fatal: the row still parses, we just log it.
  if (currentSection !== undefined && currentSection !== sgTyp) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `row SG_TYP "${sgTyp}" doesn't match section "${currentSection}"`,
    });
    // Don't return — the row is still salvageable for the indices.
  }

  // Duplicate HWNR policy: real E46 HWNR.DA2 has both shapes of
  // duplicate:
  //   - Same SG_TYP (~4 cases) — BMW listed the same row twice,
  //     benign, silently collapse.
  //   - Different SG_TYP (~hundreds of cases like EK726/EK726L/
  //     EK726M sharing parts) — legitimate multi-mapping, the same
  //     physical part number works in several software variants.
  //     We accept these and accumulate into the multi-valued
  //     `byHwnr` bucket. The planner uses other context (FA,
  //     current SW) to pick the right SG_TYP at flash time.
  const existingBucket = byHwnr.get(hwnr);
  if (existingBucket?.some((e) => e.sgTyp === sgTyp)) {
    // Already have this exact (HWNR, SG_TYP) — silently skip.
    return;
  }

  const row: HwnrRow = { hwnr, atHwnr, epTsnr, sgTyp, lineNo: line.lineNo };
  rows.push(row);
  if (existingBucket) {
    existingBucket.push(row);
  } else {
    byHwnr.set(hwnr, [row]);
  }
  let bucket = bySgTyp.get(sgTyp);
  if (!bucket) {
    bucket = [];
    bySgTyp.set(sgTyp, bucket);
  }
  bucket.push(row);
}
