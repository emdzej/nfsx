import { describe, expect, it } from 'vitest';
import { parseSgId, decodeSgIdHex } from './sgid.js';

describe('parseSgId', () => {
  it('parses directives + plain-hex entries', () => {
    const file = parseSgId(
      `$L 3\n` +
        `$V 1.00\n` +
        `$G 1.00\n` +
        `$K ACC65               A721000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2\n` +
        `$K AHM65               A871000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2\n`,
    );

    expect(file.unparsed).toEqual([]);
    expect(file.entries).toHaveLength(2);
    expect(file.directives.get('L')).toBe('3');
    expect(file.directives.get('V')).toBe('1.00');
    expect(file.directives.get('G')).toBe('1.00');
    expect(file.bySgTyp.get('ACC65')?.[0]?.payload).toBe('A721000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2');
    expect(file.bySgTyp.get('AHM65')?.[0]?.payload).toMatch(/^A871/);
  });

  it('preserves prefix-letter payloads opaquely (BMSKP2 = P-prefix, DXC853 = LN-prefix)', () => {
    // The leading P / LN aren't hex — they're tag letters whose
    // meaning is opaque to this parser. Real SGIDC + SGIDD ship
    // these regularly; the crypto layer is responsible for
    // interpreting them.
    const file = parseSgId(
      `$K BMSKP2  P212AA0192688D86101551D30C91F7C8372A72FDCFF665B7A63407B501E0EF759B6CD8FECFB69452DF\n` +
        `$K DXC853  LN29000064A98D2B422DF7BDA1722C41F21E8B11CB559C67BE72F5A95A0C4BA893FC1B11BD80CBEEE\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.entries).toHaveLength(2);
    expect(file.bySgTyp.get('BMSKP2')?.[0]?.payload.startsWith('P')).toBe(true);
    expect(file.bySgTyp.get('DXC853')?.[0]?.payload.startsWith('LN')).toBe(true);
  });

  it('accumulates multiple entries for the same SG_TYP (SGIDD has these)', () => {
    // Real SGIDD.AS2 has ECO65 appearing twice with different
    // payloads — different levels/variants — and the planner
    // needs both.
    const file = parseSgId(
      `$K ECO65 AN67000069ABA6A385D909B83074C62D43A5EBCA9D\n` +
        `$K ECO65 AN68000069ABA6A385D909B83074C62D43A5EBCA9D\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.bySgTyp.get('ECO65')).toHaveLength(2);
    expect(file.bySgTyp.get('ECO65')!.map((e) => e.payload.slice(0, 6))).toEqual(['AN6700', 'AN6800']);
  });

  it('preserves payload verbatim (no case normalisation, no trimming inside)', () => {
    const file = parseSgId(`$K ACC65 a721000068b9defb7d8b3e7eb10dd48a49f4cd79f2\n`);
    // Lowercase preserved — payload is opaque, normalisation is
    // the consumer's call.
    expect(file.entries[0]!.payload).toBe('a721000068b9defb7d8b3e7eb10dd48a49f4cd79f2');
  });

  it('flags malformed `$K` rows (only SG_TYP, no payload)', () => {
    const file = parseSgId(`$K only_one_field\n`);
    expect(file.unparsed).toHaveLength(1);
  });

  it('skips `;` comment lines', () => {
    const file = parseSgId(
      `; header comment\n` +
        `$L 3\n` +
        `; mid-file comment\n` +
        `$K ACC65 A721000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.entries).toHaveLength(1);
  });

  it('tolerates CRLF line endings', () => {
    const file = parseSgId(
      `$L 3\r\n$K ACC65 A721000068B9DEFB7D8B3E7EB10DD48A49F4CD79F2\r\n`,
    );
    expect(file.unparsed).toEqual([]);
    expect(file.entries).toHaveLength(1);
  });
});

describe('decodeSgIdHex', () => {
  it('decodes valid hex to Uint8Array', () => {
    const bytes = decodeSgIdHex('A721FF00');
    expect(bytes).toEqual(new Uint8Array([0xa7, 0x21, 0xff, 0x00]));
  });

  it('returns undefined for odd-length hex', () => {
    expect(decodeSgIdHex('A7')).toEqual(new Uint8Array([0xa7]));
    expect(decodeSgIdHex('A7F')).toBeUndefined();
  });

  it('returns undefined for invalid hex chars', () => {
    expect(decodeSgIdHex('A7ZZ')).toBeUndefined();
  });

  it('handles empty input', () => {
    expect(decodeSgIdHex('')).toEqual(new Uint8Array(0));
  });
});
