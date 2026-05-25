/**
 * Motorola S-record (S37 / SREC) parser.
 *
 * Wire format (one record per line):
 *
 *   S<type><count><address><data><checksum>
 *    1     2     N         M     2     (chars; everything after `S<type>` is hex)
 *
 *   type:     0-9 single digit
 *   count:    2 hex chars; number of bytes in (address + data + checksum)
 *   address:  4/6/8 hex chars depending on type
 *   data:     2N hex chars
 *   checksum: 2 hex chars; one's-complement of LSB of sum of all bytes
 *             from `count` onward
 *
 * Types we care about:
 *   S0  header (vendor metadata; not flashed)
 *   S1  data, 16-bit address (legacy 8-bit MCUs; uncommon in BMW)
 *   S2  data, 24-bit address (some 16-bit MCUs)
 *   S3  data, 32-bit address (modern, all 32-bit MCUs — the BMW common case)
 *   S5  record count (16-bit; non-data, informational)
 *   S6  record count (24-bit; non-data, informational)
 *   S7  start address (32-bit, paired with S3)
 *   S8  start address (24-bit, paired with S2)
 *   S9  start address (16-bit, paired with S1)
 *
 * References:
 *   - Motorola S-Record Spec, "SRECORD.pdf"
 *   - Wikipedia: https://en.wikipedia.org/wiki/SREC_(file_format)
 *
 * BMW context: flash binaries delivered via dealer channels arrive
 * primarily as S3 records (32-bit addressing, paired with one S7
 * terminator) — that's the canonical shape this parser is optimised
 * for. S1/S2 are accepted but rarely seen.
 */

/** Per-record metadata + payload. */
export interface S37Record {
  /** Single-digit record type (0, 1, 2, 3, 5, 6, 7, 8, 9). */
  type: number;
  /**
   * Memory address this record's data should be written to (for
   * S1/S2/S3) or the start-execution address (for S7/S8/S9). For
   * S0/S5/S6 the address field carries non-memory metadata —
   * still parsed into this field so callers can inspect.
   */
  address: number;
  /** Data payload bytes (empty for S0/S5/S6/S7/S8/S9). */
  data: Uint8Array;
  /** The original line text (without trailing newline). */
  line: string;
  /** 1-based line number in the source file. */
  lineNumber: number;
  /** Whether the in-line checksum matched the computed one. */
  checksumOk: boolean;
}

/** Result of parsing a full file. */
export interface S37ParseResult {
  records: S37Record[];
  /** Lines that didn't start with `S` or were obviously malformed. */
  skipped: Array<{ lineNumber: number; reason: string; line: string }>;
}

/**
 * Parse a full S-record file. Accepts either a string (with any
 * line-ending convention) or a `Uint8Array` (interpreted as
 * latin1/ASCII bytes — S-records are pure ASCII).
 *
 * Permissive about leading/trailing whitespace and empty lines.
 * Lines that don't start with `S` are recorded in `skipped` but
 * don't fail the parse — some real files have header comments,
 * vendor metadata, blank separators etc.
 */
export function parseS37(input: string | Uint8Array): S37ParseResult {
  const text = typeof input === 'string' ? input : decodeAscii(input);
  const lines = text.split(/\r?\n/);
  const records: S37Record[] = [];
  const skipped: S37ParseResult['skipped'] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('S')) {
      skipped.push({ lineNumber, reason: 'no S prefix', line: raw });
      continue;
    }
    try {
      records.push(parseLine(trimmed, lineNumber));
    } catch (err) {
      skipped.push({
        lineNumber,
        reason: err instanceof Error ? err.message : String(err),
        line: raw,
      });
    }
  }

  return { records, skipped };
}

/** Parse a single line. Throws on structural error. */
export function parseLine(line: string, lineNumber: number): S37Record {
  if (line.length < 10) {
    throw new Error(`line too short (need at least 10 chars, got ${line.length})`);
  }
  if (line[0] !== 'S') throw new Error('missing S prefix');
  const type = parseDigit(line[1]!);
  if (![0, 1, 2, 3, 5, 6, 7, 8, 9].includes(type)) {
    throw new Error(`unsupported S-record type S${type}`);
  }

  const count = parseHexByte(line, 2);
  // Total line length: 2 (S + type) + 2 (count) + 2 * count (rest)
  const expectedLen = 4 + 2 * count;
  if (line.length < expectedLen) {
    throw new Error(`line truncated: expected ${expectedLen} chars, got ${line.length}`);
  }
  const body = line.slice(4, expectedLen);

  const addressBytes = addressWidthFor(type);
  if (count < addressBytes + 1) {
    throw new Error(`count ${count} too small for type S${type} (need >= ${addressBytes + 1})`);
  }
  const dataBytes = count - addressBytes - 1; // -1 for checksum byte

  // Slice address
  let address = 0;
  for (let b = 0; b < addressBytes; b++) {
    address = (address << 8) | parseHexByte(body, b * 2);
  }
  // Slice data
  const data = new Uint8Array(dataBytes);
  for (let b = 0; b < dataBytes; b++) {
    data[b] = parseHexByte(body, (addressBytes + b) * 2);
  }
  // Verify checksum (last byte of body)
  const declaredChecksum = parseHexByte(body, (addressBytes + dataBytes) * 2);
  const computedChecksum = computeChecksum(count, address, addressBytes, data);

  return {
    type,
    address,
    data,
    line,
    lineNumber,
    checksumOk: declaredChecksum === computedChecksum,
  };
}

/**
 * Compute the one's-complement checksum the S-record format uses.
 * Sum: count + addressBytes + data; checksum = ~(sum & 0xff) & 0xff.
 */
export function computeChecksum(
  count: number,
  address: number,
  addressBytes: number,
  data: Uint8Array,
): number {
  let sum = count & 0xff;
  for (let b = 0; b < addressBytes; b++) {
    const shift = (addressBytes - 1 - b) * 8;
    sum = (sum + ((address >>> shift) & 0xff)) & 0xff;
  }
  for (let b = 0; b < data.length; b++) {
    sum = (sum + data[b]!) & 0xff;
  }
  return (~sum) & 0xff;
}

function addressWidthFor(type: number): number {
  // bytes of address field
  switch (type) {
    case 0: return 2; // S0 - 16-bit address (always 0x0000)
    case 1: return 2;
    case 2: return 3;
    case 3: return 4;
    case 5: return 2;
    case 6: return 3;
    case 7: return 4;
    case 8: return 3;
    case 9: return 2;
    default: throw new Error(`addressWidthFor: bad type ${type}`);
  }
}

function parseDigit(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  throw new Error(`expected digit, got "${c}"`);
}

function parseHexByte(s: string, offset: number): number {
  if (offset + 2 > s.length) throw new Error(`hex byte out of bounds at offset ${offset}`);
  const hi = parseHexDigit(s.charCodeAt(offset));
  const lo = parseHexDigit(s.charCodeAt(offset + 1));
  return (hi << 4) | lo;
}

function parseHexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  throw new Error(`bad hex digit code 0x${code.toString(16)}`);
}

function decodeAscii(buf: Uint8Array): string {
  // Pure ASCII; latin1 fallback for any stray high bytes (parser
  // will reject lines that don't start with 'S' anyway).
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return s;
}

/** Filter just the data-bearing records (S1/S2/S3). */
export function dataRecords(records: readonly S37Record[]): S37Record[] {
  return records.filter((r) => r.type === 1 || r.type === 2 || r.type === 3);
}

/** Find the terminator record (S7/S8/S9). Returns undefined if none. */
export function startRecord(records: readonly S37Record[]): S37Record | undefined {
  return records.find((r) => r.type === 7 || r.type === 8 || r.type === 9);
}
