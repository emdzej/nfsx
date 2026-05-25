/**
 * `KFCONF10.DA2` parser — Kennfeld-Konfiguration, per-SG flash file map.
 *
 * Second step of the lookup chain: given an SG_TYP (e.g. resolved
 * from a HWNR via `HWNR.DA2`), find the IPO + flash SGBD + working
 * files that drive the flash operation for that ECU.
 *
 * Source format (verified against
 * `~/Downloads/E46_v74/data/gdaten/KFCONF10.DA2`):
 *
 *   ;Konfigdatei fuer NPS vom 24.04.2009 10:17
 *   $ VERSIONKFCONF: kfconf10.da2
 *   ;--------------------------
 *   ME QY 29 01 ABS56     00ABS56.IPO   00FLASH.PRG  XXFLKP ABS56.HIS ABS56.DAT A ABS56D.DIR ABS56.HWH
 *   ME LJ 21 01 ACC260    00ACC260.IPO  00FLASH.PRG  XXFLKP ACC260.HIS ACC260.DAT A ACC260D.DIR ACC260.HWH
 *
 * - `;` line comments + `$ <directive>: <value>` for file-level
 *   metadata.
 * - Data rows are **whitespace-separated, 13 fields**:
 *     0.  `ME`        — row marker (constant across the file)
 *     1.  2-char code — looks like a per-row identifier (rev hash?)
 *     2.  2-digit hex — coding-index / variant
 *     3.  2-digit dec — version
 *     4.  SG_TYP      — the lookup key (matches HWNR.DA2's SG_TYP)
 *     5.  IPO file    — e.g. `25ACC65.IPO` (the prefix is a CABD-
 *                       index variant; the loader still picks the
 *                       file by its exact name)
 *     6.  Flash SGBD  — e.g. `02FLASH.PRG` (the wire-protocol driver
 *                       under `EDIABAS/Ecu/`)
 *     7.  `XXFLKP`    — constant marker on every row sampled so far
 *     8.  `.HIS` file — flash history
 *     9.  `.DAT` file — working data
 *    10.  1-char ver  — single uppercase letter
 *    11.  `D.DIR` file — directory file (suffix `D.DIR`)
 *    12.  `.HWH` file — hardware hash
 *
 * The source heavily pads fields with spaces for visual alignment;
 * we collapse runs of whitespace into a single delimiter.
 */

import { iterLines, type TextLine } from './lexer.js';

export interface KfConfRow {
  /** Row marker. Always `"ME"` in samples — kept for forward compat. */
  marker: string;
  /** Per-row 2-char code (revision / hash). */
  code: string;
  /** Coding-index / variant byte (2 hex digits). */
  variantHex: string;
  /** Variant version (2 dec digits). */
  version: string;
  /** SG short name — the join key to `HWNR.DA2`. */
  sgTyp: string;
  /** IPO filename to load (e.g. `"25ACC65.IPO"`). Lives in `SGDAT/`. */
  ipoFile: string;
  /** Flash SGBD filename (e.g. `"02FLASH.PRG"`). Lives in `EDIABAS/Ecu/`. */
  flashSgbd: string;
  /** Control marker (constant `"XXFLKP"` in samples). */
  control: string;
  /** History file (e.g. `"ACC65.HIS"`). */
  hisFile: string;
  /** Working data file (e.g. `"ACC65.DAT"`). */
  datFile: string;
  /** Single-letter version tag. */
  versionTag: string;
  /** Directory file (e.g. `"ACC65D.DIR"`). */
  dirFile: string;
  /** Hardware-hash file (e.g. `"ACC65.HWH"`). */
  hwhFile: string;
  /** All 13 raw whitespace-separated fields. */
  raw: string[];
  /** 1-based source line number. */
  lineNo: number;
}

export interface KfConfFile {
  /** Top-of-file `;Konfigdatei fuer ...` header. */
  header: string | undefined;
  /**
   * File-level `$ KEY: value` directives. The version directive
   * (`VERSIONKFCONF: kfconf10.da2`) is the canonical one.
   */
  directives: Map<string, string>;
  rows: KfConfRow[];
  /** SG_TYP → row index. Multi-value because some SG_TYPs have
   * multiple variants (different `variantHex` / `version`). */
  bySgTyp: Map<string, KfConfRow[]>;
  unparsed: { lineNo: number; raw: string; reason: string }[];
}

const EXPECTED_FIELDS = 13;
const DIRECTIVE_RE = /^\$\s+([A-Z_][A-Z0-9_]*)\s*:\s*(.*?)\s*$/;

export function parseKfConf(content: string): KfConfFile {
  const rows: KfConfRow[] = [];
  const bySgTyp = new Map<string, KfConfRow[]>();
  const directives = new Map<string, string>();
  const unparsed: KfConfFile['unparsed'] = [];
  let header: string | undefined;

  for (const line of iterLines(content, ';')) {
    if (line.trimmed.length === 0) continue;

    if (line.trimmed.startsWith(';')) {
      if (header === undefined && line.trimmed.length > 1 && !line.trimmed.startsWith(';-')) {
        header = line.trimmed.replace(/^;\s*/, '');
      }
      continue;
    }

    if (line.trimmed.startsWith('$')) {
      const m = line.trimmed.match(DIRECTIVE_RE);
      if (m) {
        directives.set(m[1]!, m[2]!);
      } else {
        unparsed.push({
          lineNo: line.lineNo,
          raw: line.raw,
          reason: 'unparseable $-directive line',
        });
      }
      continue;
    }

    parseRow(line, rows, bySgTyp, unparsed);
  }

  return { header, directives, rows, bySgTyp, unparsed };
}

function parseRow(
  line: TextLine,
  rows: KfConfRow[],
  bySgTyp: Map<string, KfConfRow[]>,
  unparsed: KfConfFile['unparsed'],
): void {
  // The source uses runs of spaces for visual padding — collapse to
  // single-delimiter via split-on-whitespace.
  const fields = line.trimmed.split(/\s+/);

  if (fields.length !== EXPECTED_FIELDS) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `expected ${EXPECTED_FIELDS} fields, got ${fields.length}`,
    });
    return;
  }

  const row: KfConfRow = {
    marker: fields[0]!,
    code: fields[1]!,
    variantHex: fields[2]!,
    version: fields[3]!,
    sgTyp: fields[4]!,
    ipoFile: fields[5]!,
    flashSgbd: fields[6]!,
    control: fields[7]!,
    hisFile: fields[8]!,
    datFile: fields[9]!,
    versionTag: fields[10]!,
    dirFile: fields[11]!,
    hwhFile: fields[12]!,
    raw: fields,
    lineNo: line.lineNo,
  };

  rows.push(row);
  let bucket = bySgTyp.get(row.sgTyp);
  if (!bucket) {
    bucket = [];
    bySgTyp.set(row.sgTyp, bucket);
  }
  bucket.push(row);
}
