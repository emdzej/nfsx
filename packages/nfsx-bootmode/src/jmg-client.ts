/**
 * Alternative bootmode flash client — single-byte command protocol.
 *
 * This talks to the 898-byte monolithic secondary blob (JMG_BLOB.hex)
 * which has a built-in AMD AM29F400B flash driver. No separate driver
 * upload needed — everything runs from the blob loaded at 0xFA60.
 *
 * Protocol (reverse-engineered from C167 disassembly):
 *
 *   0xC5 = universal ack / ready byte
 *   0x10 = EINIT (enable interrupts, boot completion)
 *   0x99 = SRST (software reset)
 *   0xA7 = READ  (read one 16 KB page: host sends page byte, blob
 *                  returns 8192 little-endian words)
 *   0xA8 = SPI_READ  (MS43 EEPROM — not used here)
 *   0xA9 = SPI_WRITE (MS43 EEPROM — not used here)
 *   0xB0 = PROGRAM (program one 16 KB page: host sends page byte,
 *                    then 8192 × (lo, hi) byte pairs; blob acks
 *                    0xC5 every 128 bytes as flow control)
 *   0xB4 = ERASE  (full chip erase, blob acks 0xC5 when done)
 *
 * Flash addressing: the blob programs to segment 0x10 and polls
 * DQ7 from segment 0x08. 512 KB = 32 pages of 16 KB each
 * (pages 0x00–0x1F).
 */
import type { BootmodeTransport } from './transport-interface.js';

export const JMG_ACK = 0xc5;

export const CMD_EINIT = 0x10;
export const CMD_SRST = 0x99;
export const CMD_READ = 0xa7;
export const CMD_SPI_READ = 0xa8;
export const CMD_SPI_WRITE = 0xa9;
export const CMD_PROGRAM = 0xb0;
export const CMD_ERASE = 0xb4;

export const JMG_PAGE_SIZE = 0x4000; // 16 KB
export const JMG_TOTAL_PAGES = 32; // 512 KB / 16 KB
export const JMG_WORDS_PER_PAGE = JMG_PAGE_SIZE / 2; // 8192

export class JmgClientError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(`JmgClient ${stage}: ${message}`);
    this.name = 'JmgClientError';
  }
}

export class JmgClient {
  constructor(private readonly transport: BootmodeTransport) {}

  private async sendCmd(cmd: number): Promise<void> {
    await this.transport.write(new Uint8Array([cmd]));
  }

  private async expectAck(stage: string, timeoutMs = 5000): Promise<void> {
    const resp = await this.transport.read(1, timeoutMs);
    if (resp[0] !== JMG_ACK) {
      throw new JmgClientError(
        `expected ack 0x${JMG_ACK.toString(16)}, got 0x${resp[0]!.toString(16)}`,
        stage,
      );
    }
  }

  async einit(): Promise<void> {
    await this.sendCmd(CMD_EINIT);
    await this.expectAck('einit');
  }

  async srst(): Promise<void> {
    await this.sendCmd(CMD_SRST);
  }

  /**
   * Full chip erase. The blob handles the AMD erase sequence internally
   * and sends 0xC5 when done. Can take several seconds.
   */
  async erase(): Promise<void> {
    await this.sendCmd(CMD_ERASE);
    await this.expectAck('erase', 30_000);
  }

  /**
   * Read one 16 KB page (0x00–0x1F). Returns a 16384-byte Uint8Array.
   * The blob sends 8192 little-endian words.
   */
  async readPage(page: number): Promise<Uint8Array> {
    if (page < 0 || page >= JMG_TOTAL_PAGES) {
      throw new JmgClientError(`page ${page} out of range 0..${JMG_TOTAL_PAGES - 1}`, 'read');
    }
    await this.sendCmd(CMD_READ);
    // No initial ack — blob goes straight to waiting for the page byte.
    await this.transport.write(new Uint8Array([page]));
    const data = await this.transport.read(JMG_PAGE_SIZE, 30_000);
    return data;
  }

  /**
   * Program one 16 KB page (0x00–0x1F) from a 16384-byte Uint8Array.
   * The blob expects 8192 × (lo, hi) pairs and sends 0xC5 every
   * 128 bytes as flow control.
   */
  async programPage(page: number, data: Uint8Array): Promise<void> {
    if (page < 0 || page >= JMG_TOTAL_PAGES) {
      throw new JmgClientError(`page ${page} out of range 0..${JMG_TOTAL_PAGES - 1}`, 'program');
    }
    if (data.length !== JMG_PAGE_SIZE) {
      throw new JmgClientError(
        `page data must be exactly ${JMG_PAGE_SIZE} bytes (got ${data.length})`,
        'program',
      );
    }
    await this.sendCmd(CMD_PROGRAM);
    // No initial ack — blob goes straight to waiting for the page byte.
    await this.transport.write(new Uint8Array([page]));

    // Send 16384 bytes in 128-byte bursts, waiting for 0xC5 ack after each.
    const BURST = 128;
    for (let off = 0; off < JMG_PAGE_SIZE; off += BURST) {
      const chunk = data.subarray(off, off + BURST);
      await this.transport.write(chunk);
      await this.expectAck(`program-page${page}-burst${off / BURST}`, 30_000);
    }
  }
}
