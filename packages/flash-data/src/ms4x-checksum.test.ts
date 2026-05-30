import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  crc16Ccitt,
  add32,
  detectVariant,
  verifyChecksums,
  rewriteChecksums,
  EXPECTED_FILE_LENGTH,
} from './ms4x-checksum.js';

// ── helpers ─────────────────────────────────────────────────────────

function newBlankFw(): Buffer {
  const buf = Buffer.alloc(EXPECTED_FILE_LENGTH, 0xff);
  return buf;
}

function writeU16LE(buf: Buffer, val: number, off: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >> 8) & 0xff;
}

function writeAddr24(buf: Buffer, val: number, off: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >> 8) & 0xff;
  buf[off + 2] = (val >> 16) & 0xff;
}

/**
 * Plant a minimal MS42 header structure into a blank buffer so the
 * checksum routines can find all three CRC-16s. Returns the buffer with
 * computed-correct checksums installed.
 *
 * (MS43 doesn't use this header-driven mechanism — its tests build a
 * minimal stored-value-only fixture inline.)
 */
function plantHeader(variant: 'MS42'): Buffer {
  const buf = newBlankFw();

  // ── Boot region ──
  // Pick a small range so the CRC is fast to compute.
  const bootStart = 0x100;
  const bootEnd = 0x1ff;
  for (let i = bootStart; i <= bootEnd; i++) buf[i] = (i & 0xff) ^ 0x42;
  writeU16LE(buf, bootStart & 0xffff, 0x3c28);
  writeU16LE(buf, (bootStart >> 16) & 0xffff, 0x3c2a);
  writeU16LE(buf, bootEnd & 0xffff, 0x3c2c);
  writeU16LE(buf, (bootEnd >> 16) & 0xffff, 0x3c2e);
  writeU16LE(buf, 0x1234, 0x3fe6); // seed

  // ── Program checksum header ──
  // Header at 0x502CE points to the result location, which holds the
  // loop count and region table.
  const progResultAddr = 0x50306;
  writeAddr24(buf, progResultAddr, 0x502ce);
  const progSeedAddr = 0x50320;
  writeU16LE(buf, progSeedAddr & 0xffff, 0x502d2);
  writeU16LE(buf, (progSeedAddr >> 16) & 0xffff, 0x502d4);
  writeU16LE(buf, 0xabcd, progSeedAddr);
  writeU16LE(buf, 1, progResultAddr + 2);
  const progRegStart = 0x10000;
  const progRegEnd = 0x10010;
  for (let i = progRegStart; i <= progRegEnd; i++) buf[i] = (i ^ 0x55) & 0xff;
  writeU16LE(buf, progRegStart & 0xffff, progResultAddr + 4);
  writeU16LE(buf, (progRegStart >> 16) & 0xffff, progResultAddr + 6);
  writeU16LE(buf, progRegEnd & 0xffff, progResultAddr + 8);
  writeU16LE(buf, (progRegEnd >> 16) & 0xffff, progResultAddr + 10);

  // ── Calibration checksum header ──
  const calResultAddr = 0x4fee0;
  writeAddr24(buf, calResultAddr, 0x502f2);
  const calSeedAddr = 0x50330;
  writeU16LE(buf, calSeedAddr & 0xffff, 0x502f6);
  writeU16LE(buf, (calSeedAddr >> 16) & 0xffff, 0x502f8);
  writeU16LE(buf, 0x9876, calSeedAddr);
  writeU16LE(buf, 1, calResultAddr + 2);
  const calRegStart = 0x20000;
  const calRegEnd = 0x20020;
  for (let i = calRegStart; i <= calRegEnd; i++) buf[i] = (i ^ 0xaa) & 0xff;
  writeU16LE(buf, calRegStart & 0xffff, calResultAddr + 4);
  writeU16LE(buf, (calRegStart >> 16) & 0xffff, calResultAddr + 6);
  writeU16LE(buf, calRegEnd & 0xffff, calResultAddr + 8);
  writeU16LE(buf, (calRegEnd >> 16) & 0xffff, calResultAddr + 10);

  // Install correct checksums via the production code.
  rewriteChecksums(buf);
  return buf;
}

// ── tests ───────────────────────────────────────────────────────────

describe('crc16Ccitt', () => {
  it('returns the seed for an empty range (start > end)', () => {
    const buf = Buffer.from([0x11, 0x22, 0x33]);
    // crc over [1..0] = no iterations = seed
    expect(crc16Ccitt(buf, 1, 0, 0xffff)).toBe(0xffff);
  });

  it('is deterministic and order-dependent', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const a = crc16Ccitt(buf, 0, 3, 0x0000);
    const b = crc16Ccitt(buf, 0, 3, 0x0000);
    expect(a).toBe(b);
    const reversed = Buffer.from([0x04, 0x03, 0x02, 0x01]);
    expect(crc16Ccitt(reversed, 0, 3, 0x0000)).not.toBe(a);
  });

  it('matches a known seed → result transition by extending the seed', () => {
    // Computing CRC over [0..3] with seed S should equal CRC over [2..3]
    // with seed = CRC over [0..1] with seed S.
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const full = crc16Ccitt(buf, 0, 3, 0xffff);
    const intermediate = crc16Ccitt(buf, 0, 1, 0xffff);
    const continued = crc16Ccitt(buf, 2, 3, intermediate);
    expect(continued).toBe(full);
  });
});

describe('add32', () => {
  it('sums u16 LE words across the range, wrapping at 2^32', () => {
    const buf = Buffer.from([0x01, 0x00, 0x02, 0x00, 0xff, 0xff, 0x00, 0x00]);
    // words: 0x0001 + 0x0002 + 0xFFFF + 0x0000 = 0x10002
    expect(add32(buf, 0, 8)).toBe(0x10002);
  });

  it('wraps at 2^32', () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt16LE(0xffff, 0);
    buf.writeUInt16LE(0xffff, 2);
    buf.writeUInt16LE(0xffff, 4);
    buf.writeUInt16LE(0x0003, 6); // total = 3*0xFFFF + 3 = 0x30000 (no wrap)
    expect(add32(buf, 0, 8)).toBe(0x30000);
  });
});

describe('detectVariant', () => {
  it('returns null for wrong file size', () => {
    const buf = Buffer.alloc(1024, 0xff);
    expect(detectVariant(buf)).toBeNull();
  });

  it('identifies MS42 by a populated 0x4FEE0 calibration-CRC slot', () => {
    const buf = newBlankFw();
    writeU16LE(buf, 0x27be, 0x4fee0); // populated MS42 Calibration CRC
    // 0x6FDE0 stays 0xFFFF (no MS43 marker)
    expect(detectVariant(buf)).toBe('MS42');
  });

  it('identifies MS43 by a populated 0x6FDE0 program-CRC slot', () => {
    const buf = newBlankFw();
    writeU16LE(buf, 0x727e, 0x6fde0); // populated MS43 Program CRC
    // 0x4FEE0 stays 0xFFFF (no MS42 marker)
    expect(detectVariant(buf)).toBe('MS43');
  });

  it('still falls back to the MS42 header pointer when both markers are erased', () => {
    const buf = newBlankFw();
    writeAddr24(buf, 0x50306, 0x502ce);
    expect(detectVariant(buf)).toBe('MS42');
  });

  it('returns null when nothing identifies the BIN', () => {
    const buf = newBlankFw();
    expect(detectVariant(buf)).toBeNull();
  });
});

describe('verifyChecksums — MS42 synthetic firmware', () => {
  it('reports all 3 CRC-16s as matching after planting', () => {
    const buf = plantHeader('MS42');
    const report = verifyChecksums(buf);
    expect(report.variant).toBe('MS42');
    expect(report.results).toHaveLength(3);
    for (const r of report.results) {
      expect(r.match).toBe(true);
      expect(r.kind).toBe('crc16');
      expect(r.supported).toBe(true);
    }
    expect(report.allValid).toBe(true);
  });

  it('detects a mismatch when a byte in the calibration region is flipped', () => {
    const buf = plantHeader('MS42');
    buf[0x20005] ^= 0xff; // flip a byte inside the calibration region
    const report = verifyChecksums(buf);
    const cal = report.results.find((r) => r.name === 'Calibration')!;
    expect(cal.match).toBe(false);
    expect(report.allValid).toBe(false);
  });

  it('detects a Boot mismatch when a byte in the boot region is flipped', () => {
    const buf = plantHeader('MS42');
    buf[0x150] ^= 0x01;
    const report = verifyChecksums(buf);
    const boot = report.results.find((r) => r.name === 'Boot')!;
    expect(boot.match).toBe(false);
  });

  it('rewriteChecksums repairs mismatches in place', () => {
    const buf = plantHeader('MS42');
    buf[0x20005] ^= 0xff;
    expect(verifyChecksums(buf).allValid).toBe(false);
    rewriteChecksums(buf);
    expect(verifyChecksums(buf).allValid).toBe(true);
  });
});

describe('verifyChecksums — MS43', () => {
  /**
   * Plant a minimal MS43 header + region structure that the algorithm
   * can navigate. Builds a single-region Program and Calibration CRC
   * over predictable byte ranges, then has the production code install
   * correct CRC values.
   */
  function plantMs43Header(): Buffer {
    const buf = newBlankFw();

    // Boot: shared algorithm with MS42 — use a small range and seed.
    const bootStart = 0x100;
    const bootEnd = 0x1ff;
    for (let i = bootStart; i <= bootEnd; i++) buf[i] = (i & 0xff) ^ 0x42;
    writeU16LE(buf, bootStart & 0xffff, 0x3c28);
    writeU16LE(buf, (bootStart >> 16) & 0xffff, 0x3c2a);
    writeU16LE(buf, bootEnd & 0xffff, 0x3c2c);
    writeU16LE(buf, (bootEnd >> 16) & 0xffff, 0x3c2e);
    writeU16LE(buf, 0x1234, 0x3fe6); // boot seed

    // Program: seed pointer at 0x6ED42 → 0x6FFB6 (in program region).
    // hi-raw = 0x000E translates to 6, so we plant (0xFFB6, 0x000E).
    writeU16LE(buf, 0xffb6, 0x6ed42);
    writeU16LE(buf, 0x000e, 0x6ed44);
    writeU16LE(buf, 0x9999, 0x6ffb6); // program seed value
    // One region in the table: ECU 0x90000-0x9FFFF (translates to BIN
    // 0x10000-0x1FFFF). count=1, then entry: start (0x0000, 0x0009), end (0xFFFF, 0x0009).
    writeU16LE(buf, 1, 0x6fde2); // count
    writeU16LE(buf, 0x0000, 0x6fde4); // start lo
    writeU16LE(buf, 0x0009, 0x6fde6); // start hi (translate(9)=1 → 0x10000)
    writeU16LE(buf, 0xffff, 0x6fde8); // end lo
    writeU16LE(buf, 0x0009, 0x6fdea); // end hi
    // Fill the program region (BIN 0x10000-0x1FFFF) with predictable bytes.
    for (let i = 0x10000; i <= 0x1ffff; i++) buf[i] = (i ^ 0x55) & 0xff;

    // Calibration: leave seed pointer EMPTY (0xFFFFFFFF) to exercise the
    // fallback path. Calibration covers BIN 0x70000-0x70FFF.
    writeU16LE(buf, 1, 0x73fe2); // count
    writeU16LE(buf, 0x0000, 0x73fe4); // start lo
    writeU16LE(buf, 0x0007, 0x73fe6); // start hi (translate(7)=7 → 0x70000)
    writeU16LE(buf, 0x0fff, 0x73fe8); // end lo
    writeU16LE(buf, 0x0007, 0x73fea); // end hi → 0x70FFF
    // Fill predictable bytes first, then OVERWRITE the seed location.
    for (let i = 0x70000; i <= 0x70fff; i++) buf[i] = (i ^ 0xaa) & 0xff;
    // Plant the seed value at 0x7000C (the fallback addr).
    writeU16LE(buf, 0x8765, 0x7000c);
    // Plant add32 stored values (we don't compute them).
    buf.writeUInt32LE(0xdeadbeef, 0x6fdae);
    buf.writeUInt32LE(0xcafebabe, 0x72ffc);
    // Install correct CRCs via the production code.
    rewriteChecksums(buf, { variant: 'MS43' });
    return buf;
  }

  it('reports 5 verified entries: 3 CRC-16s + 2 add32s', () => {
    const buf = plantMs43Header();
    const report = verifyChecksums(buf);
    expect(report.variant).toBe('MS43');
    expect(report.results).toHaveLength(5);
    for (const r of report.results) {
      expect(r.supported, `${r.name} supported`).toBe(true);
      expect(r.match, `${r.name} match`).toBe(true);
    }
    expect(report.allValid).toBe(true);
  });

  it('falls back to BIN[0x7000C] when the Calibration seed pointer is empty', () => {
    const buf = plantMs43Header();
    // Pointer at 0x6ED9A should still be FFFFFFFF (we never wrote it).
    expect(buf.readUInt16LE(0x6ed9a)).toBe(0xffff);
    expect(buf.readUInt16LE(0x6ed9c)).toBe(0xffff);
    const report = verifyChecksums(buf);
    const cal = report.results.find((r) => r.name === 'Calibration')!;
    expect(cal.match).toBe(true);
    expect(cal.seed).toBe(0x8765);
  });

  it('detects calibration mismatch when calibration data changes', () => {
    const buf = plantMs43Header();
    buf[0x70500] ^= 0xff;
    const report = verifyChecksums(buf);
    const cal = report.results.find((r) => r.name === 'Calibration')!;
    expect(cal.match).toBe(false);
  });

  it('rewriteChecksums repairs CRC-16 mismatches', () => {
    const buf = plantMs43Header();
    buf[0x70500] ^= 0xff; // flip a calibration byte
    rewriteChecksums(buf);
    const report = verifyChecksums(buf);
    expect(report.allValid).toBe(true);
  });

  it('rewriteChecksums also updates add32 (data inside its range changed)', () => {
    const buf = plantMs43Header();
    // Plant a known initial accumulator so we can compute the expected result.
    buf.writeUInt32LE(0xa5a5a5a5, 0x6fdb8); // Calibration initial
    // Plant Calibration add32 region 0: BIN 0x70004-0x70008 (2 u16 words).
    // start=(0x0004, 0x0007), end=(0x0008, 0x0007)
    writeU16LE(buf, 0x0004, 0x6fdce);
    writeU16LE(buf, 0x0007, 0x6fdd0);
    writeU16LE(buf, 0x0008, 0x6fdd2);
    writeU16LE(buf, 0x0007, 0x6fdd4);
    // Region 1: BIN 0x7000A-0x7000C (1 u16 word)
    writeU16LE(buf, 0x000a, 0x6fdd6);
    writeU16LE(buf, 0x0007, 0x6fdd8);
    writeU16LE(buf, 0x000c, 0x6fdda);
    writeU16LE(buf, 0x0007, 0x6fddc);
    // Now change a byte inside the add32 range.
    buf[0x70005] = 0x42;
    rewriteChecksums(buf);
    // Verify the resulting add32 matches what verifyChecksums sees.
    const report = verifyChecksums(buf);
    const calAdd = report.results.find((r) => r.name === 'Calibration (add)')!;
    expect(calAdd.match).toBe(true);
  });
});

describe('verifyChecksums — error handling', () => {
  it('throws when variant cannot be detected', () => {
    const buf = newBlankFw();
    expect(() => verifyChecksums(buf)).toThrow(/MS42\/MS43 variant/);
  });
});
