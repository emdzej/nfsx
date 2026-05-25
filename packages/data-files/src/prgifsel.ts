/**
 * `prgifsel.dat` parser — Programmier-Interface-Selektion table.
 *
 * Per-SG transport selection. Tells the planner which bus
 * interface + protocol + parameters to use when talking to a
 * given ECU during programming. Used after KFCONF resolves the
 * IPO + flash SGBD — this fills in *how* to dispatch the
 * SGBD's apiJobs (which transport, which protocol variant).
 *
 * Source format (verified against `~/Downloads/E46_v74/data/gdaten/prgifsel.dat`):
 *
 *   ; Allgemeine Konfigurationsinfo Deutsch
 *   ; station identifier (e.g.: plant-running number-station name-ip1.1)
 *   ID 1.1-0003-progstatline03-123.123.123.123
 *   ;Beispielzeile
 *   ;SG ECU      Interface Hardware  Information   Protokoll   P1   P2 P3 P4 r r
 *   SG EK924    -         -          -             KWP2000*    -    -  -  -  - -
 *   SG EKB924   -         -          -             KWP2000*    -    -  -  -  - -
 *
 * - `;` line comments (heavy header + example/legend lines).
 * - One `ID <station_id>` line at the top — station identifier.
 * - `SG <name> <interface> <hardware> <information> <protocol> <p1> <p2> <p3> <p4> <r1> <r2>` —
 *   12 whitespace-separated fields per row. Empty values use `-`.
 *   `*` suffix on protocol means "with retry" or "wildcard
 *   variant" (e.g. `KWP2000*`).
 */

import { iterLines, type TextLine } from './lexer.js';

export interface PrgIfSelRow {
  /** SG short name (the lookup key). */
  sgName: string;
  /** Interface name. `-` when unspecified. */
  iface: string;
  /** Hardware name. `-` when unspecified. */
  hardware: string;
  /** Free-form info string. `-` when unspecified. */
  information: string;
  /** Protocol name (e.g. `KWP2000*`, `KWP1281`). */
  protocol: string;
  /** Param 1 — protocol-specific. `-` when unspecified. */
  param1: string;
  param2: string;
  param3: string;
  param4: string;
  /** Reserved field 1 — typically `-`. */
  reserved1: string;
  /** Reserved field 2 — typically `-`. */
  reserved2: string;
  /** All 11 raw fields after the `SG` marker. */
  raw: string[];
  /** 1-based source line number. */
  lineNo: number;
}

export interface PrgIfSelFile {
  /** Station identifier from the `ID …` line, if present. */
  stationId: string | undefined;
  rows: PrgIfSelRow[];
  /** SG name → row index (first occurrence wins). */
  bySgName: Map<string, PrgIfSelRow>;
  unparsed: { lineNo: number; raw: string; reason: string }[];
}

const EXPECTED_FIELDS_AFTER_SG = 11;

export function parsePrgIfSel(content: string): PrgIfSelFile {
  let stationId: string | undefined;
  const rows: PrgIfSelRow[] = [];
  const bySgName = new Map<string, PrgIfSelRow>();
  const unparsed: PrgIfSelFile['unparsed'] = [];

  for (const line of iterLines(content, ';')) {
    if (line.isCommentOrEmpty) continue;

    if (line.trimmed.startsWith('ID ')) {
      const v = line.trimmed.slice(3).trim();
      if (v.length > 0) stationId = v;
      continue;
    }

    if (line.trimmed.startsWith('SG ')) {
      parseSgRow(line, rows, bySgName, unparsed);
      continue;
    }

    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: 'unrecognised line shape (expected `ID …` or `SG …`)',
    });
  }

  return { stationId, rows, bySgName, unparsed };
}

function parseSgRow(
  line: TextLine,
  rows: PrgIfSelRow[],
  bySgName: Map<string, PrgIfSelRow>,
  unparsed: PrgIfSelFile['unparsed'],
): void {
  // Drop the leading "SG " token, then split rest on whitespace.
  const tokens = line.trimmed.split(/\s+/);
  if (tokens[0] !== 'SG') {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: 'row does not start with `SG` marker',
    });
    return;
  }
  const fields = tokens.slice(1);

  if (fields.length !== EXPECTED_FIELDS_AFTER_SG) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `expected ${EXPECTED_FIELDS_AFTER_SG} fields after \`SG\`, got ${fields.length}`,
    });
    return;
  }

  const sgName = fields[0]!;
  if (bySgName.has(sgName)) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `duplicate SG ${sgName} (first seen on line ${bySgName.get(sgName)!.lineNo})`,
    });
    return;
  }

  const row: PrgIfSelRow = {
    sgName,
    iface: fields[1]!,
    hardware: fields[2]!,
    information: fields[3]!,
    protocol: fields[4]!,
    param1: fields[5]!,
    param2: fields[6]!,
    param3: fields[7]!,
    param4: fields[8]!,
    reserved1: fields[9]!,
    reserved2: fields[10]!,
    raw: fields,
    lineNo: line.lineNo,
  };
  rows.push(row);
  bySgName.set(sgName, row);
}
