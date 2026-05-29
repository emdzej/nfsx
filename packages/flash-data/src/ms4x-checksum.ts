/**
 * MS42 / MS43 firmware checksum verification and recomputation.
 *
 * Per https://www.ms4x.net/ wiki (Siemens_MS42#Checksums, Siemens_MS43#Checksums)
 * and cross-verified against MS4x Flasher 1.6.0 decompilation.
 *
 * MS42: 3 CRC-16 checksums (Boot, Program, Calibration).
 * MS43: 3 CRC-16 + 2 32-bit addition checksums.
 *
 * For MS43 the addition checksums MUST be recomputed before the CRC-16s,
 * because the addition checksum result words sit inside the CRC-16 input
 * ranges.
 *
 * Algorithm: CRC-16/CCITT, polynomial 0x1021 (stored bit-reversed as
 * 0xA001 in the original MS4x Flasher source; the math here uses the
 * forward polynomial directly).
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
 * Detect MS42 vs MS43 by reading the Program-checksum header pointer.
 * MS42 firmware stores a pointer that resolves to 0x50306; MS43 to 0x6FDE0.
 * The header location (0x502CE) is the same for both — only the value differs.
 */
export function detectVariant(buf: Buffer): EcuVariant | null {
  if (buf.length !== EXPECTED_FILE_LENGTH) return null;

  const programPtr = readAddr24(buf, 0x502ce);
  if (programPtr === 0x50306) return 'MS42';
  if (programPtr === 0x6fde0) return 'MS43';

  // Fallback: probe each result address for plausible CRC storage.
  // (Bytes at the expected location are non-0xFF and the byte 2 ahead is
  // typically a small loop count.)
  const ms42Marker = buf[0x50306] !== 0xff || buf[0x50307] !== 0xff;
  const ms43Marker = buf[0x6fde0] !== 0xff || buf[0x6fde1] !== 0xff;
  if (ms42Marker && !ms43Marker) return 'MS42';
  if (ms43Marker && !ms42Marker) return 'MS43';
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
 * Method A from MS4x Flasher: single-region CRC-16, fixed metadata layout.
 * Shared between MS42 and MS43 (both have Boot at 0x3C24).
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
 * Methods a (Program) and B (Calibration) from MS4x Flasher: chained CRC-16
 * over multiple regions described by a header pointer chain.
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

// ── public API ──────────────────────────────────────────────────────

export function verifyChecksums(buf: Buffer): ChecksumReport {
  const variant = detectVariant(buf);
  if (!variant) {
    throw new Error(
      `Could not detect MS42/MS43 variant. File length=${buf.length} (expected ${EXPECTED_FILE_LENGTH}); ` +
        `program-pointer at 0x502CE = 0x${readAddr24(buf, 0x502ce).toString(16)} ` +
        `(expected 0x50306 for MS42, 0x6FDE0 for MS43).`,
    );
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

  if (variant === 'MS43') {
    // MS43-only addition checksums. We report the stored values but
    // can't compute without per-firmware-version range info.
    results.push({
      name: 'Program (add)',
      kind: 'add32',
      resultOffset: MS43_ADD_PROGRAM_OFFSET,
      resultBytes: 4,
      stored: readU32LE(buf, MS43_ADD_PROGRAM_OFFSET),
      computed: 0,
      match: false,
      ranges: [],
      supported: false,
      note: 'covered range is firmware-version-specific; not auto-computed',
    });
    results.push({
      name: 'Calibration (add)',
      kind: 'add32',
      resultOffset: MS43_ADD_CALIBRATION_OFFSET,
      resultBytes: 4,
      stored: readU32LE(buf, MS43_ADD_CALIBRATION_OFFSET),
      computed: 0,
      match: false,
      ranges: [],
      supported: false,
      note: 'covered range is firmware-version-specific; not auto-computed',
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
export function rewriteChecksums(buf: Buffer): ChecksumReport {
  // Important ordering for MS43: addition checksums first, then CRC-16s.
  // We don't rewrite the additions, but if a future caller adds support,
  // the call order must remain (add32-recompute) → (crc16-recompute).

  // Boot first (no dependency on others).
  const boot = computeBoot(buf);
  writeU16LE(buf, boot.computed, BOOT_DEF.resultOffset);

  // Program.
  const prog = computeHeaderDriven(buf, PROGRAM_DEF);
  writeU16LE(buf, prog.computed, prog.resultOffset);

  // Calibration.
  const cal = computeHeaderDriven(buf, CALIBRATION_DEF);
  writeU16LE(buf, cal.computed, cal.resultOffset);

  return verifyChecksums(buf);
}
