/**
 * C167 BSL handshake + MiniMon loader staging.
 *
 * Sequence (per Infineon AP16012 + MiniMon AP16064):
 *
 *   1. Power on the ECU with BOOT pin grounded. MCU enters BSL.
 *   2. Host writes 0x00 → BSL uses the bit pattern for auto-baud.
 *   3. BSL replies with one identification byte. Each C167 derivative
 *      reports a different value (e.g. C167CR returns 0xC5).
 *   4. Host uploads exactly 32 bytes of primary loader, byte-by-byte,
 *      each byte echo-verified by the BSL on the K-line.
 *   5. BSL jumps to the loaded primary. Primary acks (MiniMon
 *      convention: 0x01 = I_LOADER_STARTED).
 *   6. Host uploads the secondary loader (MINIMONK) byte-by-byte. The
 *      primary echo-verifies and copies each byte into the higher RAM
 *      region.
 *   7. Primary jumps to secondary. Secondary acks (0x03 =
 *      I_APPLICATION_STARTED).
 *
 * After step 7 the ECU runs MiniMon and speaks the command protocol in
 * `minimon.ts`.
 */
import { Buffer } from 'node:buffer';
import type { BootmodeTransport } from './transport.js';

export const MINIMON_LOADER_STARTED = 0x01;
export const MINIMON_APPLICATION_STARTED = 0x03;

export interface HandshakeOptions {
  /** Expected BSL identification byte (per-MCU). 0xC5 for C167CR (MS42/MS43). */
  expectedIdByte: number;
  /** Primary loader bytes (must be exactly 32). */
  primaryLoader: Buffer;
  /** Secondary loader bytes (typically Minimon, ~394 bytes for the K-line variant). */
  secondaryLoader: Buffer;
  /** Acknowledge byte expected after the primary takes over. Default 0x01. */
  primaryAck?: number;
  /** Acknowledge byte expected after the secondary takes over. Default 0x03. */
  secondaryAck?: number;
  /** Inter-byte sleep during loader upload, in milliseconds. 0 = none. */
  interByteDelayMs?: number;
  /** Read-timeout per byte in milliseconds. */
  byteTimeoutMs?: number;
  /** Optional progress callback (stage = primary/secondary, byte index). */
  onProgress?: (stage: 'primary' | 'secondary', byte: number, total: number) => void;
}

export class BootmodeHandshakeError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(`Bootmode handshake failed at stage "${stage}": ${message}`);
    this.name = 'BootmodeHandshakeError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function performHandshake(
  transport: BootmodeTransport,
  opts: HandshakeOptions,
): Promise<void> {
  if (opts.primaryLoader.length !== 32) {
    throw new BootmodeHandshakeError(
      `primary loader must be exactly 32 bytes (got ${opts.primaryLoader.length})`,
      'init',
    );
  }
  const primaryAck = opts.primaryAck ?? MINIMON_LOADER_STARTED;
  const secondaryAck = opts.secondaryAck ?? MINIMON_APPLICATION_STARTED;
  const byteTimeoutMs = opts.byteTimeoutMs ?? 200;
  const interByteDelayMs = opts.interByteDelayMs ?? 0;

  // Step 1-2: send auto-baud calibration byte.
  transport.flushInput();
  await transport.write(Buffer.from([0x00]));

  // Step 3: BSL identification byte. K-line is half-duplex so we may see
  // an echo of our 0x00 first; accept either [id] or [0x00, id].
  let idByte: number;
  try {
    const first = await transport.read(1, byteTimeoutMs * 5);
    if (first[0] === 0x00) {
      // half-duplex echo of the probe; read again for the real id
      const second = await transport.read(1, byteTimeoutMs * 5);
      idByte = second[0];
    } else {
      idByte = first[0];
    }
  } catch (err) {
    throw new BootmodeHandshakeError(
      `no response to BSL probe (BOOT pin not grounded? wrong K-line wiring? wrong baud rate?): ${(err as Error).message}`,
      'probe',
    );
  }
  if (idByte !== opts.expectedIdByte) {
    throw new BootmodeHandshakeError(
      `wrong BSL identification byte: expected 0x${opts.expectedIdByte
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()}, got 0x${idByte.toString(16).padStart(2, '0').toUpperCase()}`,
      'probe',
    );
  }

  // Step 4: upload primary loader byte-by-byte with echo verify.
  await uploadEchoed(transport, opts.primaryLoader, 'primary', interByteDelayMs, byteTimeoutMs, opts.onProgress);

  // Step 5: primary's "I_LOADER_STARTED" acknowledgement.
  const primaryAckByte = (await transport.read(1, byteTimeoutMs * 10))[0];
  if (primaryAckByte !== primaryAck) {
    throw new BootmodeHandshakeError(
      `primary loader did not start: expected 0x${primaryAck
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()}, got 0x${primaryAckByte.toString(16).padStart(2, '0').toUpperCase()}`,
      'primary-ack',
    );
  }

  // Step 6: upload secondary loader byte-by-byte with echo verify by the primary.
  await uploadEchoed(transport, opts.secondaryLoader, 'secondary', interByteDelayMs, byteTimeoutMs, opts.onProgress);

  // Step 7: secondary's "I_APPLICATION_STARTED" acknowledgement.
  const secondaryAckByte = (await transport.read(1, byteTimeoutMs * 20))[0];
  if (secondaryAckByte !== secondaryAck) {
    throw new BootmodeHandshakeError(
      `secondary loader did not start: expected 0x${secondaryAck
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()}, got 0x${secondaryAckByte.toString(16).padStart(2, '0').toUpperCase()}`,
      'secondary-ack',
    );
  }
}

async function uploadEchoed(
  transport: BootmodeTransport,
  data: Buffer,
  stage: 'primary' | 'secondary',
  interByteDelayMs: number,
  byteTimeoutMs: number,
  onProgress?: (stage: 'primary' | 'secondary', byte: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < data.length; i++) {
    await transport.write(data.subarray(i, i + 1));
    let echo: number;
    try {
      echo = (await transport.read(1, byteTimeoutMs))[0];
    } catch (err) {
      throw new BootmodeHandshakeError(
        `no echo for byte ${i}/${data.length} (TX=0x${data[i].toString(16).padStart(2, '0').toUpperCase()}): ${(err as Error).message}`,
        stage,
      );
    }
    if (echo !== data[i]) {
      throw new BootmodeHandshakeError(
        `echo mismatch at byte ${i}/${data.length}: TX=0x${data[i]
          .toString(16)
          .padStart(2, '0')
          .toUpperCase()}, echo=0x${echo.toString(16).padStart(2, '0').toUpperCase()}`,
        stage,
      );
    }
    if (onProgress) onProgress(stage, i + 1, data.length);
    if (interByteDelayMs > 0) await sleep(interByteDelayMs);
  }
}
