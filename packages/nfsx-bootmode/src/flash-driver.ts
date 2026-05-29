/**
 * AMD AM29F400B flash driver wrapper.
 *
 * The chip used in BMW MS42 and MS43 ECUs. The driver itself is the
 * `A29F400B.hex` blob — it's uploaded into the C167's RAM (via
 * `MinimonClient.writeBlock`) and then invoked via
 * `MinimonClient.callFunction(driverEntry, [FC, ...])`.
 *
 * FC sub-commands (per ME7BootTool.py and AP16064):
 *   FC_PROG     = 0x00  program one or more bytes/words
 *   FC_ERASE    = 0x01  erase one sector
 *   FC_GETSTATE = 0x06  read manufacturer / device ID
 *   FC_UNLOCK   = 0x11  unlock the flash bank
 *
 * Per-FC register conventions in the driver are not formally documented;
 * the ones below match ME7BootTool's invocations of the AMD-flash driver
 * for MS-class ECUs and the comments in `A29F400B.a66` (MiniMon
 * distribution). If you encounter different behaviour on a specific
 * ECU revision, dump the driver's listing and adjust.
 */
import { Buffer } from 'node:buffer';
import { MinimonClient } from './minimon.js';

export const FC_PROG = 0x00;
export const FC_ERASE = 0x01;
export const FC_GETSTATE = 0x06;
export const FC_UNLOCK = 0x11;

/**
 * Default driver upload location in C167 internal RAM. Matches the
 * TRANSFERBUFFERSTARTADDRESS used by MiniMon's K-line kernel
 * (default.ini: `TRANSFERBUFFERSTARTADDRESS=00FC80`).
 *
 * If the kernel.ini for a given chip pairs the driver to a different
 * address, override via FlashDriverOptions.driverAddress.
 */
export const DEFAULT_DRIVER_ADDRESS = 0x00fc80;

export interface FlashDriverOptions {
  driverAddress?: number;
}

/**
 * AMD AM29F400B sector layout, in word (16-bit) addresses for the
 * physical chip. Total = 512 KB across 11 sectors:
 *   SA0:  16 KB at 0x00000-0x03FFF (boot block, 4 × 4 KB sub-sectors)
 *   SA1:   8 KB at 0x04000-0x05FFF
 *   SA2:   8 KB at 0x06000-0x07FFF
 *   SA3:  32 KB at 0x08000-0x0FFFF
 *   SA4-10: 64 KB each at 0x10000, 0x20000, ... 0x70000
 *
 * For BMW MS42/MS43 the flash is mapped to ECU address 0x00000-0x7FFFF
 * (1:1 between BIN offset and ECU address).
 */
export interface SectorDef {
  /** Sector index (0..10). */
  index: number;
  /** Starting ECU/BIN address. */
  start: number;
  /** Inclusive ending ECU/BIN address. */
  end: number;
  /** Sector size in bytes. */
  size: number;
}

export const AM29F400B_SECTORS: SectorDef[] = [
  { index: 0, start: 0x00000, end: 0x03fff, size: 0x4000 },
  { index: 1, start: 0x04000, end: 0x05fff, size: 0x2000 },
  { index: 2, start: 0x06000, end: 0x07fff, size: 0x2000 },
  { index: 3, start: 0x08000, end: 0x0ffff, size: 0x8000 },
  { index: 4, start: 0x10000, end: 0x1ffff, size: 0x10000 },
  { index: 5, start: 0x20000, end: 0x2ffff, size: 0x10000 },
  { index: 6, start: 0x30000, end: 0x3ffff, size: 0x10000 },
  { index: 7, start: 0x40000, end: 0x4ffff, size: 0x10000 },
  { index: 8, start: 0x50000, end: 0x5ffff, size: 0x10000 },
  { index: 9, start: 0x60000, end: 0x6ffff, size: 0x10000 },
  { index: 10, start: 0x70000, end: 0x7ffff, size: 0x10000 },
];

export const AM29F400B_TOTAL_BYTES = 0x80000;

export class FlashDriver {
  private readonly driverAddress: number;
  private uploaded = false;

  constructor(
    private readonly client: MinimonClient,
    private readonly driverImage: Buffer,
    options: FlashDriverOptions = {},
  ) {
    this.driverAddress = options.driverAddress ?? DEFAULT_DRIVER_ADDRESS;
  }

  /**
   * Upload the driver image into MCU RAM. Must be called before any of
   * the FC_* operations. Safe to call multiple times; subsequent calls
   * are a no-op.
   */
  async upload(): Promise<void> {
    if (this.uploaded) return;
    // Chunk uploads to keep individual writeBlock payloads under
    // MiniMon's per-block ceiling. 256 bytes is well under any
    // realistic limit.
    const CHUNK = 256;
    for (let off = 0; off < this.driverImage.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, this.driverImage.length);
      const slice = this.driverImage.subarray(off, end);
      await this.client.writeBlock(this.driverAddress + off, slice);
    }
    this.uploaded = true;
  }

  /** Read chip ID + status (manufacturer / device). */
  async getState(): Promise<{ manufacturer: number; device: number }> {
    await this.upload();
    const regs = await this.client.callFunction(this.driverAddress, [
      FC_GETSTATE,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    return { manufacturer: regs[0], device: regs[1] };
  }

  /** Unlock the flash bank — must be called once before any erase or program. */
  async unlock(): Promise<void> {
    await this.upload();
    await this.client.callFunction(this.driverAddress, [FC_UNLOCK, 0, 0, 0, 0, 0, 0, 0]);
  }

  /**
   * Erase one sector. `sectorStart` is the byte address of the sector
   * to erase (must match an `AM29F400B_SECTORS[i].start`).
   *
   * Convention: R0 = FC_ERASE, R1 = sector start low, R2 = sector start
   * high. Erase can take seconds; we allow a generous 30-second per-sector
   * timeout.
   */
  async eraseSector(sectorStart: number): Promise<void> {
    await this.upload();
    const lo = sectorStart & 0xffff;
    const hi = (sectorStart >>> 16) & 0xffff;
    await this.client.callFunction(
      this.driverAddress,
      [FC_ERASE, lo, hi, 0, 0, 0, 0, 0],
      30_000,
    );
  }

  /**
   * Erase every sector covering [start..=end]. Walks the sector table.
   */
  async eraseRange(start: number, end: number): Promise<SectorDef[]> {
    const erased: SectorDef[] = [];
    for (const s of AM29F400B_SECTORS) {
      if (s.end < start) continue;
      if (s.start > end) break;
      await this.eraseSector(s.start);
      erased.push(s);
    }
    return erased;
  }

  /**
   * Program a block of bytes starting at `address`. The driver iterates
   * word-by-word internally; the caller hands it the destination,
   * source-in-RAM, and length.
   *
   * Strategy: stage `data` into RAM at TRANSFERBUFFER+driver_size (so we
   * don't overlap the driver code), then call FC_PROG with R1=dest low,
   * R2=dest high, R3=src low, R4=src high, R5=length-in-words.
   *
   * For simplicity we keep program calls bounded to 256 bytes — well
   * within the staging buffer.
   */
  async programBlock(address: number, data: Buffer): Promise<void> {
    await this.upload();
    if (data.length === 0) return;
    if (data.length & 1) {
      throw new Error(
        `programBlock requires an even byte count (got ${data.length}) — AM29F400B is 16-bit word organised`,
      );
    }
    const CHUNK = 256;
    // Stage area: just past the driver image.
    const stageBase = this.driverAddress + this.driverImage.length + 16;
    for (let off = 0; off < data.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, data.length);
      const slice = data.subarray(off, end);
      await this.client.writeBlock(stageBase, slice);
      const dest = address + off;
      const destLo = dest & 0xffff;
      const destHi = (dest >>> 16) & 0xffff;
      const srcLo = stageBase & 0xffff;
      const srcHi = (stageBase >>> 16) & 0xffff;
      const words = slice.length >> 1;
      await this.client.callFunction(
        this.driverAddress,
        [FC_PROG, destLo, destHi, srcLo, srcHi, words, 0, 0],
        15_000,
      );
    }
  }
}
