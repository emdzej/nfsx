/**
 * MS42 / MS43 firmware checksum verification and recomputation.
 *
 * Result locations match ms4x.net's documented offsets:
 *   MS42: 3 CRC-16 checksums (Boot, Program, Calibration)
 *   MS43: 3 CRC-16 + 2 32-bit addition checksums
 *
 * For MS43 the addition checksums MUST be recomputed before the CRC-16s,
 * because the addition checksum result words sit inside the CRC-16 input
 * ranges.
 *
 * Algorithm: CRC-16/CCITT, polynomial 0x1021 processed bit-reversed
 * (equivalent to working with the reversed constant 0xA001).
 */
import { Buffer } from 'node:buffer';

export type EcuVariant = 'MS42' | 'MS43';

export type ChecksumName =
  | 'Boot'
  | 'Program'
  | 'Calibration'
  | 'Program (add)'
  | 'Calibration (add)';

export type ChecksumKind = 'crc16' | 'add32';

export interface ChecksumRange {
  start: number;
  end: number;
}

export interface ChecksumResult {
  name: ChecksumName;
  kind: ChecksumKind;
  resultOffset: number;
  resultBytes: 2 | 4;
  stored: number;
  computed: number;
  match: boolean;
  ranges: ChecksumRange[];
  seed?: number;
  supported: boolean;
  note?: string;
}

export interface ChecksumReport {
  variant: EcuVariant;
  fileLength: number;
  results: ChecksumResult[];
  allValid: boolean;
}

export const EXPECTED_FILE_LENGTH = 0x80000;

// ── primitives ──────────────────────────────────────────────────────

function readU16LE(buf: Buffer, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function writeU16LE(buf: Buffer, val: number, off: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >> 8) & 0xff;
}

function readU32LE(buf: Buffer, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function writeU32LE(buf: Buffer, val: number, off: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >> 8) & 0xff;
  buf[off + 2] = (val >> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

/**
 * Read a 24-bit BMW-style address: u16 LE at off + u8 at off+2 shifted left 16.
 */
function readAddr24(buf: Buffer, off: number): number {
  return readU16LE(buf, off) | (buf[off + 2] << 16);
}

/**
 * CRC-16/CCITT, polynomial 0x1021, bit-reversed processing (matches MS4x
 * Flasher's table-based implementation). No final XOR.
 */
export function crc16Ccitt(buf: Buffer, start: number, end: number, seed: number): number {
  const POLY = 0xa001; // bit-reversed 0x1021
  let crc = seed & 0xffff;
  for (let i = start; i <= end; i++) {
    let byte = buf[i];
    for (let bit = 0; bit < 8; bit++) {
      const xor = (crc ^ byte) & 1;
      crc = (crc >> 1) ^ (xor ? POLY : 0);
      byte >>= 1;
    }
  }
  return crc & 0xffff;
}

/**
 * 32-bit addition checksum: sum of 16-bit LE words in the range, modulo 2^32.
 * MS43 uses this for the "monitor" / `_mon` parameter integrity.
 */
export function add32(buf: Buffer, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end - 1; i += 2) {
    sum = (sum + readU16LE(buf, i)) >>> 0;
  }
  return sum;
}

// ── variant detection ───────────────────────────────────────────────

/**
 * Detect MS42 vs MS43 by checking which family's CRC-result slots are
 * populated.
 *
 * Verified against real firmware BINs:
 *
 * | Offset | MS42 BIN | MS43 BIN |
 * |---|---|---|
 * | `0x4FEE0` (MS42 Calibration CRC) | populated | erased (FFFF) |
 * | `0x6FDE0` (MS43 Program CRC)    | erased (FFFF) | populated |
 *
 * MS42 firmware also has a header pointer at `0x502CE` that resolves to
 * `0x50306` (its Program CRC location); MS43 does NOT use the same
 * pointer mechanism (its value at `0x502CE` is unrelated). The pointer
 * is checked as a stronger MS42 confirmation but is not required for
 * detection.
 */
export function detectVariant(buf: Buffer): EcuVariant | null {
  if (buf.length !== EXPECTED_FILE_LENGTH) return null;

  const ms42Marker = readU16LE(buf, 0x4fee0) !== 0xffff;
  const ms43Marker = readU16LE(buf, 0x6fde0) !== 0xffff;

  if (ms42Marker && !ms43Marker) return 'MS42';
  if (ms43Marker && !ms42Marker) return 'MS43';

  // Both or neither marker fires — try the MS42-specific header pointer
  // as a tiebreaker (only valid for MS42).
  if (readAddr24(buf, 0x502ce) === 0x50306) return 'MS42';
  return null;
}

// ── per-variant tables ──────────────────────────────────────────────

interface HeaderDrivenCrc16 {
  name: ChecksumName;
  // Address of the 24-bit pointer that points to the result location.
  // The result location is also where the loop count and region table live.
  headerPtrOffset: number;
  // Offset of the u16 holding the low word of the seed address (the seed
  // address itself is split as another u16 just past the pointer).
  seedAddrLoOffset: number;
  seedAddrHiOffset: number;
}

/**
 * Boot CRC: single-region CRC-16, fixed metadata layout.
 * Shared between MS42 and MS43 (both have Boot CRC at 0x3C24).
 */
const BOOT_DEF = {
  name: 'Boot' as const,
  resultOffset: 0x3c24,
  startLoOffset: 0x3c28,
  startHiOffset: 0x3c2a,
  endLoOffset: 0x3c2c,
  endHiOffset: 0x3c2e,
  seedOffset: 0x3fe6,
};

/**
 * MS42 Program and Calibration CRCs: chained CRC-16 over multiple
 * regions described by a header pointer chain.
 *
 * Header layout at headerPtrOffset:
 *   [u16 LE] result address low
 *   [u8]     result address high (so [headerPtrOffset..headerPtrOffset+2] = 24-bit addr)
 *   [u16 LE] seed address low (at seedAddrLoOffset)
 *   [u16 LE] seed address high (at seedAddrHiOffset)
 *
 * At the result address:
 *   [+0]  u16: stored CRC result
 *   [+2]  u16: number of regions
 *   [+4]  u16: region 0 start low
 *   [+6]  u16: region 0 start high
 *   [+8]  u16: region 0 end low
 *   [+10] u16: region 0 end high
 *   ... 8 bytes per region
 *
 * At the seed address: u16 initial CRC seed value.
 */
const PROGRAM_DEF: HeaderDrivenCrc16 = {
  name: 'Program',
  headerPtrOffset: 0x502ce,
  seedAddrLoOffset: 0x502d2,
  seedAddrHiOffset: 0x502d4,
};

const CALIBRATION_DEF: HeaderDrivenCrc16 = {
  name: 'Calibration',
  headerPtrOffset: 0x502f2,
  seedAddrLoOffset: 0x502f6,
  seedAddrHiOffset: 0x502f8,
};

// ── compute helpers ─────────────────────────────────────────────────

function computeBoot(buf: Buffer): {
  stored: number;
  computed: number;
  ranges: ChecksumRange[];
  seed: number;
} {
  const startLo = readU16LE(buf, BOOT_DEF.startLoOffset);
  const startHi = readU16LE(buf, BOOT_DEF.startHiOffset);
  const endLo = readU16LE(buf, BOOT_DEF.endLoOffset);
  const endHi = readU16LE(buf, BOOT_DEF.endHiOffset);
  const seed = readU16LE(buf, BOOT_DEF.seedOffset);
  const start = (startHi << 16) | startLo;
  const end = (endHi << 16) | endLo;
  const stored = readU16LE(buf, BOOT_DEF.resultOffset);
  const computed = crc16Ccitt(buf, start, end, seed);
  return { stored, computed, ranges: [{ start, end }], seed };
}

function computeHeaderDriven(
  buf: Buffer,
  def: HeaderDrivenCrc16,
): {
  resultOffset: number;
  stored: number;
  computed: number;
  ranges: ChecksumRange[];
  seed: number;
} {
  const resultAddr = readAddr24(buf, def.headerPtrOffset);
  const seedAddrLo = readU16LE(buf, def.seedAddrLoOffset);
  const seedAddrHi = readU16LE(buf, def.seedAddrHiOffset);
  const seedAddr = (seedAddrHi << 16) | seedAddrLo;
  const seed = readU16LE(buf, seedAddr);
  const count = readU16LE(buf, resultAddr + 2);
  const ranges: ChecksumRange[] = [];
  let crc = seed;
  for (let i = 0; i < count; i++) {
    const entryBase = resultAddr + 4 + i * 8;
    const startLo = readU16LE(buf, entryBase);
    const startHi = readU16LE(buf, entryBase + 2);
    const endLo = readU16LE(buf, entryBase + 4);
    const endHi = readU16LE(buf, entryBase + 6);
    const start = (startHi << 16) | startLo;
    const end = (endHi << 16) | endLo;
    ranges.push({ start, end });
    crc = crc16Ccitt(buf, start, end, crc);
  }
  const stored = readU16LE(buf, resultAddr);
  return { resultOffset: resultAddr, stored, computed: crc, ranges, seed };
}

// ── MS43 addition-checksum positions ────────────────────────────────

/**
 * MS43 32-bit addition checksums (Siemens_MS43#Checksums on ms4x.net).
 * Each result is a u32 LE at the stated offset; the covered range was
 * not directly stated in the wiki Checksums section and must be derived
 * from firmware-version-specific switch tables that the wiki documents
 * under "Disabling Calibration Checksums".
 *
 * Since the byte-range for each addition checksum varies by firmware
 * version (430037 / 430055 / 430056 / 430064 / 430066 / 430069 have
 * different switch addresses), we report the stored values and flag
 * these checksums as "unsupported (range not detected)" rather than
 * miscomputing.
 *
 * If you have a known-good MS43 BIN of a specific firmware version, the
 * range can be recovered by trial: the add32 over [Program start, 0x6FDAE)
 * + [0x6FDB2, Program end] should equal the stored u32 at 0x6FDAE.
 */
const MS43_ADD_PROGRAM_OFFSET = 0x6fdae;
const MS43_ADD_CALIBRATION_OFFSET = 0x72ffc;

// ── MS43-specific layout ────────────────────────────────────────────
//
// MS43 uses a different mechanism from MS42:
//   - Boot CRC at 0x3C24 with the same metadata layout as MS42 (shared)
//   - Program CRC at 0x6FDE0 with INLINE metadata (count + region table)
//   - Calibration CRC at 0x73FE0 with INLINE metadata
//   - Two 32-bit addition checksums:
//       Program     @ 0x6FDAE
//       Calibration @ 0x72FFC
//
// Region addresses in MS43 metadata are stored as 32-bit ECU bus
// addresses (e.g. `0x90000` for program region 0). To get BIN file
// offsets we apply the high-byte translation in `translateMs43HighByte`:
// upper-word values 9/10/11/12/13/14 → 1/2/3/4/5/6 — the +0x80000
// ECU-to-BIN shift the C167 hardware applies. Upper-word 7 stays 7
// (calibration region; no shift).

function translateMs43HighByte(hi: number): number {
  switch (hi) {
    case 9: return 1;
    case 10: return 2;
    case 11: return 3;
    case 12: return 4;
    case 13: return 5;
    case 14: return 6;
    default: return hi;
  }
}

/** Read a (lo, hi)-pair u32 with MS43 high-byte translation applied. */
function readMs43Addr(buf: Buffer, off: number): number {
  const lo = readU16LE(buf, off);
  const hiRaw = readU16LE(buf, off + 2);
  const hi = translateMs43HighByte(hiRaw);
  return (hi << 16) | lo;
}

/**
 * MS43 inline-metadata layout for Program / Calibration CRCs:
 *   resultOffset+0  u16  CRC result
 *   resultOffset+2  u16  region count
 *   resultOffset+4  region 0: u16 start_lo, u16 start_hi (translated),
 *                            u16 end_lo, u16 end_hi (translated)
 *   resultOffset+12 region 1...
 */
interface Ms43InlineCrcDef {
  name: ChecksumName;
  /** Result/metadata location in the BIN. */
  resultOffset: number;
  /** Seed-pointer location: u16 lo at this offset, u16 hi at +2.
   *  Resolved via the same high-byte translation as region addresses. */
  seedPtrOffset: number;
  /**
   * Fallback seed *address* when the seed pointer reads as 0xFFFFFFFF
   * (empty / stripped). For Calibration this is BIN offset 0x7000C —
   * 12 bytes into the calibration region, at the start of the
   * calibration's version-ID ASCII block. (Matches the hard-coded
   * partial-BIN default of 12 bytes in the reference algorithm.)
   */
  fallbackSeedAddr: number | null;
}

const MS43_PROGRAM_DEF: Ms43InlineCrcDef = {
  name: 'Program',
  resultOffset: 0x6fde0,
  seedPtrOffset: 0x6ed42,
  // Program CRC has no partial-BIN fallback in the reference algorithm.
  fallbackSeedAddr: null,
};

const MS43_CALIBRATION_DEF: Ms43InlineCrcDef = {
  name: 'Calibration',
  resultOffset: 0x73fe0,
  seedPtrOffset: 0x6ed9a,
  fallbackSeedAddr: 0x7000c,
};

function computeMs43InlineCrc(
  buf: Buffer,
  def: Ms43InlineCrcDef,
): {
  stored: number;
  computed: number;
  ranges: ChecksumRange[];
  seed: number;
} {
  // Resolve seed address: follow the (lo, hi) pointer with high-byte
  // translation. If the pointer is empty (0xFFFFFFFF) — which can
  // happen on stripped/edited BINs — fall back to the def's
  // fallbackSeedAddr.
  const seedAddrLo = readU16LE(buf, def.seedPtrOffset);
  const seedAddrHi = readU16LE(buf, def.seedPtrOffset + 2);
  let seedAddr: number;
  if (seedAddrLo === 0xffff && seedAddrHi === 0xffff) {
    if (def.fallbackSeedAddr === null) {
      throw new Error(
        `${def.name}: seed pointer at 0x${def.seedPtrOffset.toString(16)} is empty ` +
          `and no fallback is known for this checksum.`,
      );
    }
    seedAddr = def.fallbackSeedAddr;
  } else {
    seedAddr = (translateMs43HighByte(seedAddrHi) << 16) | seedAddrLo;
  }
  const seed = readU16LE(buf, seedAddr);
  // Region table.
  const count = readU16LE(buf, def.resultOffset + 2);
  const ranges: ChecksumRange[] = [];
  let crc = seed;
  for (let i = 0; i < count; i++) {
    const entryBase = def.resultOffset + 4 + i * 8;
    const start = readMs43Addr(buf, entryBase);
    const end = readMs43Addr(buf, entryBase + 4);
    ranges.push({ start, end });
    crc = crc16Ccitt(buf, start, end, crc);
  }
  const stored = readU16LE(buf, def.resultOffset);
  return { stored, computed: crc, ranges, seed };
}

/**
 * MS43 32-bit addition checksum — used for the program / calibration
 * `_mon` (monitor) parameters.
 *
 *   add32 = initial_accumulator + sum_u16_LE(BIN[region_0]) + sum_u16_LE(BIN[region_1])
 *           (mod 2^32)
 *
 * Both Program and Calibration variants share the same pattern with
 * different metadata locations. The `_mon` regions are small (tens to
 * hundreds of bytes each) and sit inside the larger program /
 * calibration data blocks.
 *
 * Region addresses use the same high-byte translation as the CRC
 * regions (so a stored address of `0x000D0000` becomes BIN offset
 * `0x00050000` via `translateMs43HighByte`).
 */
interface Ms43Add32Def {
  name: ChecksumName;
  /** u32 LE result location in the BIN. */
  resultOffset: number;
  /** u32 LE initial-accumulator location (a "magic" preamble like 0xA5A5A5A5). */
  initialOffset: number;
  /**
   * Region table: each entry is 8 bytes (u16 start_lo, u16 start_hi,
   * u16 end_lo, u16 end_hi); always 2 entries for the MS43 add32 routines.
   */
  regionsOffset: number;
}

const MS43_PROGRAM_ADD32: Ms43Add32Def = {
  name: 'Program (add)',
  resultOffset: 0x6fdae,
  initialOffset: 0x6fdb2,
  regionsOffset: 0x6fdbe,
};

const MS43_CALIBRATION_ADD32: Ms43Add32Def = {
  name: 'Calibration (add)',
  resultOffset: 0x72ffc,
  initialOffset: 0x6fdb8,
  regionsOffset: 0x6fdce,
};

function computeMs43Add32(
  buf: Buffer,
  def: Ms43Add32Def,
): {
  stored: number;
  computed: number;
  ranges: ChecksumRange[];
} {
  const initial = readU32LE(buf, def.initialOffset);
  const ranges: ChecksumRange[] = [];
  let sum = initial >>> 0;
  // Two regions, 8 bytes per entry.
  for (let i = 0; i < 2; i++) {
    const off = def.regionsOffset + i * 8;
    const startLo = readU16LE(buf, off);
    const startHi = readU16LE(buf, off + 2);
    const endLo = readU16LE(buf, off + 4);
    const endHi = readU16LE(buf, off + 6);
    const start = (translateMs43HighByte(startHi) << 16) | startLo;
    const end = (translateMs43HighByte(endHi) << 16) | endLo;
    ranges.push({ start, end });
    // Sum u16 LE words in [start, end). end is exclusive (the C#
    // algorithm subtracts to compute the byte length, then divides
    // by 2 for word count).
    for (let p = start; p <= end - 1; p += 2) {
      const w = buf[p] | (buf[p + 1] << 8);
      sum = (sum + w) >>> 0;
    }
  }
  const stored = readU32LE(buf, def.resultOffset);
  return { stored, computed: sum >>> 0, ranges };
}

function verifyMs43Checksums(buf: Buffer): ChecksumReport {
  const results: ChecksumResult[] = [];

  // Boot: same metadata + algorithm as MS42 (shared fixed offsets).
  {
    const r = computeBoot(buf);
    results.push({
      name: 'Boot',
      kind: 'crc16',
      resultOffset: BOOT_DEF.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  }

  // Program (inline metadata at 0x6FDE0).
  {
    const r = computeMs43InlineCrc(buf, MS43_PROGRAM_DEF);
    results.push({
      name: 'Program',
      kind: 'crc16',
      resultOffset: MS43_PROGRAM_DEF.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  }

  // Calibration (inline metadata at 0x73FE0).
  {
    const r = computeMs43InlineCrc(buf, MS43_CALIBRATION_DEF);
    results.push({
      name: 'Calibration',
      kind: 'crc16',
      resultOffset: MS43_CALIBRATION_DEF.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  }

  // add32 routines (Program and Calibration). Both compute:
  // initial_accumulator + sum_u16_LE(BIN over 2 regions) mod 2^32.
  {
    const r = computeMs43Add32(buf, MS43_PROGRAM_ADD32);
    results.push({
      name: 'Program (add)',
      kind: 'add32',
      resultOffset: MS43_PROGRAM_ADD32.resultOffset,
      resultBytes: 4,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      supported: true,
    });
  }
  {
    const r = computeMs43Add32(buf, MS43_CALIBRATION_ADD32);
    results.push({
      name: 'Calibration (add)',
      kind: 'add32',
      resultOffset: MS43_CALIBRATION_ADD32.resultOffset,
      resultBytes: 4,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      supported: true,
    });
  }

  const supportedResults = results.filter((r) => r.supported);
  const allValid = supportedResults.length > 0 && supportedResults.every((r) => r.match);
  return {
    variant: 'MS43',
    fileLength: buf.length,
    results,
    allValid,
  };
}

// ── public API ──────────────────────────────────────────────────────

export interface VerifyChecksumsOptions {
  /**
   * Override variant detection. Default: auto-detect via {@link detectVariant}.
   * Pass an explicit `EcuVariant` to bypass detection (useful when a BIN
   * has been edited in a way that perturbs the header pointer at 0x502CE
   * but you know the firmware variant for certain).
   */
  variant?: EcuVariant;
  /**
   * MS42-only override for the seed address. By default the cal-only
   * path uses `0x4800C` (verified against MS42 0110AD; conventional
   * across most MS42 firmwares — the seed-address pointer at 0x502F6/
   * 0x502F8 in a full BIN lands here). Pass an alternate ECU absolute
   * address if you know your firmware deviates. Ignored on full BINs
   * (the pointer is read straight from 0x502F6/0x502F8).
   */
  ms42SeedAddress?: number;
}

/** Cal-only file lengths recognised by {@link verifyChecksums}. */
const MS42_CAL_LENGTH = 0x8000;
const MS43_CAL_LENGTH = 0x10000;

/**
 * Standard MS42 calibration block layout (verified against MS42 0110AD).
 * The seed address is firmware-specific in theory; in practice the
 * standard MS42 convention places it at `0x4800C` (inside the cal block).
 */
const MS42_CAL_BLOCK_ECU_OFFSET = 0x48000;
const MS42_CAL_RESULT_ECU_OFFSET = 0x4fee0;
const MS42_DEFAULT_SEED_ECU_OFFSET = 0x4800c;

const MS43_CAL_BLOCK_ECU_OFFSET = 0x70000;

/**
 * For a cal-only buffer, synthesize a full 0x80000 BIN with 0xFF padding
 * and the cal data placed at the correct ECU offset. For MS42, also
 * write the program-block pointers that {@link computeHeaderDriven}
 * reads — so the existing compute path "just works" against the
 * synthesized buffer. MS43 needs no extra setup: its seed pointer at
 * 0x6ED9A is naturally 0xFFFF here, triggering the fallback to 0x7000C
 * which IS in the cal block.
 */
function synthesizeFullFromCal(
  calBuf: Buffer,
  variant: EcuVariant,
  ms42SeedAddress: number,
): Buffer {
  const out = Buffer.alloc(EXPECTED_FILE_LENGTH, 0xff);
  const ecuOffset =
    variant === 'MS42' ? MS42_CAL_BLOCK_ECU_OFFSET : MS43_CAL_BLOCK_ECU_OFFSET;
  calBuf.copy(out, ecuOffset);
  if (variant === 'MS42') {
    // Header pointer at 0x502F2 (24-bit LE): result address.
    out[0x502f2] = MS42_CAL_RESULT_ECU_OFFSET & 0xff;
    out[0x502f3] = (MS42_CAL_RESULT_ECU_OFFSET >> 8) & 0xff;
    out[0x502f4] = (MS42_CAL_RESULT_ECU_OFFSET >> 16) & 0xff;
    // Seed address (u16 LE lo at 0x502F6, u16 LE hi at 0x502F8).
    writeU16LE(out, ms42SeedAddress & 0xffff, 0x502f6);
    writeU16LE(out, (ms42SeedAddress >>> 16) & 0xffff, 0x502f8);
  }
  return out;
}

function detectCalVariantFromSize(length: number): EcuVariant | null {
  if (length === MS42_CAL_LENGTH) return 'MS42';
  if (length === MS43_CAL_LENGTH) return 'MS43';
  return null;
}

/**
 * Verify just the calibration CRC against a synthesized 512K buffer.
 * Boot/Program/add32 are reported as `supported: false` because their
 * source bytes don't exist in a calibration-only dump.
 */
function verifyCalibrationOnly(
  fullBuf: Buffer,
  variant: EcuVariant,
  origFileLength: number,
): ChecksumReport {
  const results: ChecksumResult[] = [];
  const unsupportedNote = (name: ChecksumName): ChecksumResult => ({
    name,
    kind: name.includes('add') ? 'add32' : 'crc16',
    resultOffset: 0,
    resultBytes: name.includes('add') ? 4 : 2,
    stored: 0,
    computed: 0,
    match: false,
    ranges: [],
    supported: false,
  });
  results.push(unsupportedNote('Boot'));
  results.push(unsupportedNote('Program'));

  if (variant === 'MS42') {
    const r = computeHeaderDriven(fullBuf, CALIBRATION_DEF);
    results.push({
      name: 'Calibration',
      kind: 'crc16',
      resultOffset: r.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  } else {
    const r = computeMs43InlineCrc(fullBuf, MS43_CALIBRATION_DEF);
    results.push({
      name: 'Calibration',
      kind: 'crc16',
      resultOffset: MS43_CALIBRATION_DEF.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
    results.push(unsupportedNote('Program (add)'));
    results.push(unsupportedNote('Calibration (add)'));
  }

  const supportedResults = results.filter((r) => r.supported);
  const allValid = supportedResults.length > 0 && supportedResults.every((r) => r.match);
  return {
    variant,
    fileLength: origFileLength,
    results,
    allValid,
  };
}

export function verifyChecksums(
  buf: Buffer,
  options: VerifyChecksumsOptions = {},
): ChecksumReport {
  // Cal-only short buffers: synthesize a full BIN with cal data placed
  // at the right ECU offset, then run the standard verification but
  // skip non-calibration checksums (their bytes are missing).
  const calVariant = detectCalVariantFromSize(buf.length);
  if (calVariant) {
    const variant = options.variant ?? calVariant;
    if (variant !== calVariant) {
      throw new Error(
        `File length ${buf.length} indicates ${calVariant} cal-only but ` +
          `caller forced variant=${variant}.`,
      );
    }
    const fullBuf = synthesizeFullFromCal(
      buf,
      variant,
      options.ms42SeedAddress ?? MS42_DEFAULT_SEED_ECU_OFFSET,
    );
    return verifyCalibrationOnly(fullBuf, variant, buf.length);
  }

  if (buf.length !== EXPECTED_FILE_LENGTH) {
    throw new Error(
      `Bad BIN length: ${buf.length} (expected ${EXPECTED_FILE_LENGTH}, ` +
        `${MS42_CAL_LENGTH} for MS42 cal-only, or ${MS43_CAL_LENGTH} for MS43 cal-only)`,
    );
  }
  const variant = options.variant ?? detectVariant(buf);
  if (!variant) {
    throw new Error(
      `Could not auto-detect MS42/MS43 variant. ` +
        `0x4FEE0 (MS42 marker) = 0x${readU16LE(buf, 0x4fee0).toString(16).padStart(4, '0')}, ` +
        `0x6FDE0 (MS43 marker) = 0x${readU16LE(buf, 0x6fde0).toString(16).padStart(4, '0')}. ` +
        `Pass { variant: 'MS42' | 'MS43' } to override.`,
    );
  }

  if (variant === 'MS43') {
    return verifyMs43Checksums(buf);
  }

  const results: ChecksumResult[] = [];

  // Boot (shared)
  {
    const r = computeBoot(buf);
    results.push({
      name: 'Boot',
      kind: 'crc16',
      resultOffset: BOOT_DEF.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  }

  // Program (header-driven, shared layout)
  {
    const r = computeHeaderDriven(buf, PROGRAM_DEF);
    results.push({
      name: 'Program',
      kind: 'crc16',
      resultOffset: r.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  }

  // Calibration (header-driven, shared layout)
  {
    const r = computeHeaderDriven(buf, CALIBRATION_DEF);
    results.push({
      name: 'Calibration',
      kind: 'crc16',
      resultOffset: r.resultOffset,
      resultBytes: 2,
      stored: r.stored,
      computed: r.computed,
      match: r.stored === r.computed,
      ranges: r.ranges,
      seed: r.seed,
      supported: true,
    });
  }

  const supportedResults = results.filter((r) => r.supported);
  const allValid = supportedResults.length > 0 && supportedResults.every((r) => r.match);

  return {
    variant,
    fileLength: buf.length,
    results,
    allValid,
  };
}

/**
 * Recompute checksums and write them in-place. Only CRC-16 checksums are
 * rewritten — the MS43 addition checksums need per-firmware-version range
 * info we don't have here. Returns the post-rewrite report.
 *
 * On MS43, if you change `_mon` parameters that affect the addition
 * checksums, you MUST update those addition checksums by hand or with a
 * version-aware tool BEFORE calling this — otherwise the CRC-16s will
 * lock in a stale addition-checksum value.
 */
export function rewriteChecksums(
  buf: Buffer,
  options: VerifyChecksumsOptions = {},
): ChecksumReport {
  // Cal-only short buffers: synthesize a full BIN, recompute calibration
  // CRC into the synthesized buffer, then copy the cal block back into
  // the caller's tight buffer in-place.
  const calVariant = detectCalVariantFromSize(buf.length);
  if (calVariant) {
    const variant = options.variant ?? calVariant;
    if (variant !== calVariant) {
      throw new Error(
        `File length ${buf.length} indicates ${calVariant} cal-only but ` +
          `caller forced variant=${variant}.`,
      );
    }
    const fullBuf = synthesizeFullFromCal(
      buf,
      variant,
      options.ms42SeedAddress ?? MS42_DEFAULT_SEED_ECU_OFFSET,
    );
    const calEcuOffset =
      variant === 'MS42' ? MS42_CAL_BLOCK_ECU_OFFSET : MS43_CAL_BLOCK_ECU_OFFSET;
    if (variant === 'MS42') {
      const cal = computeHeaderDriven(fullBuf, CALIBRATION_DEF);
      writeU16LE(fullBuf, cal.computed, cal.resultOffset);
    } else {
      const cal = computeMs43InlineCrc(fullBuf, MS43_CALIBRATION_DEF);
      writeU16LE(fullBuf, cal.computed, MS43_CALIBRATION_DEF.resultOffset);
    }
    fullBuf.copy(buf, 0, calEcuOffset, calEcuOffset + buf.length);
    return verifyChecksums(buf, options);
  }

  // Validate variant up-front (with optional override) so we fail fast
  // before mutating anything.
  if (buf.length !== EXPECTED_FILE_LENGTH) {
    throw new Error(
      `Bad BIN length: ${buf.length} (expected ${EXPECTED_FILE_LENGTH}, ` +
        `${MS42_CAL_LENGTH} for MS42 cal-only, or ${MS43_CAL_LENGTH} for MS43 cal-only)`,
    );
  }
  const variant = options.variant ?? detectVariant(buf);
  if (!variant) {
    throw new Error(
      `Could not auto-detect MS42/MS43 variant for rewrite. ` +
        `Pass { variant: 'MS42' | 'MS43' } to override.`,
    );
  }

  if (variant === 'MS43') {
    // CRITICAL ORDERING per ms4x.net wiki: addition checksums MUST be
    // recomputed BEFORE the CRC-16s, because the add32 result bytes
    // sit inside the regions the CRC-16s cover.

    // Program add32 → 0x6FDAE (inside Program CRC's input range).
    const progAdd = computeMs43Add32(buf, MS43_PROGRAM_ADD32);
    writeU32LE(buf, progAdd.computed, MS43_PROGRAM_ADD32.resultOffset);

    // Calibration add32 → 0x72FFC (inside Calibration CRC's input range).
    const calAdd = computeMs43Add32(buf, MS43_CALIBRATION_ADD32);
    writeU32LE(buf, calAdd.computed, MS43_CALIBRATION_ADD32.resultOffset);

    // Then CRC-16s (Boot via shared computeBoot, Program/Calibration
    // via computeMs43InlineCrc).
    const boot = computeBoot(buf);
    writeU16LE(buf, boot.computed, BOOT_DEF.resultOffset);

    const prog = computeMs43InlineCrc(buf, MS43_PROGRAM_DEF);
    writeU16LE(buf, prog.computed, MS43_PROGRAM_DEF.resultOffset);

    const cal = computeMs43InlineCrc(buf, MS43_CALIBRATION_DEF);
    writeU16LE(buf, cal.computed, MS43_CALIBRATION_DEF.resultOffset);

    return verifyChecksums(buf, { variant });
  }

  // MS42 path. Important ordering note: if a future caller adds MS43
  // add32 support, the call order must remain
  // (add32-recompute) → (crc16-recompute) — the CRC-16 ranges include
  // the add32 result bytes.

  // Boot first (no dependency on others).
  const boot = computeBoot(buf);
  writeU16LE(buf, boot.computed, BOOT_DEF.resultOffset);

  // Program.
  const prog = computeHeaderDriven(buf, PROGRAM_DEF);
  writeU16LE(buf, prog.computed, prog.resultOffset);

  // Calibration.
  const cal = computeHeaderDriven(buf, CALIBRATION_DEF);
  writeU16LE(buf, cal.computed, cal.resultOffset);

  return verifyChecksums(buf, { variant });
}
