/**
 * Decoder for the MS4x DS2 IDENT payload (cmd 0x00 — 42 ASCII bytes of
 * hardware/software identification).
 */
import { Buffer } from 'node:buffer';

export interface IdentFields {
  /** Bosch/Siemens supplier hardware part number (7 chars). */
  hwNumber: string;
  /** Hardware index (1 char). */
  hwIndex: string;
  /** Software number (8 chars). */
  swNumber: string;
  /** Coding index (2 chars). */
  codingIndex: string;
  /** Diagnostic index (2 chars). */
  diagIndex: string;
  /** Bus / factory index (4 chars). */
  busIndex: string;
  /** BMW spare part number (7 chars, often alphanumeric). */
  bmwNumber: string;
  /** ECU variant (2 chars). */
  variant: string;
  /** Software date / version code (8 chars). */
  swDate: string;
  /** Raw ASCII (for unknown layouts / debugging). */
  raw: string;
}

function asciiPrintable(buf: Buffer): string {
  return buf.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
}

export function decodeIdent(identPayload: Buffer): IdentFields {
  const ascii = identPayload.toString('ascii');
  const slice = (start: number, len: number) =>
    ascii.slice(start, start + len).replace(/\0+$/, '');
  return {
    hwNumber: slice(0, 7),
    hwIndex: slice(7, 1),
    swNumber: slice(8, 8),
    codingIndex: slice(16, 2),
    diagIndex: slice(18, 2),
    busIndex: slice(20, 4),
    bmwNumber: slice(24, 7),
    variant: slice(31, 2),
    swDate: slice(34, 8),
    raw: asciiPrintable(identPayload),
  };
}
