/**
 * Integrity checks for flash payloads.
 *
 * Two layers:
 *   1. **Per-record checksum** — every S-record carries its own
 *      one's-complement checksum. The S37 parser populates each
 *      record's `checksumOk` field; `verifyChecksums` aggregates.
 *   2. **CRC32 of memory map** — many ECUs run a final
 *      verify-routine after TransferData that checksums the full
 *      memory range and compares against a value the host supplied.
 *      `crc32` here implements the canonical CRC-32/ISO-HDLC
 *      polynomial (0xEDB88320 reversed, init 0xFFFFFFFF, xorout
 *      0xFFFFFFFF) — the variant most BMW ECUs expect. If a specific
 *      ECU needs a different polynomial, wrap this in a strategy
 *      pattern at the flash-session layer.
 */

import type { S37Record } from './s37.js';

/**
 * Verify every record's declared checksum matches the recomputed
 * one. Returns a summary; `ok: true` means every record passed.
 *
 * Bad records are listed; callers can decide whether a single bad
 * checksum is fatal (usually yes — refuse to flash) or recoverable
 * (rarely — only if it's an annotation-only record).
 */
export function verifyChecksums(records: readonly S37Record[]): {
  ok: boolean;
  bad: S37Record[];
} {
  const bad = records.filter((r) => !r.checksumOk);
  return { ok: bad.length === 0, bad };
}

/**
 * CRC-32/ISO-HDLC. Polynomial 0xEDB88320 (reflected form of
 * 0x04C11DB7), init 0xFFFFFFFF, xorout 0xFFFFFFFF. Reflected input
 * and output.
 *
 * Implementation note: builds the lookup table lazily on first call
 * so module load cost stays zero for callers that don't need it.
 */
let CRC32_TABLE: Uint32Array | undefined;

function ensureTable(): Uint32Array {
  if (CRC32_TABLE) return CRC32_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  CRC32_TABLE = t;
  return t;
}

export function crc32(bytes: Uint8Array, init = 0xffffffff): number {
  const t = ensureTable();
  let crc = init;
  for (let i = 0; i < bytes.length; i++) {
    crc = (t[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Convenience: CRC32 across multiple regions, in address order.
 * Equivalent to concatenating the regions then CRC32'ing, but
 * without the intermediate allocation.
 */
export function crc32Regions(regions: ReadonlyArray<{ bytes: Uint8Array }>): number {
  const t = ensureTable();
  let crc = 0xffffffff;
  for (const region of regions) {
    const b = region.bytes;
    for (let i = 0; i < b.length; i++) {
      crc = (t[(crc ^ b[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
