/**
 * MS45 CRC-32/MPEG-2 checksum verify/rewrite.
 *
 * Algorithm: polynomial 0x04C11DB7, initial value taken from the
 * blob header (not fixed), no reflection, no final XOR. Bytes are
 * shifted into the high byte of the accumulator:
 *
 *   crc = ((crc << 8) & 0xFFFFFF00) ^ table[((crc >> 24) & 0xFF) ^ byte]
 *
 * That's CRC-32/MPEG-2 with a caller-supplied seed. The table below
 * is the standard 256-entry lookup for that polynomial, non-reflected.
 *
 * Two checksum locations exist inside an MS45 firmware:
 *
 *  - Parameter (tune) blob — one CRC over the segments listed in the
 *    header at 0x104. Fields at 0x100 (stored), 0x110 (initial),
 *    with segment start/end pairs at 0x104..; segment addresses use
 *    the 0xFFE40000 base so subtracting it gives the offset inside
 *    the parameter blob itself.
 *
 *  - Program blob — TWO CRC-32 checksums that both span segments
 *    which can cross the MPC/external flash boundary. The primary
 *    is at 0x60000 (segments described at 0x60004..0x60014); the
 *    secondary is at 0x60340 (0x60348..0x60358). Both use raw ECU
 *    addresses (no base subtraction) — a segment start below
 *    0xFFF00000 lives in the MPC image.
 *
 * The secondary checksum is normally identical to the primary in
 * stock firmware — its segment definitions match. Older program
 * versions may have used it differently; recompute matches whatever
 * the header says.
 */

import {
  PARAM_CRC_STORED_OFFSET,
  PARAM_CRC_SEGMENT_TABLE_OFFSET,
  PARAM_CRC_INITIAL_OFFSET,
  PARAM_CRC_SEGMENT_BASE,
  PROG_CRC_PRIMARY_STORED_OFFSET,
  PROG_CRC_PRIMARY_INITIAL_OFFSET,
  PROG_CRC_PRIMARY_SEG1_START_OFFSET,
  PROG_CRC_PRIMARY_SEG1_END_OFFSET,
  PROG_CRC_PRIMARY_SEG2_START_OFFSET,
  PROG_CRC_PRIMARY_SEG2_END_OFFSET,
  PROG_CRC_SECONDARY_STORED_OFFSET,
  PROG_CRC_SECONDARY_INITIAL_OFFSET,
  PROG_CRC_SECONDARY_SEG1_START_OFFSET,
  PROG_CRC_SECONDARY_SEG1_END_OFFSET,
  PROG_CRC_SECONDARY_SEG2_START_OFFSET,
  PROG_CRC_SECONDARY_SEG2_END_OFFSET,
  EXTERNAL_FLASH_BASE,
  readU32BE,
  writeU32BE,
} from './regions.js';

// ── CRC-32/MPEG-2 table (poly 0x04C11DB7, non-reflected) ────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 0x80000000) !== 0 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** Continue a CRC-32/MPEG-2 from `initial` across `data`. */
export function crc32(data: Uint8Array, initial: number): number {
  let crc = initial >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (((crc << 8) & 0xffffff00) ^ CRC32_TABLE[((crc >>> 24) & 0xff) ^ data[i]!]!) >>> 0;
  }
  return crc;
}

// ── parameter (tune) blob ───────────────────────────────────────────

interface ParamSegment {
  hostStart: number;
  hostEnd: number; // inclusive
}

function readParameterSegments(blob: Uint8Array): ParamSegment[] {
  const count = readU32BE(blob, PARAM_CRC_SEGMENT_TABLE_OFFSET);
  const segs: ParamSegment[] = [];
  // Same 8-byte stride as C# reference: start at +4, end at +8, next
  // pair at +12/+16, ...
  for (let i = 0; i < count; i++) {
    const startEcu = readU32BE(
      blob,
      PARAM_CRC_SEGMENT_TABLE_OFFSET + 4 + i * 8,
    );
    const endEcu = readU32BE(
      blob,
      PARAM_CRC_SEGMENT_TABLE_OFFSET + 8 + i * 8,
    );
    segs.push({
      hostStart: startEcu - PARAM_CRC_SEGMENT_BASE,
      hostEnd: endEcu - PARAM_CRC_SEGMENT_BASE,
    });
  }
  return segs;
}

function computeParameterCrc(blob: Uint8Array): number {
  let crc = readU32BE(blob, PARAM_CRC_INITIAL_OFFSET);
  for (const seg of readParameterSegments(blob)) {
    if (
      seg.hostStart < 0 ||
      seg.hostEnd < seg.hostStart ||
      seg.hostEnd >= blob.length
    ) {
      throw new RangeError(
        `parameter CRC segment [0x${seg.hostStart.toString(16)}..0x${seg.hostEnd.toString(16)}] out of blob bounds (len 0x${blob.length.toString(16)})`,
      );
    }
    crc = crc32(blob.subarray(seg.hostStart, seg.hostEnd + 1), crc);
  }
  return crc;
}

export interface ParameterChecksumResult {
  stored: number;
  computed: number;
  ok: boolean;
}

export function verifyParameterChecksum(blob: Uint8Array): ParameterChecksumResult {
  const stored = readU32BE(blob, PARAM_CRC_STORED_OFFSET);
  const computed = computeParameterCrc(blob);
  return { stored, computed, ok: stored === computed };
}

/**
 * Recompute and write the parameter blob's CRC-32 in place. Returns
 * the same buffer for chaining. Signature invariants remain — the
 * signed segment range doesn't cover the CRC storage word.
 */
export function rewriteParameterChecksum(blob: Uint8Array): Uint8Array {
  const computed = computeParameterCrc(blob);
  writeU32BE(blob, computed, PARAM_CRC_STORED_OFFSET);
  return blob;
}

// ── program blob (dual CRC across external + MPC) ──────────────────

interface ProgramSegment {
  ecuStart: number;
  ecuEnd: number;
}

function computeProgramCrc(
  external: Uint8Array,
  mpc: Uint8Array,
  storedOffset: number,
  initialOffset: number,
  seg1StartOffset: number,
  seg1EndOffset: number,
  seg2StartOffset: number,
  seg2EndOffset: number,
): number {
  const initial = readU32BE(external, initialOffset);
  const segs: ProgramSegment[] = [
    {
      ecuStart: readU32BE(external, seg1StartOffset),
      ecuEnd: readU32BE(external, seg1EndOffset),
    },
    {
      ecuStart: readU32BE(external, seg2StartOffset),
      ecuEnd: readU32BE(external, seg2EndOffset),
    },
  ];
  let crc = initial;
  for (const seg of segs) {
    const length = seg.ecuEnd - seg.ecuStart + 1;
    if (length <= 0) {
      throw new RangeError(
        `program CRC segment has non-positive length: [0x${seg.ecuStart.toString(16)}..0x${seg.ecuEnd.toString(16)}]`,
      );
    }
    const bytes = sliceEcuRange(seg.ecuStart, length, external, mpc);
    crc = crc32(bytes, crc);
  }
  // Reference stored value isn't part of the computation — it's the
  // output, written back to `storedOffset`. Kept as a parameter here
  // only to keep the primary/secondary call sites symmetric.
  void storedOffset;
  return crc;
}

function sliceEcuRange(
  ecuStart: number,
  length: number,
  external: Uint8Array,
  mpc: Uint8Array,
): Uint8Array {
  if (ecuStart >= EXTERNAL_FLASH_BASE) {
    const off = ecuStart - EXTERNAL_FLASH_BASE;
    if (off < 0 || off + length > external.length) {
      throw new RangeError(
        `external segment [0x${ecuStart.toString(16)} +${length}] out of bounds (external size 0x${external.length.toString(16)})`,
      );
    }
    return external.subarray(off, off + length);
  }
  const off = ecuStart;
  if (off < 0 || off + length > mpc.length) {
    throw new RangeError(
      `MPC segment [0x${ecuStart.toString(16)} +${length}] out of bounds (mpc size 0x${mpc.length.toString(16)})`,
    );
  }
  return mpc.subarray(off, off + length);
}

export interface ProgramChecksumEntry {
  stored: number;
  computed: number;
  ok: boolean;
}

export interface ProgramChecksumResult {
  primary: ProgramChecksumEntry;
  secondary: ProgramChecksumEntry;
  ok: boolean;
}

export function verifyProgramChecksum(
  external: Uint8Array,
  mpc: Uint8Array,
): ProgramChecksumResult {
  const primaryStored = readU32BE(external, PROG_CRC_PRIMARY_STORED_OFFSET);
  const primaryComputed = computeProgramCrc(
    external,
    mpc,
    PROG_CRC_PRIMARY_STORED_OFFSET,
    PROG_CRC_PRIMARY_INITIAL_OFFSET,
    PROG_CRC_PRIMARY_SEG1_START_OFFSET,
    PROG_CRC_PRIMARY_SEG1_END_OFFSET,
    PROG_CRC_PRIMARY_SEG2_START_OFFSET,
    PROG_CRC_PRIMARY_SEG2_END_OFFSET,
  );
  const secondaryStored = readU32BE(external, PROG_CRC_SECONDARY_STORED_OFFSET);
  const secondaryComputed = computeProgramCrc(
    external,
    mpc,
    PROG_CRC_SECONDARY_STORED_OFFSET,
    PROG_CRC_SECONDARY_INITIAL_OFFSET,
    PROG_CRC_SECONDARY_SEG1_START_OFFSET,
    PROG_CRC_SECONDARY_SEG1_END_OFFSET,
    PROG_CRC_SECONDARY_SEG2_START_OFFSET,
    PROG_CRC_SECONDARY_SEG2_END_OFFSET,
  );
  const primary: ProgramChecksumEntry = {
    stored: primaryStored,
    computed: primaryComputed,
    ok: primaryStored === primaryComputed,
  };
  const secondary: ProgramChecksumEntry = {
    stored: secondaryStored,
    computed: secondaryComputed,
    ok: secondaryStored === secondaryComputed,
  };
  return { primary, secondary, ok: primary.ok && secondary.ok };
}

/**
 * Recompute + write both program CRCs into the external buffer in
 * place. MPC is read-only here (segments may point into it but the
 * stored CRC lives at 0x60000 / 0x60340 in external flash).
 */
export function rewriteProgramChecksum(
  external: Uint8Array,
  mpc: Uint8Array,
): Uint8Array {
  const primary = computeProgramCrc(
    external,
    mpc,
    PROG_CRC_PRIMARY_STORED_OFFSET,
    PROG_CRC_PRIMARY_INITIAL_OFFSET,
    PROG_CRC_PRIMARY_SEG1_START_OFFSET,
    PROG_CRC_PRIMARY_SEG1_END_OFFSET,
    PROG_CRC_PRIMARY_SEG2_START_OFFSET,
    PROG_CRC_PRIMARY_SEG2_END_OFFSET,
  );
  writeU32BE(external, primary, PROG_CRC_PRIMARY_STORED_OFFSET);
  const secondary = computeProgramCrc(
    external,
    mpc,
    PROG_CRC_SECONDARY_STORED_OFFSET,
    PROG_CRC_SECONDARY_INITIAL_OFFSET,
    PROG_CRC_SECONDARY_SEG1_START_OFFSET,
    PROG_CRC_SECONDARY_SEG1_END_OFFSET,
    PROG_CRC_SECONDARY_SEG2_START_OFFSET,
    PROG_CRC_SECONDARY_SEG2_END_OFFSET,
  );
  writeU32BE(external, secondary, PROG_CRC_SECONDARY_STORED_OFFSET);
  return external;
}
