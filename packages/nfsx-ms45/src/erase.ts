/**
 * `flash_loeschen` — erase one of the DME's flash sub-regions.
 *
 * Binary-arg layout (22 bytes; the C# reference reads:
 *   { 01, 01, 00, 00, FE, 00, 00, 00, 00, FF, 00, 00, 00, 44, EA, 01, 00, 00, 00, 84, 00, 03 }
 * but actually zeroes everything except a handful of fields):
 *
 *   [0]        0x01                      — EDIABAS binary-arg version
 *   [1..3]     0x00
 *   [4]        0xFE                      — command opcode: erase
 *   [5..12]    0x00
 *   [13..16]   blockLength (little-endian u32)
 *   [17..20]   blockStart  (little-endian u32)
 *   [21]       0x00                      — no trailing marker on erase
 *
 * NOTE: the DME does whole-region erase regardless of the length
 * field — erasing anything in the program space wipes the entire
 * program space, same for the parameter space. Length is included
 * because the SGBD job definition needs the fixed argument slot
 * layout, not because the DME reads it.
 *
 * Standard erase addresses:
 *
 *   parameter (tune) region:   start 0x2040000, blockLength 0x20000
 *   program region:            start 0x2060000, blockLength 0xA0000
 *
 * The 0x02000000 offset in the address is the DME's flash-erase
 * command prefix — it selects the external flash bank.
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import { runJob } from './ms45-ediabas.js';
import { writeU32LE } from './regions.js';

/** Erase target when flashing only the parameter (tune) blob. */
export const ERASE_TUNE = {
  start: 0x2040000,
  length: 0x20000,
} as const;

/** Erase target when flashing the full program. */
export const ERASE_PROGRAM = {
  start: 0x2060000,
  length: 0xa0000,
} as const;

export interface EraseTarget {
  start: number;
  length: number;
}

/** Build the 22-byte binary arg the SGBD passes to `flash_loeschen`. */
export function buildEraseCommand(target: EraseTarget): Uint8Array {
  const out = new Uint8Array(22);
  out[0] = 0x01;
  out[4] = 0xfe;
  writeU32LE(out, target.length, 13);
  writeU32LE(out, target.start, 17);
  return out;
}

/** Dispatch `flash_loeschen` for the given target. */
export async function eraseRegion(
  ediabas: IEdiabas,
  sgbd: string,
  target: EraseTarget,
): Promise<void> {
  await runJob(ediabas, sgbd, 'flash_loeschen', buildEraseCommand(target));
}
