/**
 * Shared lexer primitives for BMW NFS / WinKFP plaintext data files.
 *
 * Every file in the data layer (`kmm_*.txt`, `*.DA2`, `*.AS2`, `*.dat`)
 * is line-oriented text with one of these comment conventions:
 *
 *   - `#` line comment — `kmm_*.txt` (kmmData/)
 *   - `;` line comment — `HWNR.DA2`, `KFCONF10.DA2`, `npv.dat`,
 *     `prgifsel.dat`, and friends in `data/gdaten/`
 *
 * Both are full-line-only: there is no inline comment dropped after
 * a separator. The files mix CRLF (Windows-shipped) and LF, so we
 * accept either.
 *
 * Encoding: ISO-8859-1 (Latin-1) is the canonical BMW encoding —
 * comment text routinely contains German umlauts (ä, ö, ü, ß). The
 * parsers in this package take JS strings, so the upstream file
 * read is responsible for decoding correctly; the lexer itself is
 * encoding-agnostic.
 */

export type CommentChar = '#' | ';';

export interface TextLine {
  /** 1-based source line number. */
  lineNo: number;
  /** Raw line as it appeared in the file, with leading/trailing whitespace and the EOL stripped. */
  raw: string;
  /** Trimmed body — leading/trailing whitespace removed. */
  trimmed: string;
  /** True when the (trimmed) line is empty or starts with the configured comment char. */
  isCommentOrEmpty: boolean;
}

/**
 * Walk a text blob line-by-line, exposing line metadata + flags so
 * downstream parsers don't each reimplement "skip empty + skip
 * comments" themselves.
 *
 * Lines are split on LF; trailing `\r` is stripped. The iterator
 * yields every line (including comment / empty ones) — it's up to
 * the caller to filter via `line.isCommentOrEmpty`. This lets a
 * caller preserve comments verbatim if it wants to (the `npv.dat`
 * tests need this).
 */
export function* iterLines(content: string, commentChar: CommentChar): Generator<TextLine> {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    const trimmed = raw.trim();
    const isCommentOrEmpty = trimmed.length === 0 || trimmed.startsWith(commentChar);
    yield { lineNo: i + 1, raw, trimmed, isCommentOrEmpty };
  }
}

/**
 * Parse a string field as a non-negative integer with the given
 * radix, returning `undefined` instead of `NaN` on garbage. This is
 * the safe shape for optional numeric columns in CSV-style rows
 * (`flashLimit`, `timeoutMs`, etc.) where a blank or non-numeric
 * value should be treated as "absent" rather than crashing the
 * whole row.
 */
export function parseIntOpt(s: string, radix: number = 10): number | undefined {
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number.parseInt(trimmed, radix);
  return Number.isFinite(n) ? n : undefined;
}
