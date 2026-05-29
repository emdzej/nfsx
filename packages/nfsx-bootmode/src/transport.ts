/**
 * Serial transport for bootmode flashing.
 *
 * Bootmode uses 8N1 (vs DS2's 8E1) at a user-chosen baud rate. The C167
 * BSL auto-bauds off the first 0x00 byte, so any rate the cable supports
 * is fine. After the handshake, byte-by-byte echo verification is the
 * caller's responsibility — this layer just delivers raw bytes.
 */
import { Buffer } from 'node:buffer';
import { SerialPort } from 'serialport';

export interface BootmodeTransportConfig {
  device: string;
  baud: number;
  /** Default read-timeout per request, in milliseconds. */
  defaultTimeoutMs: number;
}

export interface BootmodeTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Write all bytes; resolves after the OS has accepted them. */
  write(data: Buffer): Promise<void>;
  /** Wait until exactly `count` bytes have arrived, or timeout. */
  read(count: number, timeoutMs?: number): Promise<Buffer>;
  /** Drop any unread bytes from the input buffer. */
  flushInput(): void;
}

interface PendingRead {
  count: number;
  collected: number[];
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NodeBootmodeTransport implements BootmodeTransport {
  private port: SerialPort | null = null;
  private buffer: number[] = [];
  private pending: PendingRead | null = null;
  private readonly config: BootmodeTransportConfig;

  constructor(config: BootmodeTransportConfig) {
    this.config = config;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.config.device,
          baudRate: this.config.baud,
          dataBits: 8,
          parity: 'none',
          stopBits: 1,
          rtscts: false,
          xon: false,
          xoff: false,
          autoOpen: false,
        },
        (err) => {
          if (err) reject(err);
        },
      );
      port.on('data', (chunk: Buffer) => {
        for (let i = 0; i < chunk.length; i++) this.buffer.push(chunk[i]);
        this.serviceRead();
      });
      port.on('error', (err) => {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          p.reject(err);
        }
      });
      port.open((err) => {
        if (err) return reject(err);
        this.port = port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.port || !this.port.isOpen) return resolve();
      this.port.close(() => resolve());
    });
  }

  write(data: Buffer): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      return Promise.reject(new Error('transport not open'));
    }
    return new Promise((resolve, reject) => {
      this.port!.write(data, (err) => {
        if (err) return reject(err);
        this.port!.drain((drainErr) => {
          if (drainErr) reject(drainErr);
          else resolve();
        });
      });
    });
  }

  read(count: number, timeoutMs?: number): Promise<Buffer> {
    if (count <= 0) return Promise.resolve(Buffer.alloc(0));
    if (this.pending) {
      return Promise.reject(new Error('read already in flight'));
    }
    const effectiveTimeout = timeoutMs ?? this.config.defaultTimeoutMs;
    return new Promise<Buffer>((resolve, reject) => {
      const pending: PendingRead = {
        count,
        collected: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          const p = this.pending;
          if (!p) return;
          this.pending = null;
          reject(
            new Error(
              `serial read timeout: wanted ${count}, got ${p.collected.length} in ${effectiveTimeout} ms`,
            ),
          );
        }, effectiveTimeout),
      };
      this.pending = pending;
      this.serviceRead();
    });
  }

  flushInput(): void {
    this.buffer = [];
  }

  private serviceRead(): void {
    const p = this.pending;
    if (!p) return;
    while (p.collected.length < p.count && this.buffer.length > 0) {
      p.collected.push(this.buffer.shift()!);
    }
    if (p.collected.length >= p.count) {
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(Buffer.from(p.collected));
    }
  }
}

/**
 * In-memory transport for tests. Pre-load `setExpected` with the bytes the
 * fake ECU will respond, then drive your higher-level protocol code as
 * usual. `writtenBytes` records everything the host sent.
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
  async write(data: Buffer): Promise<void> {
    if (!this.open_) throw new Error('mock transport not open');
    for (let i = 0; i < data.length; i++) this.writtenBytes.push(data[i]);
  }
  async read(count: number): Promise<Buffer> {
    if (!this.open_) throw new Error('mock transport not open');
    if (this.pendingResponse.length < count) {
      throw new Error(
        `mock transport underflow: wanted ${count}, only ${this.pendingResponse.length} queued`,
      );
    }
    const out = this.pendingResponse.splice(0, count);
    return Buffer.from(out);
  }
  flushInput(): void {
    this.pendingResponse = [];
  }
  /** Enqueue bytes the next read() calls will return. */
  enqueueResponse(bytes: number[] | Buffer): void {
    const arr = Buffer.isBuffer(bytes) ? [...bytes] : bytes;
    this.pendingResponse.push(...arr);
  }
}
