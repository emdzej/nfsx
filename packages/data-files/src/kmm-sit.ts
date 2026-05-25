/**
 * `kmm_SIT.txt` parser — KMM "Situation" table.
 *
 * One row per ECU short-name × DiagAddr pair, describing how the
 * planner should treat that ECU during a flash session. KmmSrv's
 * `kmmInitialize.c` reads this on startup; the `# Unknown diagAddr
 * %02X in kmm_SIT.txt, ignored.\n` assertion in `KmmSrv.dll`
 * confirms field 0 is a hex DiagAddr.
 *
 * Source format (verified against `~/Downloads/E46_v74/kmmData/kmm_SIT.txt`):
 *
 *   - Plain text, CRLF or LF line endings
 *   - `#` introduces a full-line comment (and is heavily used for
 *     section headers like `# M o t o r s t e u e r g e r a e t e`)
 *   - Each data row is **16 semicolon-separated fields**
 *   - Fields 12 + 13 are commonly empty (placeholder for category-
 *     specific values we haven't seen populated yet)
 *
 * Example row:
 *
 *     12;me9_4n;d_0012;MehrfachHwSNr;AIFLesen;1;14;KLINE;1000;1;MOT;60;;;0;80
 *      ^   ^      ^         ^            ^      ^ ^   ^    ^  ^  ^  ^  ^^ ^  ^
 *      |   |      |         |            |      | |   |    |  |  |  |  || |  +-- field 15
 *      |   |      |         |            |      | |   |    |  |  |  |  |+--- field 14 (flag)
 *      |   |      |         |            |      | |   |    |  |  |  |  +---- field 13 (empty)
 *      |   |      |         |            |      | |   |    |  |  |  +------- field 12 (empty)
 *      |   |      |         |            |      | |   |    |  |  +---------- field 11
 *      |   |      |         |            |      | |   |    |  +------------- category (MOT, KAR, ...)
 *      |   |      |         |            |      | |   |    +---------------- flag9
 *      |   |      |         |            |      | |   +--------------------- timeoutMs (1000)
 *      |   |      |         |            |      | +------------------------- transport (KLINE / CAN / MOST / ...)
 *      |   |      |         |            |      +--------------------------- flashLimit (14)
 *      |   |      |         |            +---------------------------------- aifMode (AIFLesen / ...)
 *      |   |      |         +----------------------------------------------- hwIdMode (MehrfachHwSNr / ...)
 *      |   |      +-------------------------------------------------- groupId (d_<hex>)
 *      |   +--------------------------------------------------------- shortName (e.g. me9_4n)
 *      +------------------------------------------------------------- diagAddr (hex, e.g. 12 = 0x12)
 *
 * We treat unknown enum-shaped fields (hwIdMode, aifMode, transport,
 * category) as opaque strings — the planner consumer is responsible
 * for interpreting them. Numeric fields parse loosely: invalid /
 * blank → `undefined`, so a missing flashLimit doesn't sink the
 * row.
 */

import { iterLines, parseIntOpt, type TextLine } from './lexer.js';

export interface KmmSitRow {
  /** Diagnostic address (parsed from hex column 0). E.g. `0x12`. */
  diagAddr: number;
  /** ECU short name. E.g. `"me9_4n"`. */
  shortName: string;
  /** Group identifier, typically `d_<4hex>` shape. E.g. `"d_0012"`. */
  groupId: string;
  /** HW-identification mode tag. E.g. `"MehrfachHwSNr"`. */
  hwIdMode: string;
  /** AIF (After-Information-File) mode tag. E.g. `"AIFLesen"`. */
  aifMode: string;
  /** Maximum flash cycles allowed for this ECU. `undefined` if blank. */
  flashLimit: number | undefined;
  /** Transport name. E.g. `"KLINE"`, `"CAN"`, `"MOST"`. */
  transport: string;
  /** Job timeout (ms). `undefined` if blank. */
  timeoutMs: number | undefined;
  /** Category tag. E.g. `"MOT"` (Motor), `"KAR"` (Karosserie). */
  category: string;
  /**
   * All 16 raw fields preserved verbatim — for forward-compat with
   * fields we haven't characterised yet, and so unknown enum values
   * stay round-trippable to the wire.
   */
  raw: string[];
  /** 1-based source line number. */
  lineNo: number;
}

export interface KmmSitFile {
  rows: KmmSitRow[];
  /**
   * Lines we couldn't parse — kept rather than thrown so a single
   * malformed row doesn't sink the whole planner load. The planner
   * surfaces these as warnings.
   */
  unparsed: { lineNo: number; raw: string; reason: string }[];
}

const EXPECTED_FIELDS = 16;

export function parseKmmSit(content: string): KmmSitFile {
  const rows: KmmSitRow[] = [];
  const unparsed: KmmSitFile['unparsed'] = [];

  for (const line of iterLines(content, '#')) {
    if (line.isCommentOrEmpty) continue;
    parseRow(line, rows, unparsed);
  }

  return { rows, unparsed };
}

function parseRow(line: TextLine, rows: KmmSitRow[], unparsed: KmmSitFile['unparsed']): void {
  // Split on `;` — trim each field, the file is sometimes space-padded around
  // separators in the chassis prefix sections.
  const fields = line.trimmed.split(';').map((f) => f.trim());

  if (fields.length !== EXPECTED_FIELDS) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `expected ${EXPECTED_FIELDS} fields, got ${fields.length}`,
    });
    return;
  }

  // Column 0 is hex. The KmmSrv assertion ("Unknown diagAddr %02X")
  // is the canonical anchor for this — DiagAddr is always 2 hex
  // digits in BMW K-line / UDS addressing.
  const diagAddr = Number.parseInt(fields[0]!, 16);
  if (!Number.isFinite(diagAddr) || diagAddr < 0 || diagAddr > 0xff) {
    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: `field 0 (diagAddr) is not a valid hex byte: "${fields[0]}"`,
    });
    return;
  }

  rows.push({
    diagAddr,
    shortName: fields[1]!,
    groupId: fields[2]!,
    hwIdMode: fields[3]!,
    aifMode: fields[4]!,
    flashLimit: parseIntOpt(fields[6]!),
    transport: fields[7]!,
    timeoutMs: parseIntOpt(fields[8]!),
    category: fields[10]!,
    raw: fields,
    lineNo: line.lineNo,
  });
}
