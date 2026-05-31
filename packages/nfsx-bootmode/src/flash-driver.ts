/**
 * AMD AM29F400B flash driver wrapper — MiniMon-official protocol.
 *
 * The chip in BMW MS42 / MS43 ECUs. The driver itself is the
 * `A29F400B.hex` blob from MiniMon v2.30 — uploaded into the C167's
 * RAM and then invoked via `MinimonClient.callFunction(driverEntry,
 * [FC, …])`.
 *
 * Calling conventions per the MiniMon user manual (page 35,
 * "Monitor Extension Interface for User Subroutines/Drivers") and
 * cross-checked against the open-source xcflasher reference:
 *
 *   FC_PROG  = 0x00
 *     R9  = source block length (bytes)
 *     R10 = source address LOW
 *     R11 = source address HIGH
 *     R13 = destination address LOW
 *     R14 = destination address HIGH
 *     R15 = error (return)
 *
 *   FC_ERASE = 0x01
 *     R14 = sector number
 *     R15 = error (return)
 *
 * The driver itself hardcodes the unlock-command addresses to segment
 * `0x08` (= chip-side `0x080000-0x0FFFFF`). On MS42 the flash chip's
 * upper CPU address bits A19-A23 are not connected, so chip cells at
 * CPU `0x080000` alias to the same cells we read at CPU `0x800000`.
 * One physical chip, multiple address windows.
 */
import { Buffer } from 'node:buffer';
import { MinimonClient } from './minimon.js';

export const FC_PROG = 0x00;
export const FC_ERASE = 0x01;
export const FC_GETSTATE = 0x06;

/**
 * Driver upload address in C167CR XRAM (0xE000-0xE7FF).
 * The HEX is linked at 0xE000 and the driver uses absolute intra-segment
 * jumps (JMP cc,caddr) — it is NOT relocatable. Must be loaded at its
 * native link address.
 */
export const DEFAULT_DRIVER_ADDRESS = 0x00e000;

export const AM29F400B_TOTAL_BYTES = 0x80000;

export interface SectorLayout {
  /** Sector index (passed as R14 to FC_ERASE). */
  index: number;
  /** Byte offset within flash. */
  start: number;
  /** Sector size in bytes. */
  size: number;
}

/** Bottom-boot AM29F400BB sector layout (confirmed for BMW MS42). */
export const AM29F400BB_SECTORS: SectorLayout[] = [
  { index: 0, start: 0x00000, size: 0x04000 }, // 16 KB
  { index: 1, start: 0x04000, size: 0x02000 }, // 8 KB
  { index: 2, start: 0x06000, size: 0x02000 }, // 8 KB
  { index: 3, start: 0x08000, size: 0x08000 }, // 32 KB
  { index: 4, start: 0x10000, size: 0x10000 }, // 64 KB
  { index: 5, start: 0x20000, size: 0x10000 },
  { index: 6, start: 0x30000, size: 0x10000 },
  { index: 7, start: 0x40000, size: 0x10000 },
  { index: 8, start: 0x50000, size: 0x10000 },
  { index: 9, start: 0x60000, size: 0x10000 },
  { index: 10, start: 0x70000, size: 0x10000 },
];

/**
 * MiniMon's default driver-data exchange buffer (per the user
 * manual, page 36 "Memory Management → Data Exchange": default at
 * 0xFC80, 128 bytes). We program one block at a time via this
 * buffer; the open-source xcflasher uses the same address and a
 * smaller per-burst payload (typically 32-64 bytes).
 */
export const DEFAULT_DATA_BUFFER_ADDRESS = 0x00fc80;

/** Max programming burst size (bytes) — keep within the buffer size. */
export const DEFAULT_BURST_SIZE = 0x40; // 64 bytes — conservative

export interface FlashDriverOptions {
  /** Override the driver upload address. Default 0x00F600 (internal RAM). */
  driverAddress?: number;
  /** Override the data-exchange buffer. Default 0x00FC80 (MiniMon default). */
  dataBufferAddress?: number;
  /** Per-call program burst size in bytes. Default 0x40 (64). */
  burstSize?: number;
}

export class FlashDriverError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(`FlashDriver ${stage}: ${message}`);
    this.name = 'FlashDriverError';
  }
}

const lo16 = (v: number) => v & 0xffff;
const hi16 = (v: number) => (v >>> 16) & 0xffff;

export class FlashDriver {
  private uploaded = false;
  private readonly driverAddress: number;
  private readonly dataBufferAddress: number;
  private readonly burstSize: number;

  constructor(
    private readonly client: MinimonClient,
    private readonly driverImage: Buffer,
    options: FlashDriverOptions = {},
  ) {
    this.driverAddress = options.driverAddress ?? DEFAULT_DRIVER_ADDRESS;
    this.dataBufferAddress = options.dataBufferAddress ?? DEFAULT_DATA_BUFFER_ADDRESS;
    this.burstSize = options.burstSize ?? DEFAULT_BURST_SIZE;
  }

  get bufferAddress(): number {
    return this.dataBufferAddress;
  }

  get maxBurstSize(): number {
    return this.burstSize;
  }

  /** Upload the driver image into MCU RAM. Idempotent. */
  async upload(): Promise<void> {
    if (this.uploaded) return;
    const CHUNK = 256;
    for (let off = 0; off < this.driverImage.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, this.driverImage.length);
      await this.client.writeBlock(
        this.driverAddress + off,
        this.driverImage.subarray(off, end),
      );
    }
    this.uploaded = true;

    const readback = await this.client.readBlock(this.driverAddress, 8);
    const expected = this.driverImage.subarray(0, 8);
    const match = readback.every((b, i) => b === expected[i]);
    process.stderr.write(
      `[diag] driver upload verify: ${match ? 'OK' : 'MISMATCH'} ` +
      `wrote=${[...expected].map(b => b.toString(16).padStart(2,'0')).join(' ')} ` +
      `read=${[...readback].map(b => b.toString(16).padStart(2,'0')).join(' ')}\n`,
    );
  }

  /**
   * Erase one sector by its index. The MiniMon driver looks up the
   * sector's address internally — we just pass the index in R14.
   */
  async eraseSector(sectorIndex: number): Promise<void> {
    await this.upload();
    const regs = await this.client.callFunction(
      this.driverAddress,
      [
        FC_ERASE, // R8
        0, // R9
        0, // R10
        0, // R11
        0, // R12
        0, // R13
        sectorIndex, // R14
        0, // R15
      ],
      30_000, // erase can take seconds
    );
    process.stderr.write(
      `[diag] FC_ERASE sector ${sectorIndex} returned regs: ` +
      regs.map((r, i) => `R${i+8}=0x${r.toString(16)}`).join(' ') + '\n',
    );
    if (regs[7] !== 0) {
      throw new FlashDriverError(
        `FC_ERASE sector ${sectorIndex} returned status 0x${regs[7].toString(16)}`,
        'erase',
      );
    }
  }

  /**
   * Program a block of bytes at flash offset `destAddr`. Stages data
   * into the driver buffer via `writeBlock`, then invokes FC_PROG.
   *
   * The destination is a full address in the C167's view of the
   * chip — typically `0x080000 + flash_offset` (matching the
   * driver's internal segment-0x08 unlock writes; due to A19-A23
   * being unconnected, this aliases to `0x800000 + flash_offset`).
   */
  async programBlock(destAddr: number, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    if (data.length > this.burstSize) {
      throw new FlashDriverError(
        `programBlock max ${this.burstSize} bytes per call (got ${data.length})`,
        'program',
      );
    }
    await this.upload();
    await this.client.writeBlock(this.dataBufferAddress, data);
    const regs = await this.client.callFunction(
      this.driverAddress,
      [
        FC_PROG, // R8
        data.length, // R9 = length
        lo16(this.dataBufferAddress), // R10 = src low
        hi16(this.dataBufferAddress), // R11 = src high
        0, // R12
        lo16(destAddr), // R13 = dst low
        hi16(destAddr), // R14 = dst high
        0, // R15
      ],
      30_000,
    );
    if (regs[7] !== 0) {
      throw new FlashDriverError(
        `FC_PROG @ 0x${destAddr.toString(16)} returned status 0x${regs[7].toString(16)}`,
        'program',
      );
    }
  }
}
