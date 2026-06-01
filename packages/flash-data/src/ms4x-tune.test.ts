import { describe, it, expect } from 'vitest';
import {
  encodeVin,
  decodeVin,
  readVin,
  writeVin,
  readImmoStatus,
  virginize,
  readIsn,
  readEcuNumber,
  readUif,
  getLayout,
  TuneError,
} from './ms4x-tune.js';

describe('VIN codec', () => {
  const KNOWN_VIN = 'WBAPH5C55BA123456';
  const KNOWN_ENCODED = encodeVin(KNOWN_VIN);

  it('encodes to 13 bytes', () => {
    expect(KNOWN_ENCODED.length).toBe(13);
  });

  it('round-trips encode → decode', () => {
    expect(decodeVin(KNOWN_ENCODED)).toBe(KNOWN_VIN);
  });

  it('round-trips all-digit VIN', () => {
    const vin = '12345678901234567';
    expect(decodeVin(encodeVin(vin))).toBe(vin);
  });

  it('round-trips all-letter VIN', () => {
    const vin = 'ABCDEFGHJKLMNPRST';
    expect(decodeVin(encodeVin(vin))).toBe(vin);
  });

  it('rejects VIN with lowercase', () => {
    expect(() => encodeVin('wbaph5c55ba123456')).toThrow(TuneError);
  });

  it('rejects VIN with wrong length', () => {
    expect(() => encodeVin('WBAPH5C55BA12345')).toThrow(TuneError);
  });

  it('rejects decode of wrong-size buffer', () => {
    expect(() => decodeVin(new Uint8Array(12))).toThrow(TuneError);
  });
});

describe('firmware BIN operations', () => {
  const layout42 = getLayout('MS42');
  const layout43 = getLayout('MS43');

  function makeBin(): Uint8Array {
    return new Uint8Array(0x80000).fill(0xff);
  }

  describe('readVin / writeVin', () => {
    it('reads empty VIN from blank BIN (all FF)', () => {
      const bin = makeBin();
      expect(readVin(bin, layout43)).toBe('');
    });

    it('writes VIN and reads it back (MS43)', () => {
      const bin = makeBin();
      const vin = 'WBAPH5C55BA123456';
      writeVin(bin, layout43, vin);
      expect(readVin(bin, layout43)).toBe(vin);
    });

    it('writes VIN and reads it back (MS42)', () => {
      const bin = makeBin();
      const vin = 'WBADT43443G123456';
      writeVin(bin, layout42, vin);
      expect(readVin(bin, layout42)).toBe(vin);
    });

    it('stamps all 14 UIF rows', () => {
      const bin = makeBin();
      const vin = 'WBAPH5C55BA123456';
      writeVin(bin, layout43, vin);
      const rows = readUif(bin, layout43);
      for (const row of rows) {
        expect(row.vin).toBe(vin);
      }
    });
  });

  describe('readImmoStatus / virginize', () => {
    it('detects virgin state on blank BIN', () => {
      const bin = makeBin();
      const status = readImmoStatus(bin, layout43);
      expect(status.virgin).toBe(true);
    });

    it('detects non-virgin state', () => {
      const bin = makeBin();
      bin[layout43.isnOffset] = 0x42;
      const status = readImmoStatus(bin, layout43);
      expect(status.virgin).toBe(false);
    });

    it('virginizes a non-virgin BIN', () => {
      const bin = makeBin();
      for (let i = 0; i < layout43.immoClearSize; i++) {
        bin[layout43.immoClearOffset + i] = 0x00;
      }
      expect(readImmoStatus(bin, layout43).virgin).toBe(false);
      virginize(bin, layout43);
      expect(readImmoStatus(bin, layout43).virgin).toBe(true);
    });
  });

  describe('readIsn', () => {
    it('returns 6-byte ISN', () => {
      const bin = makeBin();
      bin[layout43.isnOffset] = 0x01;
      bin[layout43.isnOffset + 1] = 0x02;
      const isn = readIsn(bin, layout43);
      expect(isn.length).toBe(6);
      expect(isn[0]).toBe(0x01);
      expect(isn[1]).toBe(0x02);
    });
  });

  describe('readEcuNumber', () => {
    it('reads ASCII ECU number', () => {
      const bin = makeBin();
      const num = '7545150';
      for (let i = 0; i < num.length; i++) {
        bin[layout43.ecuNumberOffset + i] = num.charCodeAt(i);
      }
      expect(readEcuNumber(bin, layout43)).toBe(num);
    });
  });

  describe('readUif', () => {
    it('returns 14 rows', () => {
      const bin = makeBin();
      const rows = readUif(bin, layout43);
      expect(rows.length).toBe(14);
    });
  });
});
