import { describe, it, expect } from 'vitest';
import { MockIEdiabas } from './mock-ediabas.js';
import { buildEraseCommand, eraseRegion, ERASE_TUNE, ERASE_PROGRAM } from './erase.js';

function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

describe('buildEraseCommand', () => {
  it('lays out the parameter-region erase command exactly', () => {
    const cmd = buildEraseCommand(ERASE_TUNE);
    expect(cmd.length).toBe(22);
    // Header bytes.
    expect(cmd[0]).toBe(0x01);
    expect(cmd[4]).toBe(0xfe);
    expect(cmd[21]).toBe(0x00);
    // Length 0x20000 in LE at offset 13.
    expect(Array.from(cmd.subarray(13, 17))).toEqual([0x00, 0x00, 0x02, 0x00]);
    // Start 0x2040000 in LE at offset 17.
    expect(Array.from(cmd.subarray(17, 21))).toEqual([0x00, 0x00, 0x04, 0x02]);
  });

  it('lays out the program-region erase command exactly', () => {
    const cmd = buildEraseCommand(ERASE_PROGRAM);
    // Length 0xA0000 in LE.
    expect(Array.from(cmd.subarray(13, 17))).toEqual([0x00, 0x00, 0x0a, 0x00]);
    // Start 0x2060000 in LE.
    expect(Array.from(cmd.subarray(17, 21))).toEqual([0x00, 0x00, 0x06, 0x02]);
  });

  it('leaves untouched byte positions as zero', () => {
    const cmd = buildEraseCommand(ERASE_TUNE);
    for (const idx of [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(cmd[idx]).toBe(0);
    }
    // Trailer position stays 0x00 for erase (unlike flash_schreiben_adresse
    // which uses 0x03). Verified above already; assert once more for
    // clarity in isolation.
    expect(cmd[21]).toBe(0x00);
  });
});

describe('eraseRegion', () => {
  it('dispatches flash_loeschen with the built binary arg', async () => {
    const m = new MockIEdiabas();
    m.setResults('flash_loeschen', {});
    await eraseRegion(m, 'D_Motor', ERASE_TUNE);
    expect(m.calls).toHaveLength(1);
    const arg = m.calls[0]!.arg as Uint8Array;
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(toHex(arg)).toBe(toHex(buildEraseCommand(ERASE_TUNE)));
  });
});
