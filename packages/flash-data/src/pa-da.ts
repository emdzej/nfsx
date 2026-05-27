/**
 * BMW Programm/Daten Austausch-Datei parser.
 *
 * SP-Daten ships ECU firmware as `.0PA` (Programm) and `.0DA` (Daten)
 * files — Intel HEX dialect with a BMW header/footer wrapper.
 *
 * **File structure:**
 *
 * ```
 *   ; <decorative line>
 *   ;; <Key>: <Value>            ← metadata (header)
 *   ;; <Key>   <Value>           ← whitespace-separated variant
 *   ...
 *   $REFERENZ <ref> <flag>       ← BMW data-section directive (e.g. `G2210_0089D0 Q`)
 *   :020000040000FA              ← Intel HEX records (types 00/02/04)
 *   :02000002A0005C
 *   :20000000<32 bytes of data>CC
 *   ...
 *   :00000010F0                  ← BMW-specific end-of-data marker (type 0x10, no data)
 *   $CHECKSUMME <number> <flag>  ← BMW file checksum footer
 *   ;$CARB_MODE_9_CVN <hex> <n>  ← optional CARB CVN (often commented out)
 *   :00000001FF                  ← standard Intel HEX EOF (type 01)
 * ```
 *
 * **Intel HEX dialect** (https://en.wikipedia.org/wiki/Intel_HEX):
 *
 *   `:LLAAAATT<data>CC`
 *
 *   - LL = data byte count (hex)
 *   - AAAA = 16-bit address within the current segment/linear bank
 *   - TT = record type
 *   - data = LL bytes (2*LL hex chars)
 *   - CC = checksum: two's-complement of LSB of sum of all bytes
 *          from LL onward
 *
 * **Record types we accept:**
 *
 *   - `0x00` data
 *   - `0x01` end-of-file (no data, address=0000)
 *   - `0x02` extended segment address (data = 2 bytes, segment<<4 added to next addrs)
 *   - `0x04` extended linear address (data = 2 bytes, used as upper 16 bits of address)
 *   - `0x10` BMW-specific (observed in `.0PA` footers, no data, address=0000) — kept
 *            in the record list but doesn't affect addressing
 *
 * **Why not just reuse the S37 parser?** Different format entirely
 * (`:` prefix vs `S` prefix, different addressing model, different
 * checksum scheme). Some structural overlap with the S37 result
 * shape so consumers can swap parsers via a discriminating union.
 */

import type { MemoryRegion } from './memory-map.js';

/** One Intel-HEX-style record from a PA/DA file. */
export interface PaDaRecord {
  /** Intel HEX record type byte. Standard: 0x00/0x01/0x02/0x04. BMW: 0x10. */
  type: number;
  /** The 16-bit address field as written in the record header. */
  localAddress: number;
  /**
   * Absolute address after applying any preceding extended-segment
   * (`0x02`) or extended-linear (`0x04`) records. Always present for
   * data records (`type === 0x00`); for non-data records this just
   * mirrors `localAddress`.
   */
  address: number;
  /** Data payload bytes (empty for non-data records). */
  data: Uint8Array;
  /** 1-based line number. */
  lineNumber: number;
  /** Whether the in-line checksum matched the computed one. */
  checksumOk: boolean;
}

/** Parsed BMW headers / directives. */
export interface PaDaMetadata {
  /**
   * All `;;Key: Value` (or `;;Key  Value`) pairs found in the file.
   * Header values like `ZL_System`, `ZL_Projekt`, `ZL_Referenz`,
   * `K_File-Name`, `K_Stand`, `KK_Bearbeiter` etc. surface here.
   * Keys are normalized to the text before the colon / first
   * whitespace block; values are trimmed.
   */
  fields: Record<string, string>;
  /** `$REFERENZ <ref> <flag>` directive — the BMW reference identifier. */
  referenz?: { ref: string; flag: string };
  /** `$CHECKSUMME <value> <flag>` footer. */
  checksum?: { value: string; flag: string };
  /** `$CARB_MODE_9_CVN <hex> <num>` if not commented out. */
  carbCvn?: { value: string; num: string };
}

/** Result of parsing a full PA/DA file. */
export interface PaDaParseResult {
  records: PaDaRecord[];
  metadata: PaDaMetadata;
  /** Lines that didn't fit any known pattern. */
  skipped: Array<{ lineNumber: number; reason: string; line: string }>;
}

/**
 * Parse a `.0PA` or `.0DA` file. Accepts a string (any line-ending)
 * or a `Uint8Array` (interpreted as ASCII — BMW exchange files are
 * always plain ASCII, often with CRLF).
 */
export function parsePaDa(input: string | Uint8Array): PaDaParseResult {
  const text = typeof input === 'string' ? input : decodeAscii(input);
  const lines = text.split(/\r?\n/);
  const records: PaDaRecord[] = [];
  const skipped: PaDaParseResult['skipped'] = [];
  const fields: Record<string, string> = {};
  let referenz: PaDaMetadata['referenz'];
  let checksum: PaDaMetadata['checksum'];
  let carbCvn: PaDaMetadata['carbCvn'];

  // Current extended-addressing state. Both can be active in
  // theory; the BMW convention is "type 0x04 sets upper 16 bits,
  // type 0x02 (segment) is supplementary." We support both.
  let extLinearHigh = 0; // upper 16 bits from a 0x04 record
  let extSegBase = 0; // 20-bit base from a 0x02 record (segment << 4)

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    if (trimmed.startsWith(';;')) {
      const m = parseMetadataLine(trimmed.slice(2));
      if (m) fields[m.key] = m.value;
      // Otherwise it's a `;;` decorative line with no key — silent skip.
      continue;
    }

    if (trimmed.startsWith(';$')) {
      // Commented-out BMW directive — parse for visibility but
      // don't treat as active. `;$CARB_MODE_9_CVN 0000B78D 9` is
      // the canonical case.
      const inner = trimmed.slice(1).trim();
      const parsed = parseBmwDirective(inner);
      if (parsed?.kind === 'CARB_MODE_9_CVN') carbCvn = parsed.payload;
      // Other commented directives currently ignored.
      continue;
    }

    if (trimmed.startsWith(';')) continue; // decorative comment

    if (trimmed.startsWith('$')) {
      const parsed = parseBmwDirective(trimmed);
      if (!parsed) {
        skipped.push({ lineNumber, reason: 'unknown $ directive', line: raw });
        continue;
      }
      if (parsed.kind === 'REFERENZ') referenz = parsed.payload;
      else if (parsed.kind === 'CHECKSUMME') checksum = parsed.payload;
      else if (parsed.kind === 'CARB_MODE_9_CVN') carbCvn = parsed.payload;
      continue;
    }

    if (trimmed.startsWith(':')) {
      const parsed = parseHexRecord(trimmed, lineNumber);
      if ('error' in parsed) {
        skipped.push({ lineNumber, reason: parsed.error, line: raw });
        continue;
      }
      const rec = parsed.record;

      // Apply state transitions for ext-address records BEFORE
      // computing the absolute address for the record itself.
      if (rec.type === 0x04 && rec.data.length === 2) {
        extLinearHigh = (rec.data[0]! << 8) | rec.data[1]!;
        // 0x04 doesn't reset segment base — but BMW files always
        // pair 04 with a subsequent 02, so behaviour is consistent
        // either way.
      } else if (rec.type === 0x02 && rec.data.length === 2) {
        extSegBase = ((rec.data[0]! << 8) | rec.data[1]!) << 4;
      }

      // Compute absolute address for data records.
      const absolute =
        rec.type === 0x00
          ? (extLinearHigh << 16) + extSegBase + rec.localAddress
          : rec.localAddress;

      records.push({ ...rec, address: absolute });
      continue;
    }

    skipped.push({ lineNumber, reason: 'unrecognized line prefix', line: raw });
  }

  return { records, metadata: { fields, referenz, checksum, carbCvn }, skipped };
}

/**
 * Convenience: collapse all `type === 0x00` records into contiguous
 * `MemoryRegion`s sorted by address. Adjacent records (next-address
 * equals previous-address + previous-length) merge into one region;
 * gaps create a new region.
 */
export function paDaToRegions(result: PaDaParseResult): MemoryRegion[] {
  const dataRecords = result.records
    .filter((r) => r.type === 0x00 && r.data.length > 0)
    .slice()
    .sort((a, b) => a.address - b.address);

  const regions: MemoryRegion[] = [];
  let current: { startAddress: number; bytes: number[] } | undefined;

  for (const rec of dataRecords) {
    const recEnd = rec.address + rec.data.length;
    if (current && rec.address === current.startAddress + current.bytes.length) {
      for (const b of rec.data) current.bytes.push(b);
    } else {
      if (current) regions.push({ startAddress: current.startAddress, bytes: new Uint8Array(current.bytes) });
      current = { startAddress: rec.address, bytes: [...rec.data] };
    }
    void recEnd; // suppress "unused" lint — kept for clarity above
  }
  if (current) regions.push({ startAddress: current.startAddress, bytes: new Uint8Array(current.bytes) });

  return regions;
}

/** Single-line PA/DA Intel-HEX record parser. Exported for tests. */
export function parseHexRecord(
  line: string,
  lineNumber: number,
): { record: Omit<PaDaRecord, 'address'> } | { error: string } {
  if (!line.startsWith(':')) return { error: 'no `:` prefix' };
  const body = line.slice(1).trim();
  // Body must be even-length hex; minimum 5 bytes = 10 chars
  // (LL + AAAA + TT + CC). Data records add 2 chars per data byte.
  if (body.length < 10 || body.length % 2 !== 0) {
    return { error: `record body has invalid length ${body.length}` };
  }
  if (!/^[0-9a-fA-F]+$/.test(body)) {
    return { error: 'record body contains non-hex chars' };
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);

  const count = bytes[0]!;
  const localAddress = (bytes[1]! << 8) | bytes[2]!;
  const type = bytes[3]!;
  const expectedLen = 4 + count + 1; // header(4) + data(count) + checksum(1)
  if (bytes.length !== expectedLen) {
    return { error: `byte-count says ${count} but line has ${bytes.length - 5} data bytes` };
  }
  const data = bytes.slice(4, 4 + count);
  const checksumByte = bytes[4 + count]!;

  let sum = 0;
  for (let i = 0; i < 4 + count; i++) sum = (sum + bytes[i]!) & 0xff;
  const computed = (-sum) & 0xff;
  const checksumOk = checksumByte === computed;

  void lineNumber; // unused (filled in by the caller)
  return {
    record: {
      type,
      localAddress,
      data,
      lineNumber,
      checksumOk,
    },
  };
}

function parseMetadataLine(rest: string): { key: string; value: string } | undefined {
  const trimmed = rest.trim();
  if (trimmed === '') return undefined;
  // Two conventions in the wild:
  //   `;;ZL_System:      GS20`           → split on first colon
  //   `;;KK_Abteilung      EA-70`        → split on first run of whitespace
  // Prefer the colon variant when present.
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    return key === '' ? undefined : { key, value };
  }
  const wsMatch = /^(\S+)\s+(.*)$/.exec(trimmed);
  if (wsMatch) return { key: wsMatch[1]!, value: wsMatch[2]!.trim() };
  return { key: trimmed, value: '' };
}

type BmwDirective =
  | { kind: 'REFERENZ'; payload: { ref: string; flag: string } }
  | { kind: 'CHECKSUMME'; payload: { value: string; flag: string } }
  | { kind: 'CARB_MODE_9_CVN'; payload: { value: string; num: string } };

function parseBmwDirective(line: string): BmwDirective | undefined {
  // line starts with `$`
  const tokens = line.slice(1).trim().split(/\s+/);
  if (tokens.length === 0) return undefined;
  const name = tokens[0]!;
  if (name === 'REFERENZ' && tokens.length >= 3) {
    return { kind: 'REFERENZ', payload: { ref: tokens[1]!, flag: tokens[2]! } };
  }
  if (name === 'CHECKSUMME' && tokens.length >= 3) {
    return { kind: 'CHECKSUMME', payload: { value: tokens[1]!, flag: tokens[2]! } };
  }
  if (name === 'CARB_MODE_9_CVN' && tokens.length >= 3) {
    return { kind: 'CARB_MODE_9_CVN', payload: { value: tokens[1]!, num: tokens[2]! } };
  }
  return undefined;
}

function decodeAscii(bytes: Uint8Array): string {
  // BMW exchange files are pure ASCII (often CRLF). Avoid pulling in
  // TextDecoder so this works in any JS environment.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}
