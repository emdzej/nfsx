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
  /**
   * Erase block this region belongs to. Multiple regions can share the
   * same erase address — for MS42 full mode the single erase at
   * 0x11000 wipes a range that spans BOTH the lower (0x11000-0x3FFFF)
   * and upper (0x5002C-0x7FFFF) program regions, so both declare
   * `eraseAddr: 0x11000`. Defaults to `start` when omitted.
   */
  eraseAddr?: number;
}

export interface EcuProfile {
  variant: EcuVariant;
  /** 8-bit diagnostic address on the K-line. */
  ds2Addr: number;
  /**
   * Max bytes per `0x07 0x02` write telegram after SEED/KEY + erase.
   * Verified against upstream tooling (base-class constructor 4th
   * argument): 118 for MS42/MS43/(GS20 protocol class `p`), 246 for
   * the high-capacity TCU classes (`r`, `R`, `q`, `Q`).
   */
  blockSize: number;
  /**
   * Max bytes per cmd 0x06 memory-read request (base-class 3rd
   * argument): 123 for MS42/MS43/p, 251 for r/R/q/Q. Reading past the
   * cap returns DS2 status 0xB0.
   */
  readBlockSize: number;
  /** Expected total BIN size (the source file the host loads). */
  binSize: number;
  /**
   * FULL-flash WRITE region table — what the host erases + programs.
   * Mirrors upstream tooling's per-variant L::A() path. **DO NOT** include
   * the bootloader or reserved flash trailer bytes here; doing so will
   * brick the ECU. Reads use {@link readFullRegions} (broader).
   */
  fullRegions: ReadonlyArray<FlashRegion>;
  /** CALIBRATION-only WRITE region table. Subset of `fullRegions`. */
  calibrationRegions: ReadonlyArray<FlashRegion>;
  /**
   * FULL-flash READ region table — broader than `fullRegions`. Includes
   * the bootloader (read-only) and the last bytes of each programmable
   * region that the WRITE path correctly skips. Mirrors upstream tooling's
   * dump output, byte-for-byte. Defaults to `fullRegions` when omitted.
   */
  readFullRegions?: ReadonlyArray<FlashRegion>;
  /**
   * CALIBRATION READ region — includes the full block including the
   * checksum trailer that's read-only. Defaults to `calibrationRegions`.
   */
  readCalibrationRegions?: ReadonlyArray<FlashRegion>;
  /**
   * 6-character dispatch key for the upstream tooling detection flow.
   * Obtained by: send DS2 cmd 0x0D → take bytes 57-59 of the response
   * as a 3-byte memory address → send cmd 0x06 0x00 [addr] 0x08 → read
   * 8 ASCII bytes → first 6 chars are the key. Verified against the
   * upstream (engine, addr 0x12) and (TCU, addr
   * 0x32) dispatcher tables in the upstream reference implementation.
   */
  identKey: string;
  /**
   * Legacy / fallback: substrings searched in the standard IDENT (cmd
   * 0x00) response. Kept for diagnostic display but no longer used for
   * dispatch — the proper 0x0D → 0x06 sequence is more reliable and
   * matches upstream tooling's behaviour.
   */
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
 * MS42 — Siemens, BMW M52TU, Infineon C167CR_SR.
 *
 * WRITE regions (mirrors upstream tooling's — never write the
 * bootloader, and stop 16-44 bytes short of each erase block boundary
 * to spare reserved flash cells):
 *   0x11000-0x3FFFF — lower program (192 KB)
 *   0x5002C-0x7FFFF — upper program (~192 KB; skips 0x2C-byte header)
 *   0x48000-0x4FFEF — calibration (32 KB - 16; skips checksum trailer)
 *
 * READ regions (mirrors upstream tooling's dump output, broader
 * than the writeable range):
 *   0x00000-0x0BFFF — C167 internal flash (bootloader, read-only)
 *   0x11000-0x3FFFF — lower program
 *   0x48000-0x4FFFF — calibration (includes the 16-byte trailer)
 *   0x50000-0x7FFFF — upper program (includes the 0x2C-byte header)
 */
const MS42_PROFILE: EcuProfile = {
  variant: 'MS42',
  ds2Addr: 0x12,
  blockSize: 118,
  readBlockSize: 123,
  binSize: 0x80000,
  fullRegions: [
    // Both program regions share ONE erase at 0x11000 — empirically
    // that single 0x07 0x06 command erases everything between the
    // bootloader and the cal block. Doing a second erase between them
    // would wipe the data we just wrote.
    { start: 0x11000, end: 0x3ffff, binOffset: 0x11000, eraseAddr: 0x11000 },
    { start: 0x5002c, end: 0x7ffff, binOffset: 0x5002c, eraseAddr: 0x11000 },
    { start: 0x48000, end: 0x4ffef, binOffset: 0x48000, eraseAddr: 0x48000 },
  ],
  readFullRegions: [
    { start: 0x00000, end: 0x0bfff, binOffset: 0x00000 }, // C167 internal flash
    { start: 0x11000, end: 0x3ffff, binOffset: 0x11000 },
    { start: 0x48000, end: 0x4ffff, binOffset: 0x48000 }, // includes trailer
    { start: 0x50000, end: 0x7ffff, binOffset: 0x50000 }, // includes header
  ],
  calibrationRegions: [
    // WRITE: 0x48000-0x4FFEF (32 KB - 16). Last 16 bytes are the
    // Calibration CRC trailer (0x4FFF0-0x4FFFF) — read-only.
    { start: 0x48000, end: 0x4ffef, binOffset: 0x48000 },
  ],
  readCalibrationRegions: [
    // READ: full 32 KB block 0x48000-0x4FFFF (includes trailer).
    { start: 0x48000, end: 0x4ffff, binOffset: 0x48000 },
  ],
  identKey: '111011',
  identSignatures: ['1430844', '7503355'],
  calibrationVerified: true,
};

/**
 * MS43 — Siemens, BMW M54, Infineon C167CS-32F.
 *
 * FULL layout (512 KB BIN, ECU-side addresses):
 *
 *   ECU 0x00000-0x0BFFF → BIN 0x00000  C167 internal flash (48 KB)
 *   skipped 0x0C000-0x0FFFF              C167 SFR / RAM window
 *   ECU 0x90000-0xEFFFF → BIN 0x10000  external program (384 KB, ECU
 *                                       applies 0x9 → 0x1 high-byte
 *                                       translation to chip address)
 *   ECU 0x70000-0x7FFFF → BIN 0x70000  external calibration (64 KB)
 *
 * CALIBRATION: only the 64 KB block at ECU 0x70000-0x7FFFF.
 */
const MS43_PROFILE: EcuProfile = {
  variant: 'MS43',
  ds2Addr: 0x12,
  blockSize: 118,
  readBlockSize: 123,
  binSize: 0x80000,
  fullRegions: [
    // Single erase at 0x90000 covers the whole program range;
    // single erase at 0x70000 covers the cal range. Stops 16-17 bytes
    // short of each region end to spare the read-only trailers.
    { start: 0x90000, end: 0xeffef, binOffset: 0x10000 }, // program, 393200
    { start: 0x70000, end: 0x7ffee, binOffset: 0x70000 }, // calibration, 65519
  ],
  readFullRegions: [
    // READ: full ranges including bootloader + checksum trailers.
    { start: 0x00000, end: 0x0bfff, binOffset: 0x00000 }, // bootloader
    { start: 0x90000, end: 0xeffff, binOffset: 0x10000 }, // full 393216
    { start: 0x70000, end: 0x7ffff, binOffset: 0x70000 }, // full 65536
  ],
  calibrationRegions: [
    // WRITE: 0x70000-0x7FFEE (65519 bytes). Last 17 bytes are the
    // calibration trailer (0x7FFEF-0x7FFFF), read-only.
    { start: 0x70000, end: 0x7ffee, binOffset: 0x70000 },
  ],
  readCalibrationRegions: [
    // READ: full 64 KB block including trailer.
    { start: 0x70000, end: 0x7ffff, binOffset: 0x70000 },
  ],
  identKey: '111430',
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
  // GS20 (key "G2210_") maps to upstream tooling's `r` protocol class which
  // declares (251 read, 246 write) — high-capacity TCU variant.
  blockSize: 246,
  readBlockSize: 251,
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
  identKey: 'G2210_',
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
export function identifyEcu(identPayload: Uint8Array): EcuProfile | null {
  let ascii = '';
  for (let i = 0; i < identPayload.length; i++) ascii += String.fromCharCode(identPayload[i]);
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

export type RegionPurpose = 'read' | 'write';

/**
 * Pick the right region table for the requested mode + purpose. Read
 * tables include bootloader + checksum trailers (mirrors upstream tooling's
 * dump output); write tables exclude them (mirrors upstream tooling's safe
 * write path — writing the bootloader or trailer bricks the ECU).
 * Falls back to the write table when no read table is defined.
 */
/**
 * Look up an ECU profile by its 6-character dispatch key, returned by
 * the hardware-reference identification sequence (cmd 0x0D → cmd 0x06).
 */
export function findByIdentKey(key: string): EcuProfile | null {
  for (const p of ALL_PROFILES) {
    if (p.identKey === key) return p;
  }
  return null;
}

export function pickRegions(
  profile: EcuProfile,
  mode: FlashMode,
  purpose: RegionPurpose = 'write',
): ReadonlyArray<FlashRegion> {
  if (purpose === 'read') {
    if (mode === 'full') {
      return profile.readFullRegions ?? profile.fullRegions;
    }
    return profile.readCalibrationRegions ?? profile.calibrationRegions;
  }
  return mode === 'full' ? profile.fullRegions : profile.calibrationRegions;
}

/**
 * Total bytes the host will push to the wire for a given mode + purpose,
 * ignoring 0xFF skipping. Useful for progress accounting.
 */
export function totalBytesForMode(
  profile: EcuProfile,
  mode: FlashMode,
  purpose: RegionPurpose = 'write',
): number {
  let n = 0;
  for (const r of pickRegions(profile, mode, purpose)) n += r.end - r.start + 1;
  return n;
}
