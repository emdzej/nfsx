/**
 * Per-SG ZB-NR → (HW-NR, SW-NR, ...) mapping table.
 *
 * Each SG family ships a `<SG_TYP>.DAT` file (e.g. `GD20.DAT`) that
 * lists every flashable ZB-Nr (Zusammenbau-Nummer, the assembly part
 * number) and which program + data files apply. This is the table
 * WinKFP consults to answer "given a target ZB, which files do I
 * flash?".
 *
 * Identified in `winkfpt.exe` as `coapiKfReadZbNrTabD2` (at the
 * `s_coapiKfReadZbNrTabD2_005ff6f4` string xref). The function's
 * output struct has 8 fields: TYP-NR, HW-NR, IX, SW-NR (string),
 * AM, PIN (ushort), S (byte), CS (byte). Input key is the ZB-NR.
 *
 * **File format** (verified against `data/GD20/GD20.DAT`):
 *
 * ```
 *   $ PS10INIT N00326DFF00003CF004598403C8500000000000 5
 *   $ VERSIONKFCONF: kfconf10.dat
 *   ;Zusbauvorschrift vom 21.06.2006 10:33
 *   ;SG-TYP: GD20
 *   ;ZB-NR  TYP-NR  HW-NR  IX SW-NR     AM          PIN S CS
 *   7514050,0000000,7508145,A,7514051DA,0FFFFFFFFFD,134,1 1
 *   7514052,0000000,7508145,A,7514053DA,0FFFFFFFFFD,134,1 D
 *   ...
 * ```
 *
 * Rows are comma-separated for 8 fields, then the final segment
 * carries `S CS` as two values separated by a space. Header lines
 * start with `;` or `$`. The column header line is a comment — the
 * strings `ZB-NR` / `HW-NR` / `SW-NR` don't appear in winkfpt.exe,
 * so the file is parsed strictly by position.
 *
 * **Filename conventions** (verified via Ghidra `*.0PA` / `*.0DA`
 * strings at 0x0062f03c / 0x0062f018 + on-disk file matching):
 *
 *   - HW-NR `7544721`     → program file `7544721A.0PA`
 *   - SW-NR `7552755DA`   → data file `A7552755.0DA`
 *     (the trailing `DA` is a literal type tag, not part of the number)
 */

import { iterLines } from './lexer.js';

export interface ZbNrTabRow {
  /** ZB-Nr (assembly part number) — the row key. 7-digit. */
  zbNr: string;
  /** TYP-NR (type number). 7-digit, often `0000000` or `1000000`. */
  typNr: string;
  /** HW-NR (hardware part number) — identifies the `.0PA` program file. */
  hwNr: string;
  /** Index suffix (e.g. `A`). Pairs with HW-NR in the `.0PA` filename. */
  ix: string;
  /**
   * SW-NR as written in the file — typically a 7-digit number + the
   * literal `DA` type-tag suffix (e.g. `7552755DA`). The number alone
   * forms the `.0DA` filename's body (`A<num>.0DA`).
   */
  swNr: string;
  /** AM field. Hex-ish, 11 chars. Purpose TBD. */
  am: string;
  /** PIN field (ushort). */
  pin: number;
  /** S field (byte). */
  s: number;
  /**
   * CS field — appears as a single char in source (`S`, `G`, `D`, `1`, …).
   * WinKFP treats it as a byte (see `coapiKfReadZbNrTabD2` output: `ushort`
   * from `local_2ad`). We expose both:
   *
   *   - `cs`     — base-36 numeric (matches the byte interpretation
   *                for both digits and letters)
   *   - `csRaw`  — the source character verbatim (useful for display
   *                and lossless round-trip)
   */
  cs: number;
  csRaw: string;
  /**
   * Derived: the program file basename in `data/<SG_TYP>/` for this
   * row. Constructed as `<hwNr><ix>.0PA`.
   */
  programFile: string;
  /**
   * Derived: the data file basename in `data/<SG_TYP>/` for this row.
   * Constructed as `A<swNr-without-DA-suffix>.0DA`. `undefined` when
   * the SW-NR doesn't carry the canonical `DA` tag (we surface but
   * don't synthesize a filename in that case).
   */
  dataFile?: string;
  /** 1-based source line number. */
  lineNumber: number;
  /** Raw source line (without trailing newline). */
  raw: string;
}

export interface ZbNrTabFile {
  /** `$ <key>: <value>` directives from the header. */
  directives: Record<string, string>;
  /** Free-form comments captured for downstream display. */
  comments: string[];
  rows: ZbNrTabRow[];
  /** Lines we couldn't classify. */
  skipped: Array<{ lineNumber: number; reason: string; line: string }>;
}

/** Parse a `<SG_TYP>.DAT` file. Accepts string or `Uint8Array` (ASCII). */
export function parseZbNrTab(input: string | Uint8Array): ZbNrTabFile {
  const text = typeof input === 'string' ? input : decodeAscii(input);
  const directives: Record<string, string> = {};
  const comments: string[] = [];
  const rows: ZbNrTabRow[] = [];
  const skipped: ZbNrTabFile['skipped'] = [];

  for (const { lineNo, raw, trimmed } of iterLines(text, ';')) {
    if (trimmed === '') continue;

    if (trimmed.startsWith('$')) {
      const m = /^\$\s*([A-Z0-9_]+)\s*:?\s*(.*)$/.exec(trimmed);
      if (m) directives[m[1]!] = m[2]!.trim();
      continue;
    }

    if (trimmed.startsWith(';')) {
      comments.push(trimmed.slice(1).trim());
      continue;
    }

    const parsed = parseRow(trimmed, lineNo, raw);
    if ('error' in parsed) {
      skipped.push({ lineNumber: lineNo, reason: parsed.error, line: raw });
      continue;
    }
    rows.push(parsed.row);
  }

  return { directives, comments, rows, skipped };
}

/**
 * Lookup helper: rows matching the given HW-NR. A single HW-NR can
 * appear in multiple rows (different ZB assemblies that share the
 * same hardware revision) — that's the common case.
 */
export function findByHwNr(table: ZbNrTabFile, hwNr: string): ZbNrTabRow[] {
  return table.rows.filter((r) => r.hwNr === hwNr);
}

/** Lookup helper: a single row matching the given ZB-NR, or `undefined`. */
export function findByZbNr(table: ZbNrTabFile, zbNr: string): ZbNrTabRow | undefined {
  return table.rows.find((r) => r.zbNr === zbNr);
}

function parseRow(
  line: string,
  lineNumber: number,
  raw: string,
): { row: ZbNrTabRow } | { error: string } {
  // The format is comma-separated for 8 fields, with a space inside
  // the last field separating S and CS. Splitting on `,` gives 8
  // segments; the last segment is "S CS" with a space.
  const parts = line.split(',');
  if (parts.length !== 8) {
    return { error: `expected 8 comma-separated fields, got ${parts.length}` };
  }
  const [zbNr, typNr, hwNr, ix, swNr, am, pinStr, sCsStr] = parts.map((p) => p.trim()) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const pin = Number.parseInt(pinStr, 10);
  if (!Number.isFinite(pin)) return { error: `invalid PIN: "${pinStr}"` };

  const sCsParts = sCsStr.split(/\s+/);
  if (sCsParts.length !== 2) return { error: `expected "S CS" in trailing field, got "${sCsStr}"` };
  const s = Number.parseInt(sCsParts[0]!, 10);
  // CS is sometimes a numeral, sometimes a single letter (`A`/`D`/`M`...). Treat as base-36
  // so single-char alpha codes parse uniformly; fall back to 0 only if truly garbage.
  let cs = Number.parseInt(sCsParts[1]!, 36);
  if (!Number.isFinite(cs)) cs = 0;
  if (!Number.isFinite(s)) return { error: `invalid S: "${sCsParts[0]}"` };

  const programFile = `${hwNr}${ix}.0PA`;
  // SW-NR carries a literal `DA` type tag (BMW convention); strip it
  // to get the bare number used in the `A<num>.0DA` filename.
  const dataFile = /^(.+?)DA$/i.test(swNr) ? `A${swNr.replace(/DA$/i, '')}.0DA` : undefined;

  return {
    row: {
      zbNr,
      typNr,
      hwNr,
      ix,
      swNr,
      am,
      pin,
      s,
      cs,
      csRaw: sCsParts[1]!,
      programFile,
      dataFile,
      lineNumber,
      raw,
    },
  };
}

function decodeAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}
