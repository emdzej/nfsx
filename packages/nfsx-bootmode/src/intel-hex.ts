/**
 * Intel HEX format parser. Used to decode the bundled MiniMon binaries
 * (LOADK.hex, MINIMONK.hex, A29F400B.hex) into byte arrays ready for upload.
 *
 * Format:
 *   :LLAAAATT[DD...]CC
 *     LL = byte count (2 hex chars)
 *     AAAA = address (4 hex chars, big-endian)
 *     TT = record type:
 *       00 = data
 *       01 = end of file
 *       02 = extended segment address (segment * 16 added to subsequent addresses)
 *       03 = start segment address (CS:IP entry point, no data needed for our case)
 *       04 = extended linear address (upper 16 bits of 32-bit address)
 *       05 = start linear address (32-bit entry point)
 *     DD = data bytes (LL count)
 *     CC = two's-complement checksum of all bytes excluding the colon and itself
 */
import { Buffer } from 'node:buffer';

export interface IntelHexBlock {
  /** Linear byte address (extended-segment/linear addressing applied). */
  address: number;
  data: Buffer;
}

export interface IntelHexResult {
  blocks: IntelHexBlock[];
  /** Optional CS:IP / EIP entry point if a type-03 or type-05 record was present. */
  entryPoint?: number;
  /** Total byte count across all data records. */
  totalBytes: number;
}

export class IntelHexParseError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`Intel HEX parse error at line ${line}: ${message}`);
    this.name = 'IntelHexParseError';
  }
}

function hexByte(hex: string, off: number, line: number): number {
  if (off + 2 > hex.length) {
    throw new IntelHexParseError(`expected hex byte at offset ${off}, got end of line`, line);
  }
  const val = Number.parseInt(hex.slice(off, off + 2), 16);
  if (Number.isNaN(val)) {
    throw new IntelHexParseError(`invalid hex byte "${hex.slice(off, off + 2)}"`, line);
  }
  return val;
}

function hexWord(hex: string, off: number, line: number): number {
  return (hexByte(hex, off, line) << 8) | hexByte(hex, off + 2, line);
}

export function parseIntelHex(text: string): IntelHexResult {
  const lines = text.split(/\r?\n/);
  const blocks: IntelHexBlock[] = [];
  let entryPoint: number | undefined;
  let extLinear = 0;
  let extSegment = 0;
  let totalBytes = 0;
  let seenEOF = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (raw.length === 0) continue;
    if (!raw.startsWith(':')) {
      throw new IntelHexParseError(`record must start with ':'`, lineNo);
    }
    if (seenEOF) {
      throw new IntelHexParseError(`data after EOF record`, lineNo);
    }
    const body = raw.slice(1);
    if (body.length < 10 || body.length % 2 !== 0) {
      throw new IntelHexParseError(`malformed record (length ${body.length})`, lineNo);
    }

    const count = hexByte(body, 0, lineNo);
    const addr = hexWord(body, 2, lineNo);
    const type = hexByte(body, 6, lineNo);
    const dataStart = 8;
    const dataEnd = dataStart + count * 2;
    if (body.length !== dataEnd + 2) {
      throw new IntelHexParseError(
        `byte count ${count} disagrees with record length ${body.length}`,
        lineNo,
      );
    }

    // Validate checksum: sum of all bytes (count + addr_hi + addr_lo + type + data + chk) mod 256 == 0
    let sum = count + ((addr >> 8) & 0xff) + (addr & 0xff) + type;
    const data = new Uint8Array(count);
    for (let b = 0; b < count; b++) {
      const byte = hexByte(body, dataStart + b * 2, lineNo);
      data[b] = byte;
      sum += byte;
    }
    const chk = hexByte(body, dataEnd, lineNo);
    if (((sum + chk) & 0xff) !== 0) {
      throw new IntelHexParseError(
        `checksum mismatch (computed ${((-sum) & 0xff).toString(16)}, declared ${chk.toString(16)})`,
        lineNo,
      );
    }

    switch (type) {
      case 0x00: {
        const linearAddr = (extLinear << 16) | ((extSegment * 16) + addr);
        blocks.push({ address: linearAddr, data: Buffer.from(data) });
        totalBytes += count;
        break;
      }
      case 0x01:
        seenEOF = true;
        break;
      case 0x02:
        if (count !== 2) {
          throw new IntelHexParseError(`ext-segment record must have 2 data bytes`, lineNo);
        }
        extSegment = (data[0] << 8) | data[1];
        extLinear = 0;
        break;
      case 0x03:
        if (count !== 4) {
          throw new IntelHexParseError(`start-segment record must have 4 data bytes`, lineNo);
        }
        entryPoint = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        break;
      case 0x04:
        if (count !== 2) {
          throw new IntelHexParseError(`ext-linear record must have 2 data bytes`, lineNo);
        }
        extLinear = (data[0] << 8) | data[1];
        extSegment = 0;
        break;
      case 0x05:
        if (count !== 4) {
          throw new IntelHexParseError(`start-linear record must have 4 data bytes`, lineNo);
        }
        entryPoint = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        break;
      default:
        throw new IntelHexParseError(`unknown record type 0x${type.toString(16)}`, lineNo);
    }
  }

  if (!seenEOF) {
    throw new IntelHexParseError(`missing EOF record (type 01)`, lines.length);
  }

  return { blocks, entryPoint, totalBytes };
}

/**
 * Concatenate all data blocks in address order into a single contiguous
 * buffer. Useful when the blocks are all consecutive (as in the MiniMon
 * loaders). Throws if there is a gap or overlap.
 */
export function flattenIntelHex(result: IntelHexResult): Buffer {
  if (result.blocks.length === 0) return Buffer.alloc(0);
  const sorted = [...result.blocks].sort((a, b) => a.address - b.address);
  const baseAddr = sorted[0].address;
  const lastBlock = sorted[sorted.length - 1];
  const totalLen = lastBlock.address + lastBlock.data.length - baseAddr;
  const out = Buffer.alloc(totalLen, 0xff);
  let cursor = baseAddr;
  for (const b of sorted) {
    if (b.address < cursor) {
      throw new IntelHexParseError(
        `overlapping data: block at 0x${b.address.toString(16)} overlaps prior block ending at 0x${cursor.toString(16)}`,
        0,
      );
    }
    b.data.copy(out, b.address - baseAddr);
    cursor = b.address + b.data.length;
  }
  return out;
}
