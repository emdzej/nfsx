/**
 * MiniMon command protocol — what the secondary loader (MINIMONK)
 * implements after the handshake. Constants and framing per
 * `ME7BootTool.py` (open-source reference) and AP16064.
 *
 * Framing per command:
 *   host → ECU:  [CMD]
 *   ECU → host:  A_ACK1 (0xAA)
 *   host → ECU:  [payload...]
 *   ECU → host:  [response data, if any] + A_ACK2 (0xEA)
 *
 * All addresses are 32-bit little-endian; all length fields are 16-bit
 * little-endian.
 */
import { Buffer } from 'node:buffer';
import type { BootmodeTransport } from './transport.js';

export const A_ACK1 = 0xaa;
export const A_ACK2 = 0xea;

export const C_WRITE_WORD = 0x82;
export const C_READ_WORD = 0xcd;
export const C_WRITE_BLOCK = 0x84;
export const C_READ_BLOCK = 0x85;
export const C_CALL_FUNCTION = 0x9f;
export const C_GETCHECKSUM = 0x33;

export interface MinimonOptions {
  ackTimeoutMs?: number;
  readTimeoutMs?: number;
}

export class MinimonError extends Error {
  constructor(message: string, public readonly command: string) {
    super(`MiniMon ${command}: ${message}`);
    this.name = 'MinimonError';
  }
}

function leAddr(addr: number): Buffer {
  return Buffer.from([
    addr & 0xff,
    (addr >> 8) & 0xff,
    (addr >> 16) & 0xff,
    (addr >>> 24) & 0xff,
  ]);
}

function leWord(w: number): Buffer {
  return Buffer.from([w & 0xff, (w >> 8) & 0xff]);
}

async function expectByte(
  transport: BootmodeTransport,
  expected: number,
  command: string,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const b = (await transport.read(1, timeoutMs))[0];
  if (b !== expected) {
    throw new MinimonError(
      `expected ${what}=0x${expected.toString(16).padStart(2, '0').toUpperCase()}, got 0x${b
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()}`,
      command,
    );
  }
}

export class MinimonClient {
  private readonly ackTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(
    private readonly transport: BootmodeTransport,
    options: MinimonOptions = {},
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 500;
    this.readTimeoutMs = options.readTimeoutMs ?? 5000;
  }

  /** Read one 16-bit word from `addr`. */
  async readWord(addr: number): Promise<number> {
    await this.transport.write(Buffer.from([C_READ_WORD]));
    await expectByte(this.transport, A_ACK1, 'readWord', 'A_ACK1', this.ackTimeoutMs);
    await this.transport.write(leAddr(addr));
    const data = await this.transport.read(2, this.readTimeoutMs);
    await expectByte(this.transport, A_ACK2, 'readWord', 'A_ACK2', this.ackTimeoutMs);
    return data[0] | (data[1] << 8);
  }

  /** Write one 16-bit word to `addr`. */
  async writeWord(addr: number, value: number): Promise<void> {
    await this.transport.write(Buffer.from([C_WRITE_WORD]));
    await expectByte(this.transport, A_ACK1, 'writeWord', 'A_ACK1', this.ackTimeoutMs);
    await this.transport.write(Buffer.concat([leAddr(addr), leWord(value)]));
    await expectByte(this.transport, A_ACK2, 'writeWord', 'A_ACK2', this.ackTimeoutMs);
  }

  /** Read `length` bytes from `addr`. */
  async readBlock(addr: number, length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    await this.transport.write(Buffer.from([C_READ_BLOCK]));
    await expectByte(this.transport, A_ACK1, 'readBlock', 'A_ACK1', this.ackTimeoutMs);
    await this.transport.write(Buffer.concat([leAddr(addr), leWord(length)]));
    const data = await this.transport.read(length, Math.max(this.readTimeoutMs, length * 2));
    await expectByte(this.transport, A_ACK2, 'readBlock', 'A_ACK2', this.ackTimeoutMs);
    return data;
  }

  /** Write `data` to `addr`. */
  async writeBlock(addr: number, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    await this.transport.write(Buffer.from([C_WRITE_BLOCK]));
    await expectByte(this.transport, A_ACK1, 'writeBlock', 'A_ACK1', this.ackTimeoutMs);
    await this.transport.write(Buffer.concat([leAddr(addr), leWord(data.length), data]));
    await expectByte(this.transport, A_ACK2, 'writeBlock', 'A_ACK2', this.ackTimeoutMs);
  }

  /**
   * Call code at `address` passing 8 register words (R0..R7). Returns the
   * 8 register words on return. Long timeout because flash erase /
   * program can take seconds.
   */
  async callFunction(
    address: number,
    registers: ReadonlyArray<number>,
    timeoutMs = 60_000,
  ): Promise<number[]> {
    if (registers.length !== 8) {
      throw new MinimonError(`callFunction requires exactly 8 register words`, 'callFunction');
    }
    await this.transport.write(Buffer.from([C_CALL_FUNCTION]));
    await expectByte(this.transport, A_ACK1, 'callFunction', 'A_ACK1', this.ackTimeoutMs);
    const regBytes = Buffer.concat(registers.map((r) => leWord(r)));
    await this.transport.write(Buffer.concat([leAddr(address), regBytes]));
    // Wait for completion, then read returned regs + ACK2.
    const out = await this.transport.read(16, timeoutMs);
    await expectByte(this.transport, A_ACK2, 'callFunction', 'A_ACK2', timeoutMs);
    const result: number[] = [];
    for (let i = 0; i < 8; i++) result.push(out[i * 2] | (out[i * 2 + 1] << 8));
    return result;
  }

  /** Ask the loader to compute a checksum (Minimon-internal) over a region. */
  async getChecksum(addr: number, length: number): Promise<number> {
    await this.transport.write(Buffer.from([C_GETCHECKSUM]));
    await expectByte(this.transport, A_ACK1, 'getChecksum', 'A_ACK1', this.ackTimeoutMs);
    await this.transport.write(Buffer.concat([leAddr(addr), leWord(length)]));
    const data = await this.transport.read(2, Math.max(this.readTimeoutMs, length * 2));
    await expectByte(this.transport, A_ACK2, 'getChecksum', 'A_ACK2', this.ackTimeoutMs);
    return data[0] | (data[1] << 8);
  }
}
