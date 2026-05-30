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
  /** Block size for programming-mode writes (after SEED/KEY + erase). */
  blockSize: number;
  /**
   * Block size for diagnostic-session memory reads (cmd 0x06).
   * Smaller than `blockSize` — the ECU enforces a lower cap on raw reads
   * than on programming-mode writes. Verified against MS42 at 123 bytes.
   */
  readBlockSize: number;
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
 * FULL: two flash regions matching MS4x Flasher's 512 KB layout.
 *
 *   0x00000-0x0BFFF — internal C167 flash (boot block + lower headers)
 *   0x0C000-0x10FFF — SKIPPED: C167 SFR / internal-RAM window. Reading
 *                     via DS2 here returns live device state (registers,
 *                     pending interrupt latches, RAM contents) — NOT
 *                     flash. The reference dump has 0xFF padding here.
 *   0x11000-0x7FFFF — external AMD 29F400 flash (program / data / upper).
 *
 * CALIBRATION: only the 32 KB data block at 0x48000-0x4FFFF.
 */
const MS42_PROFILE: EcuProfile = {
  variant: 'MS42',
  ds2Addr: 0x12,
  blockSize: 246,
  readBlockSize: 123,
  binSize: 0x80000,
  fullRegions: [
    { start: 0x00000, end: 0x0bfff, binOffset: 0x00000 }, // C167 internal flash (48 KB)
    { start: 0x11000, end: 0x7ffff, binOffset: 0x11000 }, // external flash (~444 KB)
  ],
  calibrationRegions: [
    // Partial-write covers only the 32 KB data block at ECU
    // 0x48000-0x4FFFF. This is the region containing the Calibration
    // CRC at 0x4FEE0 (per ms4x.net wiki); the Boot CRC (at 0x3C24, in
    // the lower program region) and Program CRC (at 0x50306, in the
    // upper program region) don't change under calibration edits and
    // don't need updating.
    { start: 0x48000, end: 0x4ffff, binOffset: 0x48000 },
  ],
  // BMW IDENT response carries the ECU's Bosch HW ID as the first ASCII
  // token (e.g. `1430844` for MS42 M52TU). `MS42`/`MS_42` are never on
  // the wire — they're our internal labels.
  identSignatures: ['1430844', '7503355'],
  calibrationVerified: true,
};

/**
 * MS43 — Siemens, BMW M54, Infineon C167CS-32F + AMD AM29F400.
 *
 * FULL: three regions matching MS4x Flasher's 512 KB layout.
 *
 *   ECU 0x00000-0x0BFFF → BIN 0x00000  C167 internal flash (48 KB)
 *   skipped 0x0C000-0x0FFFF              C167 SFR / RAM window
 *   ECU 0x90000-0xEFFFF → BIN 0x10000  external program (384 KB, with
 *                                       MS43's high-byte translation
 *                                       0x9 → 0x1 applied on read)
 *   ECU 0x70000-0x7FFFF → BIN 0x70000  external calibration (64 KB)
 *
 * CALIBRATION: only the 64 KB block at ECU 0x70000-0x7FFFF.
 */
const MS43_PROFILE: EcuProfile = {
  variant: 'MS43',
  ds2Addr: 0x12,
  blockSize: 246,
  readBlockSize: 123,
  binSize: 0x80000,
  fullRegions: [
    { start: 0x00000, end: 0x0bfff, binOffset: 0x00000 },
    { start: 0x90000, end: 0xeffff, binOffset: 0x10000 },
    { start: 0x70000, end: 0x7ffff, binOffset: 0x70000 },
  ],
  calibrationRegions: [
    // ECU 0x70000-0x7FFFF contains Calibration CRC (0x73FE0), Calibration
    // add32 (0x72FFC), and the 4-byte calibration trailer at 0x7FFF0
    // (per ms4x.net wiki). Boot CRC (0x3C24) and Program CRC (0x6FDE0)
    // live in the program region and don't change under calibration edits.
    { start: 0x70000, end: 0x7ffff, binOffset: 0x70000 },
  ],
  // MS43 Bosch HW IDs (M54). Verified on the wire: `7545150`. Others
  // come from public docs (`1430866`, `7516126`, `7508552`) — add new
  // IDs as they're observed.
  identSignatures: ['1430866', '7516126', '7508552', '7545150'],
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
  readBlockSize: 123,
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
  // GS20 (5HP19/24) Bosch HW IDs — placeholder list; refine when probed
  // against a real TCU.
  identSignatures: ['1422778', '1422779'],
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
