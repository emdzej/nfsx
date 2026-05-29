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
 * Plant a minimal MS42 or MS43 header structure into a blank buffer so the
 * checksum routines can find all three CRC-16s. Returns the buffer with
 * computed-correct checksums installed.
 */
function plantHeader(variant: 'MS42' | 'MS43'): Buffer {
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
  // Header at 0x502CE points to the result location, which holds the loop
  // count and region table.
  const progResultAddr = variant === 'MS42' ? 0x50306 : 0x6fde0;
  writeAddr24(buf, progResultAddr, 0x502ce);
  // Seed-address pointer (split as u16 lo + u16 hi).
  const progSeedAddr = variant === 'MS42' ? 0x50320 : 0x70000;
  writeU16LE(buf, progSeedAddr & 0xffff, 0x502d2);
  writeU16LE(buf, (progSeedAddr >> 16) & 0xffff, 0x502d4);
  // Plant the seed value at the seed address.
  writeU16LE(buf, 0xabcd, progSeedAddr);
  // One region in the table.
  writeU16LE(buf, 1, progResultAddr + 2);
  // Region 0: cover bytes [0x10000..0x10010].
  const progRegStart = 0x10000;
  const progRegEnd = 0x10010;
  for (let i = progRegStart; i <= progRegEnd; i++) buf[i] = (i ^ 0x55) & 0xff;
  writeU16LE(buf, progRegStart & 0xffff, progResultAddr + 4);
  writeU16LE(buf, (progRegStart >> 16) & 0xffff, progResultAddr + 6);
  writeU16LE(buf, progRegEnd & 0xffff, progResultAddr + 8);
  writeU16LE(buf, (progRegEnd >> 16) & 0xffff, progResultAddr + 10);

  // ── Calibration checksum header ──
  const calResultAddr = variant === 'MS42' ? 0x4fee0 : 0x73fe0;
  writeAddr24(buf, calResultAddr, 0x502f2);
  const calSeedAddr = variant === 'MS42' ? 0x50330 : 0x70010;
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

  it('identifies MS42 from the program-pointer value', () => {
    const buf = newBlankFw();
    writeAddr24(buf, 0x50306, 0x502ce);
    expect(detectVariant(buf)).toBe('MS42');
  });

  it('identifies MS43 from the program-pointer value', () => {
    const buf = newBlankFw();
    writeAddr24(buf, 0x6fde0, 0x502ce);
    expect(detectVariant(buf)).toBe('MS43');
  });

  it('returns null when neither pointer matches and both result slots are erased', () => {
    const buf = newBlankFw();
    // pointer at 0x502CE = 0xFFFFFF (erased), both result slots 0xFFFF (erased)
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

describe('verifyChecksums — MS43 synthetic firmware', () => {
  it('reports 3 CRC-16s as matching and 2 unsupported add-checksums', () => {
    const buf = plantHeader('MS43');
    const report = verifyChecksums(buf);
    expect(report.variant).toBe('MS43');
    expect(report.results).toHaveLength(5);

    const crc16s = report.results.filter((r) => r.kind === 'crc16');
    expect(crc16s).toHaveLength(3);
    for (const r of crc16s) {
      expect(r.match).toBe(true);
      expect(r.supported).toBe(true);
    }

    const add32s = report.results.filter((r) => r.kind === 'add32');
    expect(add32s).toHaveLength(2);
    for (const r of add32s) {
      expect(r.supported).toBe(false);
      expect(r.note).toContain('firmware-version-specific');
    }

    // allValid considers only supported checksums.
    expect(report.allValid).toBe(true);
  });

  it('rewriteChecksums updates Boot/Program/Calibration but leaves add32 untouched', () => {
    const buf = plantHeader('MS43');
    // Plant a recognisable u32 in the add32 slot.
    buf.writeUInt32LE(0xdeadbeef, 0x6fdae);
    rewriteChecksums(buf);
    // add32 stored value should still be 0xDEADBEEF — we don't rewrite it.
    expect(buf.readUInt32LE(0x6fdae)).toBe(0xdeadbeef);
  });
});

describe('verifyChecksums — error handling', () => {
  it('throws when variant cannot be detected', () => {
    const buf = newBlankFw();
    expect(() => verifyChecksums(buf)).toThrow(/MS42\/MS43 variant/);
  });
});
