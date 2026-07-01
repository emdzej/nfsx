/**
 * Serial transport contract for bootmode flashing — browser-safe.
 *
 * Concrete implementations live elsewhere:
 *
 *   `node-transport.ts`  — `NodeBootmodeTransport` (Node.js + serialport)
 *   host apps (e.g. `apps/web/src/lib/bootmode-transport.ts`) — Web Serial-backed
 *
 * Bootmode uses 8N1 (vs DS2's 8E1) at a user-chosen baud rate. The C167
 * BSL auto-bauds off the first 0x00 byte, so any rate the cable
 * supports is fine. After the handshake, byte-by-byte echo verification
 * is the caller's responsibility — this layer just delivers raw bytes.
 */

export interface BootmodeTransportConfig {
  /**
   * Node-only: serial device path. Ignored by browser implementations
   * which pick a port via `navigator.serial.requestPort()`.
   */
  device?: string;
  /** Baud rate for the underlying serial link. */
  baud: number;
  /** Default read-timeout per request, in milliseconds. */
  defaultTimeoutMs: number;
  /**
   * If true, every `write()` automatically reads back the same number
   * of bytes and verifies them as echo. Required for raw K-line cables
   * (FTDI K+DCAN) whose transceiver loops every TX byte back to RX.
   * Default: true.
   */
  hasAdapterEcho?: boolean;
  /** Per-byte echo read timeout (ms). Default: 250. */
  echoTimeoutMs?: number;
}

export interface BootmodeTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Write all bytes; resolves after the OS has accepted them. */
  write(data: Uint8Array): Promise<void>;
  /** Wait until exactly `count` bytes have arrived, or timeout. */
  read(count: number, timeoutMs?: number): Promise<Uint8Array>;
  /** Drop any unread bytes from the input buffer. */
  flushInput(): void;
}

/**
 * In-memory transport for tests. Pre-load `enqueueResponse` with the
 * bytes the fake ECU will respond, then drive your higher-level protocol
 * code as usual. `writtenBytes` records everything the host sent.
 */
export class MockBootmodeTransport implements BootmodeTransport {
  public writtenBytes: number[] = [];
  private pendingResponse: number[] = [];
  private open_ = false;

  async open(): Promise<void> {
    this.open_ = true;
  }
  async close(): Promise<void> {
    this.open_ = false;
  }
  async write(data: Uint8Array): Promise<void> {
    if (!this.open_) throw new Error('mock transport not open');
    for (let i = 0; i < data.length; i++) this.writtenBytes.push(data[i]!);
  }
  async read(count: number): Promise<Uint8Array> {
    if (!this.open_) throw new Error('mock transport not open');
    if (this.pendingResponse.length < count) {
      throw new Error(
        `mock transport underflow: wanted ${count}, only ${this.pendingResponse.length} queued`,
      );
    }
    const out = this.pendingResponse.splice(0, count);
    return new Uint8Array(out);
  }
  flushInput(): void {
    this.pendingResponse = [];
  }
  /** Enqueue bytes the next read() calls will return. */
  enqueueResponse(bytes: number[] | Uint8Array): void {
    const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
    this.pendingResponse.push(...arr);
  }
}
