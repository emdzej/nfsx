/**
 * `flash_schreiben_adresse` / `flash_schreiben` / `flash_schreiben_ende`
 * — write a contiguous block of bytes to a DME flash region.
 *
 * The choreography:
 *
 *   1. `flash_schreiben_adresse(cmd)`         open the write cursor at `blockStart`
 *   2. `flash_schreiben(header || chunk || 03)` × N   stream 0xFD-byte chunks
 *   3. `flash_schreiben_ende(cmd)`            close the cursor
 *
 * Arg layouts (all little-endian u32 for addresses / lengths):
 *
 *   flash_schreiben_adresse  (22 bytes)
 *     [0]        0x01
 *     [1..12]    0x00
 *     [13..16]   blockLength         (LE u32)
 *     [17..20]   blockStart          (LE u32)
 *     [21]       0x03                trailing marker
 *
 *   flash_schreiben  (21 header + chunkLen data + 1 trailer)
 *     [0]        0x01
 *     [1..12]    0x00
 *     [13]       chunkLen            (u8, ≤ 0xFD)
 *     [14..16]   0x00
 *     [17..20]   chunkStart          (LE u32)  — advances by chunkLen each frame
 *     [21..]     data                (chunkLen bytes)
 *     [21+cLen]  0x03                trailer
 *
 *   flash_schreiben_ende     same 22-byte layout as _adresse
 *
 * Standard write targets:
 *
 *   parameter (tune): start 0x2040000, len 0x1D000     (payload = signed tune blob)
 *   program:          start 0x2060000, len 0x9FF40     (payload = external[0x60000..])
 *   MPC:              start 0x0,       len 0x70000     (payload = mpc[0..])
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import { runJob } from './ms45-ediabas.js';
import { writeU32LE } from './regions.js';

/** Maximum bytes per `flash_schreiben` telegram (matches the reference flasher). */
export const FLASH_CHUNK_SIZE = 0xfd;

export interface FlashTarget {
  /** ECU-space start address the erase / write-address command carries. */
  start: number;
  /** Total byte count. */
  length: number;
}

/** Standard write target for tune-only flashes. */
export const FLASH_TUNE: FlashTarget = {
  start: 0x2040000,
  length: 0x1d000,
} as const;

/** Standard write target for the full-program external-flash region. */
export const FLASH_PROGRAM: FlashTarget = {
  start: 0x2060000,
  length: 0x9ff40,
} as const;

/** Standard write target for the internal MPC flash. */
export const FLASH_MPC: FlashTarget = {
  start: 0x00000000,
  length: 0x70000,
} as const;

/**
 * Build the 22-byte binary arg for `flash_schreiben_adresse` /
 * `flash_schreiben_ende` (identical layout for both).
 */
export function buildFlashAddressCommand(target: FlashTarget): Uint8Array {
  const out = new Uint8Array(22);
  out[0] = 0x01;
  out[21] = 0x03;
  writeU32LE(out, target.length, 13);
  writeU32LE(out, target.start, 17);
  return out;
}

/**
 * Build one `flash_schreiben` payload: 21-byte header + chunk + 0x03 trailer.
 *
 * `chunkStart` is the ECU-space address where this specific chunk
 * lands; it advances by `chunk.length` on each successive call.
 */
export function buildFlashChunk(chunkStart: number, chunk: Uint8Array): Uint8Array {
  if (chunk.length === 0 || chunk.length > FLASH_CHUNK_SIZE) {
    throw new RangeError(
      `buildFlashChunk: chunk must be 1..${FLASH_CHUNK_SIZE} bytes, got ${chunk.length}`,
    );
  }
  const out = new Uint8Array(21 + chunk.length + 1);
  out[0] = 0x01;
  out[13] = chunk.length & 0xff;
  writeU32LE(out, chunkStart, 17);
  out.set(chunk, 21);
  out[21 + chunk.length] = 0x03;
  return out;
}

export interface FlashBlockOptions {
  /** Called after each chunk finishes with bytes-written / total. */
  onProgress?: (bytesWritten: number, total: number) => void;
  /** Override chunk size (1..FLASH_CHUNK_SIZE). Default: `FLASH_CHUNK_SIZE`. */
  chunkSize?: number;
}

/**
 * Write `payload` bytes to the DME at `target.start`, split into
 * FLASH_CHUNK_SIZE-byte telegrams. Runs the full open / write-N /
 * close choreography. Errors propagate as `Ms45JobError`.
 */
export async function flashBlock(
  ediabas: IEdiabas,
  sgbd: string,
  target: FlashTarget,
  payload: Uint8Array,
  options: FlashBlockOptions = {},
): Promise<void> {
  if (payload.length !== target.length) {
    throw new RangeError(
      `flashBlock: payload length ${payload.length} != target.length ${target.length}`,
    );
  }
  const chunkSize = options.chunkSize ?? FLASH_CHUNK_SIZE;
  if (chunkSize <= 0 || chunkSize > FLASH_CHUNK_SIZE) {
    throw new RangeError(
      `flashBlock: chunkSize must be 1..${FLASH_CHUNK_SIZE}, got ${chunkSize}`,
    );
  }

  await runJob(ediabas, sgbd, 'flash_schreiben_adresse', buildFlashAddressCommand(target));

  let written = 0;
  let addr = target.start;
  while (written < payload.length) {
    const len = Math.min(chunkSize, payload.length - written);
    const chunk = payload.subarray(written, written + len);
    const arg = buildFlashChunk(addr, chunk);
    await runJob(ediabas, sgbd, 'flash_schreiben', arg);
    written += len;
    addr += len;
    options.onProgress?.(written, payload.length);
  }

  await runJob(ediabas, sgbd, 'flash_schreiben_ende', buildFlashAddressCommand(target));
}
