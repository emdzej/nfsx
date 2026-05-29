/**
 * Per-ECU detection + region tables for direct (DS2) flashing.
 *
 * The IDENT response from a DS2 ECU includes ASCII identification bytes;
 * `identifyEcu()` heuristically matches against known signatures and
 * returns the EcuVariant + the writable region tables for both FULL and
 * CALIBRATION modes.
 *
 * Region tables derived from MS4x Flasher 1.6.0's per-variant L.A() /
 * L.a() implementations (`ᄁ/A/T.cs:360, 873` / `ᄁ/A/p.cs:352`) — those
 * are the ranges BMW's own DS2 flashers actually push through the wire.
 * Going outside them per the protocol is possible (§5/§7) but no tool
 * does it through DS2; for bench-only out-of-range writes use the
 * bootmode path in `@emdzej/nfsx-bootmode`.
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
   * Source citation for the tables above. Useful when the calibration
   * subset is a guess rather than a reverse-engineered value — see
   * `calibrationVerified` for that distinction.
   */
  tableSource: string;
  /**
   * True iff the calibration-vs-full distinction is grounded in
   * reverse-engineered tool source (MS4x Flasher, WinKFP, etc.).
   * False iff calibrationRegions just falls back to fullRegions because
   * no actual calibration-only mode was established.
   */
  calibrationVerified: boolean;
}

/**
 * MS42 — Siemens, BMW M52TU, Infineon C167CR_SR + AMD 29F400BB.
 *
 * FULL: matches MS4x Flasher's `T.cs:t::A()` 1:1-mapping layout
 * (three direct regions covering 0x11000-0x7FFFF with gaps).
 * CALIBRATION: writes only the calibration block (typically the upper
 * region covering 0x40000+).
 */
const MS42_PROFILE: EcuProfile = {
  variant: 'MS42',
  ds2Addr: 0x12,
  blockSize: 246,
  binSize: 0x80000,
  fullRegions: [
    { start: 0x11000, end: 0x3ffff, binOffset: 0x11000 },
    { start: 0x48000, end: 0x4ffef, binOffset: 0x48000 },
    { start: 0x5002c, end: 0x7ffff, binOffset: 0x5002c },
  ],
  calibrationRegions: [
    // Calibration region in MS42 covers the upper data region — same
    // address range as fullRegions[2].
    { start: 0x5002c, end: 0x7ffff, binOffset: 0x5002c },
  ],
  identSignatures: ['MS42', 'MS_42'],
  tableSource: 'MS4x Flasher 1.6.0 (ᄁ/A/T.cs:873 — `t::A` full, `t::a` partial)',
  calibrationVerified: true,
};

/**
 * MS43 — Siemens, BMW M54, Infineon C167CS-32F + AMD AM29F400.
 *
 * FULL: matches MS4x Flasher's `T.cs:T::A()` shifted-mapping layout
 * (two regions: ECU 0x90000+0x5FFF0 sourced from BIN 0x10000+0x5FFF0
 * with a +0x80000 shift; and ECU 0x70000+0xFFEF sourced from BIN
 * 0x70000+0xFFEF direct).
 */
const MS43_PROFILE: EcuProfile = {
  variant: 'MS43',
  ds2Addr: 0x12,
  blockSize: 246,
  binSize: 0x80000,
  fullRegions: [
    // Two-region layout per MS4x Flasher `T.cs:360`:
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
    // Calibration block in MS43 is the upper data region sourced from
    // BIN 0x10000.
    {
      start: 0x90000,
      end: 0x90000 + 0x5fff0 - 1,
      binOffset: 0x10000,
    },
  ],
  identSignatures: ['MS43', 'MS_43'],
  tableSource: 'MS4x Flasher 1.6.0 (ᄁ/A/T.cs:360 — `T::A` full, `T::a` partial)',
  calibrationVerified: true,
};

/**
 * GS20 — Siemens transmission control unit (TCU).
 *
 * Region table now matches MS4x Flasher's `r` protocol class (its TCU
 * variant; factory `N.cs:60` initialised with the `0x32` K-line
 * address). MS4x Flasher actually dispatches five TCU protocol classes
 * (`p`, `r`, `R`, `q`, `Q`) keyed on a 6-character IDENT substring; `r`
 * is the one whose layout the user has bench-flashed against. If a
 * given TCU sub-variant turns out to need a different class, extend
 * ALL_PROFILES.
 *
 * BIN format: **512 KB (0x80000)** — same total size as the MS-class
 * engine BIN, per the `s` config object at `ᄅ/A/S.cs:43-53`
 * (`A(524288)`). Of that, only two regions are written; bytes
 * `0x00000-0x0FFFF` and `0x60000-0x7FFFF` are header / padding.
 *
 *   BIN `0x10000-0x1FFFF` → ECU `0x90000-0x9FFFF`  (64 KB program)
 *   BIN `0x20000-0x5FFFF` → ECU `0xA0000-0xDFFFF`  (256 KB data)
 *
 * CALIBRATION (partial-write) — rewrites only the 64 KB program block
 * at ECU `0x90000-0x9FFFF`, sourced from BIN `0x10000-0x1FFFF` when a
 * full 512 KB BIN is supplied. (MS4x Flasher's `r::a` also accepts a
 * 64 KB calibration-only BIN that reads from BIN[0], but we model
 * only the full-BIN form here for now.)
 */
const GS20_PROFILE: EcuProfile = {
  variant: 'GS20',
  ds2Addr: 0x32,
  blockSize: 246,
  binSize: 0x80000,
  fullRegions: [
    // R.cs:863-869 — erase 0xA0000, write ECU[0xA0000..0xDFFFF] from BIN[0x20000..0x5FFFF]
    { start: 0xa0000, end: 0xdffff, binOffset: 0x20000 },
    // R.cs:874-877 — erase 0x90000, write ECU[0x90000..0x9FFFF] from BIN[0x10000..0x1FFFF]
    { start: 0x90000, end: 0x9ffff, binOffset: 0x10000 },
  ],
  calibrationRegions: [
    // R.cs:937-941 — partial path: erase + write ONLY ECU[0x90000..0x9FFFF]
    { start: 0x90000, end: 0x9ffff, binOffset: 0x10000 },
  ],
  identSignatures: ['GS20', 'GS_20'],
  tableSource:
    'MS4x Flasher 1.6.0 (ᄁ/A/R.cs:813 — `r::A` full, `r::a` partial; ᄅ/A/S.cs:43 — `s` config object)',
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
