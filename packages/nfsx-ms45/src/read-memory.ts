/**
 * Chunked memory-read via SGBD `speicher_lesen_ascii`.
 *
 * The DME returns at most ~254 bytes per invocation, so any real
 * read is a loop:
 *
 *   speicher_lesen_ascii "ROMX;262144;254"   → 254 bytes in DATEN
 *   speicher_lesen_ascii "ROMX;262398;254"   → next 254 bytes
 *   …
 *   speicher_lesen_ascii "ROMX;<last>;<r>"   → final short segment
 *
 * Segment selectors:
 *
 *   ROMX  — external flash 0x00000..0xFFFFF (mapped @ 0xFFF00000)
 *   LAR   — internal MPC flash 0x00000..0x6FFFF
 *
 * Address & length are decimal in the arg string.
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import { runJob, requireResultBinary } from './ms45-ediabas.js';

/** Memory segment identifiers as recognised by the MS45 SGBD. */
export const MEM_SEGMENT = {
  /** External flash (0xFFF00000..0xFFFFFFFF, mirrored 0..0xFFFFF). */
  ROMX: 'ROMX',
  /** Internal MPC flash (0x0..0x6FFFF). */
  LAR: 'LAR',
} as const;

export type MemSegment = (typeof MEM_SEGMENT)[keyof typeof MEM_SEGMENT];

/** Maximum bytes per `speicher_lesen_ascii` invocation. */
export const READ_CHUNK_SIZE = 254;

export interface ReadMemoryOptions {
  segment: MemSegment;
  /** Start address inside the segment (host-side offset, decimal). */
  start: number;
  /** Inclusive last address to read. */
  end: number;
  /** Bytes per chunk. Defaults to 254; smaller values reduce peak
   *  message size but slow the overall read proportionally. */
  chunkSize?: number;
  /** Called after each chunk with the running byte counter. */
  onProgress?: (bytesRead: number, total: number) => void;
}

/**
 * Read a byte range from the DME, one `speicher_lesen_ascii`
 * invocation per chunk. Returns a fresh Uint8Array of exactly
 * `end - start + 1` bytes.
 *
 * On error (any chunk returns non-OKAY, or the DATEN result is
 * missing) throws Ms45JobError with the failing chunk's job name.
 */
export async function readMemory(
  ediabas: IEdiabas,
  sgbd: string,
  options: ReadMemoryOptions,
): Promise<Uint8Array> {
  const { segment, start, end } = options;
  if (end < start) {
    throw new RangeError(`readMemory: end (0x${end.toString(16)}) < start (0x${start.toString(16)})`);
  }
  const chunkSize = options.chunkSize ?? READ_CHUNK_SIZE;
  if (chunkSize <= 0 || chunkSize > READ_CHUNK_SIZE) {
    throw new RangeError(`readMemory: chunkSize must be 1..${READ_CHUNK_SIZE}, got ${chunkSize}`);
  }

  const total = end - start + 1;
  const out = new Uint8Array(total);
  let written = 0;
  let addr = start;

  while (written < total) {
    const remaining = total - written;
    const len = Math.min(chunkSize, remaining);
    const arg = `${segment};${addr};${len}`;
    const resp = await runJob(ediabas, sgbd, 'speicher_lesen_ascii', arg);
    const data = requireResultBinary(resp, 'speicher_lesen_ascii', 'DATEN');
    if (data.length !== len) {
      throw new Error(
        `readMemory: expected ${len} bytes at 0x${addr.toString(16)}, got ${data.length}`,
      );
    }
    out.set(data, written);
    written += len;
    addr += len;
    options.onProgress?.(written, total);
  }

  return out;
}
