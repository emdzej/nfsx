/**
 * Per-ECU detection + region tables for direct (DS2) flashing.
 *
 * The IDENT response from a DS2 ECU includes ASCII identification bytes;
 * `identifyEcu()` heuristically matches against known signatures and
 * returns the EcuVariant + the writable region tables for both FULL and
 * CALIBRATION modes.
 *
 * Region tables describe the addresses tools actually push through the
 * DS2 wire (a subset of the broader ECU memory map). Going outside
 * them per the protocol is possible (§5/§7) but no DS2 tool exercises
 * it; for bench-only out-of-range writes use the bootmode path in
 * `@emdzej/nfsx-bootmode`.
 */
import { Buffer } from 'node:buffer';

export type EcuVariant = 'MS42' | 'MS43' | 'GS20';
export type FlashMode = 'full' | 'calibration';

export interface FlashRegion {
  /** Inclusive start address on the ECU side. */
  start: number;
  /** Inclusive end address on the ECU side. */
  end: number;
  /**
   * BIN-file source offset that corresponds to `start`. For most variants
   * this equals `start` (1:1 mapping), but one MS43-class layout has a
   * +0x80000 ECU/BIN shift for one region.
   */
  binOffset: number;
}

export interface EcuProfile {
  variant: EcuVariant;
  /** 8-bit diagnostic address on the K-line. */
  ds2Addr: number;
  /** Block size used in write/read telegrams. */
  blockSize: number;
  /** Expected total BIN size (the source file the host loads). */
  binSize: number;
  /** FULL-flash region table — every region the DS2 flow updates. */
  fullRegions: ReadonlyArray<FlashRegion>;
  /** CALIBRATION-only flash region table — subset of fullRegions. */
  calibrationRegions: ReadonlyArray<FlashRegion>;
  /** Substrings the IDENT response should contain to match this variant. */
  identSignatures: ReadonlyArray<string>;
  /**
   * True iff the calibration-vs-full distinction is verified for this
   * variant. False iff `calibrationRegions` just falls back to
   * `fullRegions` because no actual calibration-only mode was
   * established.
   */
  calibrationVerified: boolean;
}

/**
 * MS42 — Siemens, BMW M52TU, Infineon C167CR_SR + AMD 29F400BB.
 *
 * FULL: three regions, 1:1 BIN/ECU mapping, covering 0x11000-0x7FFFF
 * with gaps for boot and metadata.
 * CALIBRATION: writes only the 32 KB data block at 0x48000-0x4FFEF.
 */
const MS42_PROFILE: EcuProfile = {
  variant: 'MS42',
  ds2Addr: 0x12,
  blockSize: 246,
  binSize: 0x80000,
  fullRegions: [
    { start: 0x11000, end: 0x3ffff, binOffset: 0x11000 }, // lower program (~188 KB)
    { start: 0x48000, end: 0x4ffef, binOffset: 0x48000 }, // data / calibration (32 KB)
    { start: 0x5002c, end: 0x7ffff, binOffset: 0x5002c }, // upper program (~192 KB)
  ],
  calibrationRegions: [
    // Partial-write covers only the 32 KB data block at ECU
    // 0x48000-0x4FFEF. This is the region containing the Calibration
    // CRC at 0x4FEE0 (per ms4x.net wiki); the Boot CRC (at 0x3C24, in
    // the lower program region) and Program CRC (at 0x50306, in the
    // upper program region) don't change under calibration edits and
    // don't need updating.
    { start: 0x48000, end: 0x4ffef, binOffset: 0x48000 },
  ],
  identSignatures: ['MS42', 'MS_42'],
  calibrationVerified: true,
};

/**
 * MS43 — Siemens, BMW M54, Infineon C167CS-32F + AMD AM29F400.
 *
 * FULL: two regions. Program at ECU 0x90000+0x5FFF0 sourced from
 * BIN 0x10000+0x5FFF0 with a +0x80000 ECU shift; data at ECU
 * 0x70000+0xFFEF sourced from BIN 0x70000+0xFFEF direct.
 */
const MS43_PROFILE: EcuProfile = {
  variant: 'MS43',
  ds2Addr: 0x12,
  blockSize: 246,
  binSize: 0x80000,
  fullRegions: [
    {
      start: 0x90000,
      end: 0x90000 + 0x5fff0 - 1,
      binOffset: 0x10000,
    },
    {
      start: 0x70000,
      end: 0x70000 + 0xffef - 1,
      binOffset: 0x70000,
    },
  ],
  calibrationRegions: [
    // Partial-write covers ONLY the 64 KB data block at ECU
    // 0x70000-0x7FFEE. Contains MS43's Calibration CRC at 0x73FE0 and
    // Calibration add32 at 0x72FFC (per ms4x.net wiki). The Program
    // CRC (0x6FDE0) and Program add32 (0x6FDAE) live in the other
    // region; they don't change under calibration edits.
    {
      start: 0x70000,
      end: 0x70000 + 0xffef - 1,
      binOffset: 0x70000,
    },
  ],
  identSignatures: ['MS43', 'MS_43'],
  calibrationVerified: true,
};

/**
 * GS20 — Siemens transmission control unit (TCU).
 *
 * BIN format: **512 KB (0x80000)** — same total size as the MS-class
 * engine BIN. Of that, only two regions are written; bytes
 * `0x00000-0x0FFFF` and `0x60000-0x7FFFF` are header / padding.
 *
 *   BIN `0x10000-0x1FFFF` → ECU `0x90000-0x9FFFF`  (64 KB program)
 *   BIN `0x20000-0x5FFFF` → ECU `0xA0000-0xDFFFF`  (256 KB data)
 *
 * CALIBRATION (partial-write) — rewrites only the 64 KB program block
 * at ECU `0x90000-0x9FFFF`, sourced from BIN `0x10000-0x1FFFF` when a
 * full 512 KB BIN is supplied.
 */
const GS20_PROFILE: EcuProfile = {
  variant: 'GS20',
  ds2Addr: 0x32,
  blockSize: 246,
  binSize: 0x80000,
  fullRegions: [
    // erase 0xA0000, write ECU[0xA0000..0xDFFFF] from BIN[0x20000..0x5FFFF]
    { start: 0xa0000, end: 0xdffff, binOffset: 0x20000 },
    // erase 0x90000, write ECU[0x90000..0x9FFFF] from BIN[0x10000..0x1FFFF]
    { start: 0x90000, end: 0x9ffff, binOffset: 0x10000 },
  ],
  calibrationRegions: [
    // partial-write covers ONLY ECU[0x90000..0x9FFFF]
    { start: 0x90000, end: 0x9ffff, binOffset: 0x10000 },
  ],
  identSignatures: ['GS20', 'GS_20'],
  calibrationVerified: true,
};

export const ALL_PROFILES: ReadonlyArray<EcuProfile> = [
  MS42_PROFILE,
  MS43_PROFILE,
  GS20_PROFILE,
];

/**
 * Try to identify the ECU from the bytes of an IDENT response payload
 * (the bytes after STATUS in the response, not including XOR).
 *
 * Returns the matched profile, or null if none of the signatures fired.
 */
export function identifyEcu(identPayload: Buffer): EcuProfile | null {
  const ascii = identPayload.toString('ascii');
  for (const profile of ALL_PROFILES) {
    for (const sig of profile.identSignatures) {
      if (ascii.includes(sig)) return profile;
    }
  }
  return null;
}

export function getProfile(variant: EcuVariant): EcuProfile {
  const p = ALL_PROFILES.find((x) => x.variant === variant);
  if (!p) throw new Error(`unknown ECU variant: ${variant}`);
  return p;
}

export function pickRegions(profile: EcuProfile, mode: FlashMode): ReadonlyArray<FlashRegion> {
  return mode === 'full' ? profile.fullRegions : profile.calibrationRegions;
}

/**
 * Total bytes the host will push to the wire for a given mode, ignoring
 * 0xFF skipping. Useful for progress accounting.
 */
export function totalBytesForMode(profile: EcuProfile, mode: FlashMode): number {
  let n = 0;
  for (const r of pickRegions(profile, mode)) n += r.end - r.start + 1;
  return n;
}
