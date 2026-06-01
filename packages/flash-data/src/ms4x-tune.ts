/**
 * MS42 / MS43 firmware BIN field access — VIN, UIF, ISN, virginization.
 *
 * Addresses extracted from the community TunerPro XDF patchlists
 * (MS42 v1.7.1, MS43 v2.9.2).
 */

import { detectVariant, EXPECTED_FILE_LENGTH, type EcuVariant } from './ms4x-checksum.js';

// ── VIN codec (BMW packed representation) ──────────────────────────

function encodeChar(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;        // '0'-'9' → 0x00-0x09
  if (c >= 0x41 && c <= 0x5a) return 0x0a + (c - 0x41); // 'A'-'Z' → 0x0A-0x23
  throw new TuneError(`Invalid VIN character: ${ch}`);
}

function decodeChar(hex: number): string {
  if (hex <= 0x09) return String.fromCharCode(hex + 0x30);
  return String.fromCharCode(0x41 + (hex - 0x0a));
}

function encodeTuple(vin: string, offset: number): number {
  let result = 0;
  for (let i = 0; i < 4; i++) {
    result |= encodeChar(vin[offset + i]) << (18 - 6 * i);
  }
  return result;
}

function decodeTuple(val: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += decodeChar((val >> (18 - 6 * i)) & 0x3f);
  }
  return s;
}

export function encodeVin(vin: string): Uint8Array {
  if (!/^[A-Z0-9]{17}$/.test(vin)) {
    throw new TuneError(`Invalid VIN: ${vin} (must be 17 uppercase alphanumeric chars)`);
  }
  const out = new Uint8Array(13);
  out[0] = encodeChar(vin[0]);
  for (let t = 0; t < 4; t++) {
    const packed = encodeTuple(vin, 1 + t * 4);
    out[1 + t * 3] = (packed >> 16) & 0xff;
    out[2 + t * 3] = (packed >> 8) & 0xff;
    out[3 + t * 3] = packed & 0xff;
  }
  return out;
}

export function decodeVin(data: Uint8Array): string {
  if (data.length !== 13) {
    throw new TuneError(`VIN field must be 13 bytes, got ${data.length}`);
  }
  let result = decodeChar(data[0]);
  for (let t = 0; t < 4; t++) {
    const val = (data[1 + t * 3] << 16) | (data[2 + t * 3] << 8) | data[3 + t * 3];
    result += decodeTuple(val);
  }
  return result;
}

// ── per-variant layout tables ──────────────────────────────────────

export interface FirmwareLayout {
  variant: EcuVariant;
  uifBase: number;
  uifRows: number;
  uifRowSize: number;
  vinLength: number;
  isnOffset: number;
  isnSize: number;
  immoClearOffset: number;
  immoClearSize: number;
  ecuNumberOffset: number;
  ecuNumberSize: number;
  softwareVersionOffset: number;
  softwareVersionSize: number;
}

const MS42_LAYOUT: FirmwareLayout = {
  variant: 'MS42',
  uifBase: 0x3c4a,
  uifRows: 14,
  uifRowSize: 46,
  vinLength: 13,
  isnOffset: 0x3ede,
  isnSize: 6,
  immoClearOffset: 0x3ede,
  immoClearSize: 0x42,
  ecuNumberOffset: 0x3f80,
  ecuNumberSize: 8,
  softwareVersionOffset: 0x48042,
  softwareVersionSize: 6,
};

const MS43_LAYOUT: FirmwareLayout = {
  variant: 'MS43',
  uifBase: 0x3c40,
  uifRows: 14,
  uifRowSize: 46,
  vinLength: 13,
  isnOffset: 0x3ed4,
  isnSize: 6,
  immoClearOffset: 0x3ed4,
  immoClearSize: 0x4c,
  ecuNumberOffset: 0x3f80,
  ecuNumberSize: 8,
  softwareVersionOffset: 0x70042,
  softwareVersionSize: 6,
};

export function getLayout(variant: EcuVariant): FirmwareLayout {
  if (variant === 'MS42') return MS42_LAYOUT;
  return MS43_LAYOUT;
}

export function resolveLayout(buf: Uint8Array, variant?: EcuVariant): FirmwareLayout {
  const v = variant ?? detectVariant(buf);
  if (!v) throw new TuneError('Cannot auto-detect variant; pass --variant ms42|ms43');
  return getLayout(v);
}

// ── UIF field read ─────────────────────────────────────────────────

export interface UifRow {
  index: number;
  vin: string;
  date: Uint8Array;
  soft: Uint8Array;
  serv: Uint8Array;
  asm: Uint8Array;
  raw: Uint8Array;
}

function toAscii(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}

function readUifRow(buf: Uint8Array, layout: FirmwareLayout, row: number): UifRow {
  const base = layout.uifBase + row * layout.uifRowSize;
  const raw = buf.slice(base, base + layout.uifRowSize);
  const vinBytes = raw.slice(0, 13);
  const allFF = vinBytes.every(b => b === 0xff);
  const allZero = vinBytes.every(b => b === 0x00);
  let vin: string;
  try {
    vin = (allFF || allZero) ? '' : decodeVin(vinBytes);
  } catch {
    vin = `<raw: ${toHex(vinBytes)}>`;
  }
  return {
    index: row,
    vin,
    date: raw.slice(13, 16),
    soft: raw.slice(16, 20),
    serv: raw.slice(22, 26),
    asm: raw.slice(26, 30),
    raw,
  };
}

export function readUif(buf: Uint8Array, layout: FirmwareLayout): UifRow[] {
  const rows: UifRow[] = [];
  for (let i = 0; i < layout.uifRows; i++) {
    rows.push(readUifRow(buf, layout, i));
  }
  return rows;
}

// ── feature: VIN ───────────────────────────────────────────────────

export function readVin(buf: Uint8Array, layout: FirmwareLayout): string {
  return readUifRow(buf, layout, 0).vin;
}

export function writeVin(buf: Uint8Array, layout: FirmwareLayout, vin: string): void {
  const encoded = encodeVin(vin);
  for (let row = 0; row < layout.uifRows; row++) {
    const offset = layout.uifBase + row * layout.uifRowSize;
    buf.set(encoded, offset);
  }
}

// ── feature: ISN ───────────────────────────────────────────────────

export function readIsn(buf: Uint8Array, layout: FirmwareLayout): Uint8Array {
  return buf.slice(layout.isnOffset, layout.isnOffset + layout.isnSize);
}

// ── feature: ECU number ────────────────────────────────────────────

export function readEcuNumber(buf: Uint8Array, layout: FirmwareLayout): string {
  const slice = buf.slice(layout.ecuNumberOffset, layout.ecuNumberOffset + layout.ecuNumberSize);
  return toAscii(slice).replace(/[\x00\xff]+$/, '');
}

// ── feature: software version ──────────────────────────────────────

export function readSoftwareVersion(buf: Uint8Array, layout: FirmwareLayout): string {
  const slice = buf.slice(layout.softwareVersionOffset, layout.softwareVersionOffset + layout.softwareVersionSize);
  return toAscii(slice).replace(/[\x00\xff]+$/, '');
}

// ── feature: immo status / virginize ───────────────────────────────

export interface ImmoStatus {
  virgin: boolean;
  isnHex: string;
  rawHex: string;
}

export function readImmoStatus(buf: Uint8Array, layout: FirmwareLayout): ImmoStatus {
  const region = buf.slice(layout.immoClearOffset, layout.immoClearOffset + layout.immoClearSize);
  const virgin = region.every(b => b === 0xff);
  const isn = buf.slice(layout.isnOffset, layout.isnOffset + layout.isnSize);
  return {
    virgin,
    isnHex: toHex(isn),
    rawHex: toHex(region),
  };
}

export function virginize(buf: Uint8Array, layout: FirmwareLayout): void {
  buf.fill(0xff, layout.immoClearOffset, layout.immoClearOffset + layout.immoClearSize);
}

// ── helpers ────────────────────────────────────────────────────────

function toHex(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

export class TuneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TuneError';
  }
}
