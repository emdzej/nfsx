import { describe, it, expect } from 'vitest';
import {
  findByIdentKey,
  getProfile,
  pickRegions,
  totalBytesForMode,
  ALL_PROFILES,
} from './ecu-tables.js';

describe('ECU tables', () => {
  it('looks up MS42 by its 6-char dispatch key', () => {
    expect(findByIdentKey('111011')?.variant).toBe('MS42');
  });

  it('looks up MS43 by its 6-char dispatch key', () => {
    expect(findByIdentKey('111430')?.variant).toBe('MS43');
  });

  it('looks up GS20 by its 6-char dispatch key', () => {
    expect(findByIdentKey('G2210_')?.variant).toBe('GS20');
  });

  it('returns null on an unknown dispatch key', () => {
    expect(findByIdentKey('XXXXXX')).toBeNull();
  });

  it('full mode covers more bytes than calibration on MS42', () => {
    const p = getProfile('MS42');
    expect(totalBytesForMode(p, 'full')).toBeGreaterThan(totalBytesForMode(p, 'calibration'));
  });

  it('full mode covers more bytes than calibration on MS43', () => {
    const p = getProfile('MS43');
    expect(totalBytesForMode(p, 'full')).toBeGreaterThan(totalBytesForMode(p, 'calibration'));
  });

  it('all three profiles have a separately verified calibration mode', () => {
    for (const p of ALL_PROFILES) {
      expect(p.calibrationVerified, `${p.variant} calibrationVerified`).toBe(true);
    }
  });

  it('GS20 calibration covers only the 64 KB program block at ECU 0x90000', () => {
    const p = getProfile('GS20');
    expect(totalBytesForMode(p, 'calibration')).toBe(0x10000);
    expect(p.calibrationRegions).toHaveLength(1);
    expect(p.calibrationRegions[0].start).toBe(0x90000);
    expect(p.calibrationRegions[0].end).toBe(0x9ffff);
  });

  it('GS20 full mode covers 320 KB across two regions (0x90000+0xA0000)', () => {
    const p = getProfile('GS20');
    expect(totalBytesForMode(p, 'full')).toBe(0x10000 + 0x40000);
    expect(p.fullRegions).toHaveLength(2);
  });

  it('GS20 BIN size is 512 KB (matches MS-class)', () => {
    expect(getProfile('GS20').binSize).toBe(0x80000);
  });


  it('regions never start before binOffset 0', () => {
    for (const p of ALL_PROFILES) {
      for (const mode of ['full', 'calibration'] as const) {
        for (const r of pickRegions(p, mode)) {
          expect(r.binOffset).toBeGreaterThanOrEqual(0);
          expect(r.end).toBeGreaterThanOrEqual(r.start);
        }
      }
    }
  });

  it('MS43 has the +0x80000 ECU/BIN shift on the program region', () => {
    const p = getProfile('MS43');
    const r = p.fullRegions.find((r) => r.start === 0x90000);
    expect(r).toBeDefined();
    expect(r!.binOffset).toBe(0x10000);
    expect(r!.start - r!.binOffset).toBe(0x80000);
  });

  it('GS20 ds2 address is 0x32; MS42/MS43 are 0x12', () => {
    expect(getProfile('GS20').ds2Addr).toBe(0x32);
    expect(getProfile('MS42').ds2Addr).toBe(0x12);
    expect(getProfile('MS43').ds2Addr).toBe(0x12);
  });
});
