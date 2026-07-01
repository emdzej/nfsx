import { describe, it, expect } from 'vitest';
import {
  crc32,
  verifyParameterChecksum,
  rewriteParameterChecksum,
  verifyProgramChecksum,
  rewriteProgramChecksum,
} from './checksum.js';
import {
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  TUNE_BLOB_SIZE,
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
  writeU32BE,
  readU32BE,
} from './regions.js';

// ── CRC-32/MPEG-2 known vectors ────────────────────────────────────
//
// CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, no reflect, no XOR)
// is a well-known variant. Values below are from RevEng's Catalogue of
// Parametrised CRC Algorithms for "123456789" and the empty string.

describe('crc32 (MPEG-2 form)', () => {
  it('empty input returns the initial value unchanged', () => {
    expect(crc32(new Uint8Array(0), 0xdeadbeef)).toBe(0xdeadbeef);
    expect(crc32(new Uint8Array(0), 0)).toBe(0);
  });

  it('"123456789" with init 0xFFFFFFFF matches CRC-32/MPEG-2 check value', () => {
    const check = new TextEncoder().encode('123456789');
    // Published CRC-32/MPEG-2 "check" is 0x0376E6E7.
    expect(crc32(check, 0xffffffff)).toBe(0x0376e6e7);
  });

  it('single-byte 0x00 with init 0 stays 0 (linear, no XOR-out)', () => {
    expect(crc32(new Uint8Array([0]), 0)).toBe(0);
  });

  it('is linear w.r.t. splitting the buffer', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const whole = crc32(buf, 0xffffffff);
    const first = crc32(buf.subarray(0, 3), 0xffffffff);
    const rest = crc32(buf.subarray(3), first);
    expect(rest).toBe(whole);
  });
});

// ── parameter blob helpers ─────────────────────────────────────────

function makeTuneBlob(): Uint8Array {
  // Fill with a pattern so the CRC is non-trivial.
  const blob = new Uint8Array(TUNE_BLOB_SIZE);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 31 + 7) & 0xff;
  return blob;
}

function plantSingleParamSegment(
  blob: Uint8Array,
  initial: number,
  segStartHost: number,
  segEndHost: number,
): void {
  writeU32BE(blob, initial, PARAM_CRC_INITIAL_OFFSET);
  writeU32BE(blob, 1, PARAM_CRC_SEGMENT_TABLE_OFFSET);
  writeU32BE(
    blob,
    PARAM_CRC_SEGMENT_BASE + segStartHost,
    PARAM_CRC_SEGMENT_TABLE_OFFSET + 4,
  );
  writeU32BE(
    blob,
    PARAM_CRC_SEGMENT_BASE + segEndHost,
    PARAM_CRC_SEGMENT_TABLE_OFFSET + 8,
  );
}

describe('parameter checksum', () => {
  it('verify + rewrite round-trip', () => {
    const blob = makeTuneBlob();
    // Sign a range that lies AFTER the header so we don't hash our
    // own metadata.
    plantSingleParamSegment(blob, 0xffffffff, 0x200, 0x2ff);

    // Initially the stored value is wrong (whatever the fill pattern
    // put at 0x100..0x103).
    const before = verifyParameterChecksum(blob);
    expect(before.ok).toBe(false);

    rewriteParameterChecksum(blob);
    const after = verifyParameterChecksum(blob);
    expect(after.ok).toBe(true);
    expect(after.computed).toBe(after.stored);
  });

  it('cross-check: recomputed CRC equals a manual chained CRC over the same range', () => {
    const blob = makeTuneBlob();
    plantSingleParamSegment(blob, 0xffffffff, 0x400, 0x4ff);
    rewriteParameterChecksum(blob);

    // The parameter-CRC segment table has count at 0x104 and pairs at
    // (0x108, 0x10C), (0x110, 0x114), …. That collides with the
    // initial-value slot at 0x110 for count >= 2, and stock MS45
    // firmware only ever uses count=1 — so we exercise the single
    // range only.
    const crc = crc32(blob.subarray(0x400, 0x500), 0xffffffff);
    expect(readU32BE(blob, PARAM_CRC_STORED_OFFSET)).toBe(crc);
  });

  it('flips ok=false when a byte inside the segment mutates', () => {
    const blob = makeTuneBlob();
    plantSingleParamSegment(blob, 0xffffffff, 0x200, 0x2ff);
    rewriteParameterChecksum(blob);
    expect(verifyParameterChecksum(blob).ok).toBe(true);

    blob[0x210]! ^= 0xff;
    expect(verifyParameterChecksum(blob).ok).toBe(false);
  });

  it('throws on segment addresses outside the blob', () => {
    const blob = makeTuneBlob();
    // ECU end past the end of the blob (blob is 0x1D000).
    writeU32BE(blob, 0xffffffff, PARAM_CRC_INITIAL_OFFSET);
    writeU32BE(blob, 1, PARAM_CRC_SEGMENT_TABLE_OFFSET);
    writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x100, PARAM_CRC_SEGMENT_TABLE_OFFSET + 4);
    writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x20000, PARAM_CRC_SEGMENT_TABLE_OFFSET + 8);
    expect(() => verifyParameterChecksum(blob)).toThrow(/out of blob bounds/);
  });
});

// ── program blob helpers ───────────────────────────────────────────

function makeExternal(): Uint8Array {
  const buf = new Uint8Array(EXTERNAL_FLASH_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 17 + 3) & 0xff;
  return buf;
}

function makeMpc(): Uint8Array {
  const buf = new Uint8Array(MPC_FLASH_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 29 + 11) & 0xff;
  return buf;
}

/**
 * Plant a header where both CRCs cover:
 *   segment 1: MPC 0x1000..0x10FF
 *   segment 2: external 0xFFF80000..0xFFF800FF
 * (Chosen so neither range overlaps the header itself at 0x60000..0x60400
 * — otherwise rewriting the primary CRC would perturb the input the
 * secondary CRC sees.)
 */
function plantProgramHeader(external: Uint8Array): void {
  const seg1Start = 0x00001000;
  const seg1End = 0x000010ff;
  const seg2Start = 0xfff80000;
  const seg2End = 0xfff800ff;

  writeU32BE(external, 0xffffffff, PROG_CRC_PRIMARY_INITIAL_OFFSET);
  writeU32BE(external, seg1Start, PROG_CRC_PRIMARY_SEG1_START_OFFSET);
  writeU32BE(external, seg1End, PROG_CRC_PRIMARY_SEG1_END_OFFSET);
  writeU32BE(external, seg2Start, PROG_CRC_PRIMARY_SEG2_START_OFFSET);
  writeU32BE(external, seg2End, PROG_CRC_PRIMARY_SEG2_END_OFFSET);

  writeU32BE(external, 0xffffffff, PROG_CRC_SECONDARY_INITIAL_OFFSET);
  writeU32BE(external, seg1Start, PROG_CRC_SECONDARY_SEG1_START_OFFSET);
  writeU32BE(external, seg1End, PROG_CRC_SECONDARY_SEG1_END_OFFSET);
  writeU32BE(external, seg2Start, PROG_CRC_SECONDARY_SEG2_START_OFFSET);
  writeU32BE(external, seg2End, PROG_CRC_SECONDARY_SEG2_END_OFFSET);
}

describe('program checksum', () => {
  it('verify + rewrite round-trip across MPC + external segments', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgramHeader(external);

    const before = verifyProgramChecksum(external, mpc);
    expect(before.ok).toBe(false);

    rewriteProgramChecksum(external, mpc);
    const after = verifyProgramChecksum(external, mpc);
    expect(after.ok).toBe(true);
    expect(after.primary.stored).toBe(after.primary.computed);
    expect(after.secondary.stored).toBe(after.secondary.computed);
  });

  it('primary and secondary agree when segment tables match', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgramHeader(external);
    rewriteProgramChecksum(external, mpc);
    const r = verifyProgramChecksum(external, mpc);
    expect(r.primary.computed).toBe(r.secondary.computed);
  });

  it('cross-check: recomputed CRC equals a manual chained CRC over the same ranges', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgramHeader(external);
    rewriteProgramChecksum(external, mpc);

    let crc = 0xffffffff;
    crc = crc32(mpc.subarray(0x1000, 0x1100), crc);
    crc = crc32(external.subarray(0x80000, 0x80100), crc);
    expect(readU32BE(external, PROG_CRC_PRIMARY_STORED_OFFSET)).toBe(crc);
  });

  it('flips ok=false when the MPC segment mutates', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgramHeader(external);
    rewriteProgramChecksum(external, mpc);
    expect(verifyProgramChecksum(external, mpc).ok).toBe(true);

    mpc[0x1050]! ^= 0xff;
    expect(verifyProgramChecksum(external, mpc).ok).toBe(false);
  });

  it('throws when a program segment points outside its flash region', () => {
    const external = makeExternal();
    const mpc = makeMpc();
    plantProgramHeader(external);
    // Force seg2 into MPC address space with a range that overflows
    // the MPC buffer (0x70000 bytes total). External flash covers
    // exactly 0xFFF00000..0xFFFFFFFF so it's tricky to blow bounds
    // there; MPC is where the address math actually has slack.
    writeU32BE(external, 0x00060000, PROG_CRC_PRIMARY_SEG2_START_OFFSET);
    writeU32BE(external, 0x000800ff, PROG_CRC_PRIMARY_SEG2_END_OFFSET);
    expect(() => verifyProgramChecksum(external, mpc)).toThrow(/out of bounds/);
  });
});
