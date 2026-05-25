/**
 * `npv.dat` parser — Nachprogrammier-Vorschrift (re-programming
 * prescription) / ZB-Nummer upgrade table.
 *
 * The "you have ZB X, here's what you flash it to" lookup. Used by
 * the planner to compute the upgrade path: given the current
 * ZB-Nummer the ECU returned during IDENT, find the target
 * ZB-NEU + NP-SW version + flash mask.
 *
 * Source format (verified against `~/Downloads/E46_v74/data/gdaten/npv.dat`):
 *
 *   ;Zusbauvorschrift für NP Kaltstart M50TUE
 *   ;mit Logistik MS40.0 May & Christie
 *   ;Erstellt mit NAP100.PRG V1.00/16.9.94
 *   ;ZB-ALT,ZB-NEU ,NP-SW    ,AM         ,S,M CS
 *   1703643,1744493,1427105NA,1FFFFFFFFFD,1,1 6
 *   1703645,1744495,1427106NA,1FFFFFFFFFD,1,1 H
 *
 * - `;` line comments (a few header comments + the column legend).
 * - Comma-separated rows with 6 fields.
 * - Last field is space-separated: `M CS` where `M` is a numeric
 *   module flag and `CS` is the row checksum (single hex digit or
 *   letter — e.g. `6`, `H`, `2`, `M`, `Z`).
 *
 * Field layout:
 *
 *   0. ZB-ALT   — current ZB-Nummer on the ECU (7-digit)
 *   1. ZB-NEU   — target ZB-Nummer after flash (7-digit)
 *   2. NP-SW    — Nachprogrammier-Software identifier (7-digit + suffix)
 *   3. AM       — Applikations-Maske (11-hex flash mask)
 *   4. S        — Status flag (single digit)
 *   5. M + CS   — Module flag (digit) + checksum char, space-separated
 */

import { iterLines, parseIntOpt, type TextLine } from './lexer.js';

export interface NpvRow {
  /** Current ZB-Nummer on the ECU (the lookup key). */
  zbAlt: string;
  /** Target ZB-Nummer after the flash. */
  zbNeu: string;
  /** NP-SW (Nachprogrammier-Software) identifier, e.g. `1427105NA`. */
  npSw: string;
  /** Applikations-Maske — hex flash-region mask. */
  am: string;
  /** Status flag (parsed as int when single digit). */
  s: number | undefined;
  /** Module flag (parsed as int when single digit). */
  m: number | undefined;
  /** Row checksum character (single char, can be hex digit or letter). */
  cs: string;
  /** All 6 raw fields verbatim. */
  raw: string[];
  /** 1-based source line number. */
  lineNo: number;
}

export interface NpvFile {
  /**
   * Header `;` comment lines collected in source order. The first
   * one is typically the `Zusbauvorschrift` title; downstream the
   * `;ZB-ALT,…` column legend is treated as a comment too.
   */
  comments: string[];
  rows: NpvRow[];
  /** ZB-ALT → row index. ZB-ALT is the canonical lookup key. */
  byZbAlt: Map<string, NpvRow>;
  unparsed: { lineNo: number; raw: string; reason: string }[];
}

const EXPECTED_FIELDS = 6;

export function parseNpv(content: string): NpvFile {
  const comments: string[] = [];
  const rows: NpvRow[] = [];
  const byZbAlt = new Map<string, NpvRow>();
  const unparsed: NpvFile['unparsed'] = [];

  for (const line of iterLines(content, ';')) {
    if (line.trimmed.length === 0) continue;
    if (line.trimmed.startsWith(';')) {
      comments.push(line.trimmed.replace(/^;\s*/, ''));
      continue;
    }
    parseRow(line, rows, byZbAlt, unparsed);
  }

  return { comments, rows, byZbAlt, unparsed };
}

function parseRow(
  line: TextLine,
  rows: NpvRow[],
  byZbAlt: Map<string, NpvRow>,
  unparsed: NpvFile['unparsed'],
): void {
  const fields = line.trimmed.split(',').map((f) => f.trim());

  if (fields.length !== EXPECTED_FIELDS) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `expected ${EXPECTED_FIELDS} fields, got ${fields.length}`,
    });
    return;
  }

  // Last field is `M CS` space-separated. Be lenient — if it's a
  // single token, treat the whole thing as M and leave cs empty.
  const last = fields[5]!.split(/\s+/);
  const mRaw = last[0] ?? '';
  const csRaw = last[1] ?? '';

  if (byZbAlt.has(fields[0]!)) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `duplicate ZB-ALT ${fields[0]} (first seen on line ${byZbAlt.get(fields[0]!)!.lineNo})`,
    });
    return;
  }

  const row: NpvRow = {
    zbAlt: fields[0]!,
    zbNeu: fields[1]!,
    npSw: fields[2]!,
    am: fields[3]!,
    s: parseIntOpt(fields[4]!),
    m: parseIntOpt(mRaw),
    cs: csRaw,
    raw: fields,
    lineNo: line.lineNo,
  };
  rows.push(row);
  byZbAlt.set(row.zbAlt, row);
}
