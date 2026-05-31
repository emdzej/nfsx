/**
 * DS2 framing primitives.
 *
 * Frame on the wire:
 *   [ADDR] [LEN] [CMD…] [XOR]
 *
 * Cross-checked against the EdiabasLib K-line reference implementation
 * (`ediabasx/packages/interface-serial/src/kdcan/ds2.ts`):
 *
 * - **LEN = total frame length on the wire**, i.e. ADDR + LEN + payload +
 *   XOR = `payload.length + 3`.
 * - **XOR is over the entire frame from offset 0 (ADDR) through the last
 *   payload byte**, NOT including the XOR position itself.
 *
 * (NOTE: this disagrees with the description in `docs/raw-ds2-flashing.md`
 * §1.2 / §6 gotcha #1 — those state ADDR is excluded. The doc is wrong;
 * the code here matches what real ECUs actually accept.)
 *
 * Half-duplex K-line: every TX byte echoes back. The transport must
 * consume the echo before reading the response.
 */
import { Buffer } from 'node:buffer';

export interface Ds2Frame {
  addr: number;
  /** Command bytes only — without ADDR, LEN, or XOR. */
  data: Buffer;
}

/** XOR all bytes in `buf` from offset 0 through `length-1`. */
export function calcXor(buf: Buffer, length: number = buf.length): number {
  let x = 0;
  for (let i = 0; i < length; i++) x ^= buf[i];
  return x & 0xff;
}

/**
 * Build the on-wire bytes for a DS2 frame given the target address and
 * the command payload. The payload is the bytes after LEN and before
 * XOR — i.e. CMD + any data bytes.
 */
export function encodeFrame(addr: number, payload: Buffer): Buffer {
  // Total frame = ADDR + LEN + payload + XOR = payload.length + 3
  const total = payload.length + 3;
  if (total > 0xff) {
    throw new Error(
      `DS2 frame too large: payload ${payload.length} bytes → LEN ${total} exceeds 0xFF`,
    );
  }
  const buf = Buffer.alloc(total);
  buf[0] = addr & 0xff;
  buf[1] = total;
  payload.copy(buf, 2);
  buf[total - 1] = calcXor(buf, total - 1);
  return buf;
}

/**
 * Parse a complete DS2 frame from `buf`. The frame is expected to start
 * at offset 0. Returns the parsed frame and the consumed-byte count.
 *
 * Throws on short frames, bad XOR, or LEN that disagrees with the
 * available bytes.
 */
export function decodeFrame(buf: Buffer): { frame: Ds2Frame; consumed: number } {
  if (buf.length < 4) {
    throw new Ds2FrameError(`frame too short: ${buf.length} bytes`);
  }
  const addr = buf[0];
  const total = buf[1];
  if (total < 4) {
    throw new Ds2FrameError(`impossible LEN=${total}`);
  }
  if (buf.length < total) {
    throw new Ds2FrameError(
      `buffer too short for LEN=${total}: have ${buf.length}, need ${total}`,
    );
  }
  const payload = buf.subarray(2, total - 1);
  const xor = buf[total - 1];
  const computed = calcXor(buf, total - 1);
  if (computed !== xor) {
    throw new Ds2FrameError(
      `XOR mismatch: computed 0x${computed.toString(16).padStart(2, '0')}, declared 0x${xor.toString(16).padStart(2, '0')}`,
    );
  }
  return {
    frame: { addr, data: Buffer.from(payload) },
    consumed: total,
  };
}

export class Ds2FrameError extends Error {
  constructor(message: string) {
    super(`DS2 frame error: ${message}`);
    this.name = 'Ds2FrameError';
  }
}

/** Status byte semantics per `docs/raw-ds2-flashing.md` §1.6. */
export const DS2_STATUS_OK = 0xa0;
export const DS2_STATUS_PENDING = 0xa1;
export const DS2_STATUS_TRANSPORT_ERR = 0xb0;
export const DS2_STATUS_FRAMING_ERR = 0xc0;

/** Command bytes per `docs/raw-ds2-flashing.md` §2-§3. */
export const DS2_CMD_IDENT = 0x00;
export const DS2_CMD_MEMORY_READ = 0x06;
/**
 * `0x0d` — hardware-reference / extended-identification query. Response
 * is ≥60 bytes. Bytes 57-59 of the response frame are a 3-byte memory
 * address pointer to an 8-byte ASCII variant ID (read via cmd 0x06).
 * The 8-byte ID's first 6 chars are the protocol-class dispatch key
 * (e.g. "111011" = MS42, "111430" = MS43). Sequence verified against
 * the upstream detection routine.
 */
export const DS2_CMD_HW_REF = 0x0d;
export const DS2_CMD_SEED_KEY = 0x90;
/** Programming commands: the second byte selects the sub-operation. */
export const DS2_CMD_PROG_PREFIX = 0x07;
export const DS2_PROG_WRITE = 0x02;
export const DS2_PROG_ERASE = 0x06;
export const DS2_PROG_VERIFY = 0x0f;
