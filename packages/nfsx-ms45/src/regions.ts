/**
 * MS45 memory layout — the address facts every other module builds on.
 *
 * The MS45 DME has two independent flash spaces:
 *
 *   External flash (1 MB)  mapped @ 0xFFF00000 in ECU address space
 *   Internal MPC flash (0x70000)  mapped @ 0x00000000 in ECU address space
 *
 * A host-side firmware file is a mirror of one of those regions,
 * addressed from offset 0. Segment tables inside the flash use the
 * ECU-space address, so translating host ↔ ECU requires subtracting
 * the base for whichever region the address falls in.
 *
 *   external host offset = ecu_addr - 0xFFF00000  (when ecu_addr >= 0xFFF00000)
 *   mpc     host offset = ecu_addr                 (when ecu_addr <  0xFFF00000)
 *
 * Segment-header layout (BE u32 throughout):
 *
 *   +0x00  numSegments                   — number of address ranges
 *   +0x04  segment[0].start (ECU addr)
 *   +0x08  segment[1].start
 *   ...
 *   +N     segment[i].end   (ECU addr)   — inclusive last byte
 *   ...
 *
 * That header shape is used in two locations per firmware:
 *
 *   Parameter blob (0x1D000 bytes, host offset 0x40000 in external flash):
 *     - CRC-32 segment table at file offset 0x104 (numSegments then start/end pairs)
 *     - initial CRC value at 0x110
 *     - stored CRC at 0x100
 *     - RSA-signed segment table at 0x130 (numSegments then starts) + lengths at 0x144
 *     - stored RSA cipher at 0x174 (64 bytes)
 *
 *   Program blob (0x9FF40 bytes, host offset 0x60000 in external flash):
 *     - CRC-32 primary segment table at 0x60008 / 0x60010 (segment1 start/end)
 *                                    at 0x6000C / 0x60014 (segment2 start/end)
 *     - initial CRC at 0x60004, stored CRC at 0x60000
 *     - CRC-32 secondary segment table at 0x60348 / 0x6034C / 0x60350 / 0x60354
 *     - initial CRC at 0x60358, stored CRC at 0x60340
 *     - RSA-signed segment table at 0x60030 (numSegments then starts) + lengths at 0x6004C
 *     - stored RSA cipher at 0x60074 (64 bytes)
 *
 * Program segments cross both flash spaces — segments whose start
 * address is < 0xFFF00000 live in the MPC flash, everything else in
 * external flash.
 */

// ── region base addresses (ECU space) ───────────────────────────────

export const EXTERNAL_FLASH_BASE = 0xfff00000;
export const MPC_FLASH_BASE = 0x00000000;

// ── file sizes ──────────────────────────────────────────────────────

/** Full external-flash image size (1 MB). */
export const EXTERNAL_FLASH_SIZE = 0x100000;

/** Full MPC-flash image size (448 KB). */
export const MPC_FLASH_SIZE = 0x70000;

/** Parameter (tune) blob size — a slice of the external flash. */
export const TUNE_BLOB_SIZE = 0x1d000;

/**
 * Where the parameter blob starts inside a full external-flash image.
 * The blob is 0x40000..0x5CFFF (ECU 0xFFF40000..0xFFF5CFFF).
 */
export const TUNE_BLOB_HOST_OFFSET = 0x40000;

/**
 * Where the program blob starts inside a full external-flash image.
 * The blob is 0x60000..0xFFF3F (ECU 0xFFF60000..0xFFFFFF3F).
 */
export const PROGRAM_BLOB_HOST_OFFSET = 0x60000;
export const PROGRAM_BLOB_SIZE = 0x9ff40;

// ── parameter-blob header field offsets ─────────────────────────────
//
// These are offsets *within the parameter blob* (so also within an
// external-flash image if the blob is embedded starting at 0x40000 —
// the caller passes whichever base they're working with).

export const PARAM_CRC_STORED_OFFSET = 0x100;
export const PARAM_CRC_SEGMENT_TABLE_OFFSET = 0x104;
export const PARAM_CRC_INITIAL_OFFSET = 0x110;
export const PARAM_SIG_SEGMENT_COUNT_OFFSET = 0x130;
export const PARAM_SIG_SEGMENT_STARTS_OFFSET = 0x134;
export const PARAM_SIG_SEGMENT_LENGTHS_OFFSET = 0x144;
export const PARAM_SIG_STORED_OFFSET = 0x174;
export const PARAM_SIG_LENGTH = 64;

/**
 * The base address the parameter blob's signed-segment table uses.
 * Signed-segment "start" fields are ECU addresses in [0xFFF40000,
 * 0xFFF5CFFF]; subtracting this base gives the offset inside the
 * parameter blob (which is what the file itself is a mirror of).
 */
export const PARAM_SIG_SEGMENT_BASE = 0xfff40000;

/**
 * The base address the parameter blob's CRC segment table uses.
 * CRC "start"/"end" fields for the parameter blob are ECU addresses
 * in [0xFFE40000, 0xFFE5CFFF] — one region higher than the signed
 * segments, matching the DME's mirrored memory windows for RUN vs.
 * VERIFY execution. Subtracting this base gives the offset inside
 * the parameter blob.
 */
export const PARAM_CRC_SEGMENT_BASE = 0xffe40000;

// ── program-blob header field offsets ───────────────────────────────
//
// These are offsets *within an external-flash image* — the program
// blob lives at 0x60000..0xFFF3F.

export const PROG_CRC_PRIMARY_STORED_OFFSET = 0x60000;
export const PROG_CRC_PRIMARY_INITIAL_OFFSET = 0x60004;
export const PROG_CRC_PRIMARY_SEG1_START_OFFSET = 0x60008;
export const PROG_CRC_PRIMARY_SEG2_START_OFFSET = 0x6000c;
export const PROG_CRC_PRIMARY_SEG1_END_OFFSET = 0x60010;
export const PROG_CRC_PRIMARY_SEG2_END_OFFSET = 0x60014;

export const PROG_CRC_SECONDARY_STORED_OFFSET = 0x60340;
export const PROG_CRC_SECONDARY_SEG1_START_OFFSET = 0x60348;
export const PROG_CRC_SECONDARY_SEG1_END_OFFSET = 0x6034c;
export const PROG_CRC_SECONDARY_SEG2_START_OFFSET = 0x60350;
export const PROG_CRC_SECONDARY_SEG2_END_OFFSET = 0x60354;
export const PROG_CRC_SECONDARY_INITIAL_OFFSET = 0x60358;

export const PROG_SIG_SEGMENT_COUNT_OFFSET = 0x60030;
export const PROG_SIG_SEGMENT_STARTS_OFFSET = 0x60034;
export const PROG_SIG_SEGMENT_LENGTHS_OFFSET = 0x6004c;
export const PROG_SIG_STORED_OFFSET = 0x60074;
export const PROG_SIG_LENGTH = 64;

// ── DME variants ────────────────────────────────────────────────────

export type Ms45Variant = 'MS45.0' | 'MS45.1';

/** Hardware-reference strings the DME returns for each variant. */
export const HW_REF_MS45_0 = '0044560';
export const HW_REF_MS45_1 = '0044570';

// ── endian helpers (all MS45 header values are BE u32) ──────────────

export function readU32BE(buf: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > buf.length) {
    throw new RangeError(
      `readU32BE: offset ${offset} out of bounds for ${buf.length}-byte buffer`,
    );
  }
  // Coerce via >>> 0 so a leading 1 bit doesn't turn the result into a
  // negative JS number.
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

export function writeU32BE(buf: Uint8Array, value: number, offset: number): void {
  if (offset < 0 || offset + 4 > buf.length) {
    throw new RangeError(
      `writeU32BE: offset ${offset} out of bounds for ${buf.length}-byte buffer`,
    );
  }
  const v = value >>> 0;
  buf[offset] = (v >>> 24) & 0xff;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

/**
 * Little-endian u32 writer — used by the flash-command builders
 * (erase / write-address / write-chunk) which mirror the C#
 * `BitConverter.GetBytes(uint)` layout on x86.
 */
export function writeU32LE(buf: Uint8Array, value: number, offset: number): void {
  if (offset < 0 || offset + 4 > buf.length) {
    throw new RangeError(
      `writeU32LE: offset ${offset} out of bounds for ${buf.length}-byte buffer`,
    );
  }
  const v = value >>> 0;
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
  buf[offset + 2] = (v >>> 16) & 0xff;
  buf[offset + 3] = (v >>> 24) & 0xff;
}

// ── segment resolution ─────────────────────────────────────────────

/**
 * Which flash space an ECU address belongs to. The MPC is memory-
 * mapped at address 0, external flash at 0xFFF00000; addresses in
 * between are neither space (the boot ROM, RAM, etc.) and are not a
 * valid target for host-side segment resolution.
 */
export type FlashSpace = 'external' | 'mpc';

export interface ResolvedAddress {
  space: FlashSpace;
  hostOffset: number;
}

export function classifyEcuAddress(ecuAddr: number): FlashSpace {
  return ecuAddr >= EXTERNAL_FLASH_BASE ? 'external' : 'mpc';
}

export function resolveEcuAddress(ecuAddr: number): ResolvedAddress {
  const space = classifyEcuAddress(ecuAddr);
  const hostOffset =
    space === 'external' ? ecuAddr - EXTERNAL_FLASH_BASE : ecuAddr - MPC_FLASH_BASE;
  return { space, hostOffset };
}

export interface ProgramSignedSegment {
  ecuStart: number;
  length: number;
  space: FlashSpace;
  hostOffset: number;
}

/**
 * Parse the program blob's signed-segment header. Returns absolute
 * segment descriptors that the signature routine can hand straight
 * to `flash.subarray(hostOffset, hostOffset+length)` or
 * `mpc.subarray(...)`.
 *
 * `external` here is a full 1 MB external-flash image (not the
 * program-blob slice) — offsets stored in the header are ECU
 * addresses that map into it starting at 0xFFF00000, not 0xFFF60000.
 */
export function parseProgramSignedSegments(external: Uint8Array): ProgramSignedSegment[] {
  const count = readU32BE(external, PROG_SIG_SEGMENT_COUNT_OFFSET);
  const out: ProgramSignedSegment[] = [];
  for (let i = 0; i < count; i++) {
    // Program-blob starts table has an 8-byte stride matching the C#
    // reference (start slots at 0x60034, 0x6003C, ...) so a two-word
    // header can be read cleanly by later helpers if we ever need it.
    const startEcu = readU32BE(external, PROG_SIG_SEGMENT_STARTS_OFFSET + i * 8);
    const length = readU32BE(external, PROG_SIG_SEGMENT_LENGTHS_OFFSET + i * 4);
    const { space, hostOffset } = resolveEcuAddress(startEcu);
    out.push({ ecuStart: startEcu, length, space, hostOffset });
  }
  return out;
}

export interface ParamSignedSegment {
  ecuStart: number;
  length: number;
  /** Offset inside the parameter blob (0..TUNE_BLOB_SIZE). */
  hostOffset: number;
}

/**
 * Parse the parameter blob's signed-segment header. Returns
 * descriptors relative to the blob itself, not to any containing
 * external-flash image.
 */
export function parseParameterSignedSegments(paramBlob: Uint8Array): ParamSignedSegment[] {
  const count = readU32BE(paramBlob, PARAM_SIG_SEGMENT_COUNT_OFFSET);
  const out: ParamSignedSegment[] = [];
  for (let i = 0; i < count; i++) {
    const startEcu = readU32BE(paramBlob, PARAM_SIG_SEGMENT_STARTS_OFFSET + i * 8);
    const length = readU32BE(paramBlob, PARAM_SIG_SEGMENT_LENGTHS_OFFSET + i * 4);
    out.push({
      ecuStart: startEcu,
      length,
      hostOffset: startEcu - PARAM_SIG_SEGMENT_BASE,
    });
  }
  return out;
}
