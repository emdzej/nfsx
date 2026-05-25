/**
 * `SGIDC.AS2` / `SGIDD.AS2` parser — SG identification + key/cert
 * catalog.
 *
 * Both files share the same format. They sit in `data/gdaten/`
 * alongside `HWNR.DA2` / `KFCONF10.DA2` and provide the
 * crypto/identification material that feeds `CDHCallAuthenticate`
 * / `CDHAuthGetRandom` during SecurityAccess on flash-protected
 * ECUs.
 *
 * Source format (verified against `~/Downloads/E46_v74/data/gdaten/`):
 *
 *   $L 3                    ← Level / record size flag
 *   $V 1.00                 ← Version
 *   $G 1.00                 ← Global version (or similar)
 *   $K ACC65   A721000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2
 *   $K BMSKP2  P21AA…(300+ hex chars, full RSA/ECC certificate)
 *
 * - `;` line comments (rare; the files are mostly directives + entries).
 * - `$<DIRECTIVE> <args>` for metadata. Three observed:
 *     - `$L <int>` — level (3 in SGIDC, 4 in SGIDD)
 *     - `$V <ver>` — version
 *     - `$G <ver>` — global / generation version
 * - `$K <SG_TYP> <payload>` — one entry per SG. Payload is treated
 *   as an opaque string by this parser. Observed shapes:
 *     - 40 hex chars (`A721000068B9DEFB…`) — HW-specific key
 *     - 300+ hex chars (`A12300006…`) — full RSA/ECC certificate
 *     - 1-char prefix + hex (`P212AA…` for BMSKP2 entries)
 *     - 2-char prefix + hex (`LN290000…` for DXC853 entries)
 *   The prefix-letter classes haven't been fully mapped — they
 *   look like type tags (P = ?, L = ?). The crypto layer
 *   interprets; the parser just preserves verbatim.
 * - SG_TYP appears right-padded with spaces for visual alignment;
 *   we trim it.
 * - Same SG_TYP can have multiple `$K` entries (e.g. ECO65 in
 *   SGIDD has two distinct key blobs — probably different levels
 *   or variants). We accumulate into a multi-valued bucket.
 */

import { iterLines } from './lexer.js';

export interface SgIdEntry {
  /** SG short name — trimmed of source padding. */
  sgTyp: string;
  /**
   * Opaque payload string — preserved verbatim. May be pure hex
   * (`A721000068B9DEFB…`) or prefix + hex (`P212AA…`, `LN29…`).
   * The crypto / authentication layer interprets it; this parser
   * stores it as-is.
   */
  payload: string;
  /** 1-based source line number. */
  lineNo: number;
}

export interface SgIdFile {
  /**
   * `$L`, `$V`, `$G` directives keyed by their letter (e.g.
   * `directives.get('L') === '3'`).
   */
  directives: Map<string, string>;
  entries: SgIdEntry[];
  /**
   * SG_TYP → entries. Multi-valued because a single SG_TYP can
   * appear with multiple key blobs (e.g. ECO65 in SGIDD.AS2 with
   * two distinct hex payloads — different variants).
   */
  bySgTyp: Map<string, SgIdEntry[]>;
  unparsed: { lineNo: number; raw: string; reason: string }[];
}

const DIRECTIVE_RE = /^\$([A-Z])\s+(.+?)\s*$/;
// Payload is whatever non-whitespace tokens follow the SG_TYP — kept
// as an opaque string. Validation (hex vs prefix-then-hex) belongs
// in the consumer.
const ENTRY_RE = /^\$K\s+(\S+)\s+(\S.*?)\s*$/;

/**
 * Parse SGIDC.AS2 / SGIDD.AS2 content. Both files use the same
 * format, so this single parser handles both — distinguish via
 * the `$L` directive value if you need to (`3` = SGIDC, `4` =
 * SGIDD on the E46 sample).
 */
export function parseSgId(content: string): SgIdFile {
  const directives = new Map<string, string>();
  const entries: SgIdEntry[] = [];
  const bySgTyp = new Map<string, SgIdEntry[]>();
  const unparsed: SgIdFile['unparsed'] = [];

  for (const line of iterLines(content, ';')) {
    if (line.isCommentOrEmpty) continue;

    // `$K <SG> <hex>` is the data record. Match it first because
    // the directive regex would otherwise consume it too (both
    // start with `$<LETTER>`).
    const entryMatch = line.trimmed.match(ENTRY_RE);
    if (entryMatch) {
      const sgTyp = entryMatch[1]!;
      const payload = entryMatch[2]!;
      const entry: SgIdEntry = { sgTyp, payload, lineNo: line.lineNo };
      entries.push(entry);
      let bucket = bySgTyp.get(sgTyp);
      if (!bucket) {
        bucket = [];
        bySgTyp.set(sgTyp, bucket);
      }
      bucket.push(entry);
      continue;
    }

    // Generic directive — `$<LETTER> <value>`. K is reserved for
    // entries (handled above), so anything else lands here.
    const dirMatch = line.trimmed.match(DIRECTIVE_RE);
    if (dirMatch) {
      const letter = dirMatch[1]!;
      if (letter === 'K') {
        // `$K` line that didn't match ENTRY_RE — malformed
        unparsed.push({
          lineNo: line.lineNo,
          raw: line.raw,
          reason: 'malformed $K entry (expected `$K <SG> <hex>`)',
        });
        continue;
      }
      directives.set(letter, dirMatch[2]!);
      continue;
    }

    unparsed.push({
      lineNo: line.lineNo,
      raw: line.raw,
      reason: 'unrecognised line shape',
    });
  }

  return { directives, entries, bySgTyp, unparsed };
}

/**
 * Decode the hex payload to a Uint8Array. Returns undefined if the
 * hex is malformed. Separated from `parseSgId` so the parser stays
 * cheap (skips the allocation for entries the caller never inspects).
 */
export function decodeSgIdHex(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return undefined;
    out[i] = byte;
  }
  return out;
}
