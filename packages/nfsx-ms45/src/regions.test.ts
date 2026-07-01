import { describe, it, expect } from 'vitest';
import {
  EXTERNAL_FLASH_BASE,
  MPC_FLASH_BASE,
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  TUNE_BLOB_SIZE,
  PROGRAM_BLOB_SIZE,
  PARAM_SIG_SEGMENT_COUNT_OFFSET,
  PARAM_SIG_SEGMENT_STARTS_OFFSET,
  PARAM_SIG_SEGMENT_LENGTHS_OFFSET,
  PROG_SIG_SEGMENT_COUNT_OFFSET,
  PROG_SIG_SEGMENT_STARTS_OFFSET,
  PROG_SIG_SEGMENT_LENGTHS_OFFSET,
  readU32BE,
  writeU32BE,
  classifyEcuAddress,
  resolveEcuAddress,
  parseProgramSignedSegments,
  parseParameterSignedSegments,
} from './regions.js';

describe('endian helpers', () => {
  it('readU32BE decodes big-endian dword', () => {
    const buf = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    expect(readU32BE(buf, 0)).toBe(0x12345678);
  });

  it('readU32BE handles the high-bit-set case (unsigned)', () => {
    const buf = new Uint8Array([0xff, 0xf0, 0x00, 0x00]);
    expect(readU32BE(buf, 0)).toBe(0xfff00000);
  });

  it('writeU32BE round-trips through readU32BE', () => {
    const buf = new Uint8Array(4);
    writeU32BE(buf, 0xdeadbeef, 0);
    expect(Array.from(buf)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(readU32BE(buf, 0)).toBe(0xdeadbeef);
  });

  it('readU32BE rejects out-of-bounds offsets', () => {
    const buf = new Uint8Array(4);
    expect(() => readU32BE(buf, 1)).toThrow(/out of bounds/);
    expect(() => readU32BE(buf, -1)).toThrow(/out of bounds/);
  });
});

describe('address classification', () => {
  it('external flash for ECU addresses >= 0xFFF00000', () => {
    expect(classifyEcuAddress(0xfff00000)).toBe('external');
    expect(classifyEcuAddress(0xfff60000)).toBe('external');
    expect(classifyEcuAddress(0xffffffff)).toBe('external');
  });

  it('mpc flash for ECU addresses < 0xFFF00000', () => {
    expect(classifyEcuAddress(0x00000000)).toBe('mpc');
    expect(classifyEcuAddress(0x0006ffff)).toBe('mpc');
  });

  it('resolveEcuAddress subtracts the region base', () => {
    expect(resolveEcuAddress(0xfff60000)).toEqual({
      space: 'external',
      hostOffset: 0x60000,
    });
    expect(resolveEcuAddress(0x00000100)).toEqual({
      space: 'mpc',
      hostOffset: 0x100,
    });
  });
});

describe('constant sanity', () => {
  it('bases and sizes cohere', () => {
    expect(EXTERNAL_FLASH_BASE).toBe(0xfff00000);
    expect(MPC_FLASH_BASE).toBe(0);
    expect(EXTERNAL_FLASH_SIZE).toBe(0x100000);
    expect(MPC_FLASH_SIZE).toBe(0x70000);
    expect(TUNE_BLOB_SIZE).toBe(0x1d000);
    expect(PROGRAM_BLOB_SIZE).toBe(0x9ff40);
  });
});

// ── segment parsing ────────────────────────────────────────────────

function makeExternalFlash(): Uint8Array {
  return new Uint8Array(EXTERNAL_FLASH_SIZE);
}

function makeTuneBlob(): Uint8Array {
  return new Uint8Array(TUNE_BLOB_SIZE);
}

describe('parseProgramSignedSegments', () => {
  it('reads a two-segment table spanning MPC + external flash', () => {
    const ext = makeExternalFlash();
    // Header: 2 segments, first in MPC (0x1000, len 0x100), second in external (0xFFF61000, len 0x200).
    writeU32BE(ext, 2, PROG_SIG_SEGMENT_COUNT_OFFSET);
    writeU32BE(ext, 0x00001000, PROG_SIG_SEGMENT_STARTS_OFFSET + 0 * 8);
    writeU32BE(ext, 0xfff61000, PROG_SIG_SEGMENT_STARTS_OFFSET + 1 * 8);
    writeU32BE(ext, 0x100, PROG_SIG_SEGMENT_LENGTHS_OFFSET + 0 * 4);
    writeU32BE(ext, 0x200, PROG_SIG_SEGMENT_LENGTHS_OFFSET + 1 * 4);

    const segs = parseProgramSignedSegments(ext);
    expect(segs).toEqual([
      { ecuStart: 0x1000, length: 0x100, space: 'mpc', hostOffset: 0x1000 },
      { ecuStart: 0xfff61000, length: 0x200, space: 'external', hostOffset: 0x61000 },
    ]);
  });

  it('returns [] for zero-count header', () => {
    const ext = makeExternalFlash();
    // header defaults to zero
    expect(parseProgramSignedSegments(ext)).toEqual([]);
  });
});

describe('parseParameterSignedSegments', () => {
  it('offsets segments relative to PARAM_SIG_SEGMENT_BASE (0xFFF40000)', () => {
    const blob = makeTuneBlob();
    // One segment @ ECU 0xFFF40200, length 0x80 → host offset 0x200 in blob.
    writeU32BE(blob, 1, PARAM_SIG_SEGMENT_COUNT_OFFSET);
    writeU32BE(blob, 0xfff40200, PARAM_SIG_SEGMENT_STARTS_OFFSET);
    writeU32BE(blob, 0x80, PARAM_SIG_SEGMENT_LENGTHS_OFFSET);

    const segs = parseParameterSignedSegments(blob);
    expect(segs).toEqual([
      { ecuStart: 0xfff40200, length: 0x80, hostOffset: 0x200 },
    ]);
  });
});
