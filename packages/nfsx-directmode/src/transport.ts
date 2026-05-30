/**
 * Serial transport for direct DS2 flashing.
 *
 * DS2 line settings: 9600 8E1 (even parity, 1 stop), no flow control.
 * Half-duplex K-line: every TX byte echoes back. The transport consumes
 * the echo by reading-back-and-comparing after every write — any
 * mismatch aborts as a wire-level error.
 */
import { Buffer } from 'node:buffer';
import { SerialPort } from 'serialport';

export interface DirectModeTransportConfig {
  device: string;
  /** Baud rate. DS2 default is 9600; higher rates are negotiated via the §1.3 baud-switch. */
  baud: number;
  /** Default read timeout per request, in milliseconds. */
  defaultTimeoutMs: number;
}

export interface DirectModeTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * Write `data` then read back exactly `data.length` echo bytes and
   * verify they match TX byte-for-byte. Throws on mismatch.
   */
  writeWithEcho(data: Buffer, echoTimeoutMs?: number): Promise<void>;
  /** Wait for exactly `count` bytes from the ECU. */
  read(count: number, timeoutMs?: number): Promise<Buffer>;
  flushInput(): void;
}

export class DirectModeTransportError extends Error {
  constructor(message: string) {
    super(`DS2 transport: ${message}`);
    this.name = 'DirectModeTransportError';
  }
}

interface PendingRead {
  count: number;
  collected: number[];
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NodeDirectModeTransport implements DirectModeTransport {
  private port: SerialPort | null = null;
  private buffer: number[] = [];
  private pending: PendingRead | null = null;
  private readonly config: DirectModeTransportConfig;

  constructor(config: DirectModeTransportConfig) {
    this.config = config;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.config.device,
          baudRate: this.config.baud,
          dataBits: 8,
          parity: 'even', // DS2 = 8E1
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

  async writeWithEcho(data: Buffer, echoTimeoutMs?: number): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      throw new DirectModeTransportError('not open');
    }
    await new Promise<void>((resolve, reject) => {
      this.port!.write(data, (err) => {
        if (err) return reject(err);
        this.port!.drain((drainErr) => {
          if (drainErr) reject(drainErr);
          else resolve();
        });
      });
    });
    const echo = await this.read(data.length, echoTimeoutMs ?? 250);
    for (let i = 0; i < data.length; i++) {
      if (echo[i] !== data[i]) {
        throw new DirectModeTransportError(
          `echo mismatch at byte ${i}: TX=0x${data[i].toString(16).padStart(2, '0')}, RX=0x${echo[i].toString(16).padStart(2, '0')}`,
        );
      }
    }
  }

  read(count: number, timeoutMs?: number): Promise<Buffer> {
    if (count <= 0) return Promise.resolve(Buffer.alloc(0));
    if (this.pending) {
      return Promise.reject(new DirectModeTransportError('read already in flight'));
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
            new DirectModeTransportError(
              `read timeout: wanted ${count}, got ${p.collected.length} in ${effectiveTimeout} ms`,
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

/** In-memory transport for tests. Identical surface to NodeDirectModeTransport. */
export class MockDirectModeTransport implements DirectModeTransport {
  public writtenBytes: number[] = [];
  private pendingResponse: number[] = [];
  private open_ = false;

  async open(): Promise<void> {
    this.open_ = true;
  }
  async close(): Promise<void> {
    this.open_ = false;
  }
  async writeWithEcho(data: Buffer): Promise<void> {
    if (!this.open_) throw new DirectModeTransportError('mock not open');
    for (let i = 0; i < data.length; i++) this.writtenBytes.push(data[i]);
    // Mock auto-echoes by consuming our own TX from the input queue: the
    // test rig should prefix the response with the expected echo, or
    // call `enqueueEcho(data)` separately.
  }
  async read(count: number): Promise<Buffer> {
    if (!this.open_) throw new DirectModeTransportError('mock not open');
    if (this.pendingResponse.length < count) {
      throw new DirectModeTransportError(
        `mock underflow: wanted ${count}, only ${this.pendingResponse.length} queued`,
      );
    }
    return Buffer.from(this.pendingResponse.splice(0, count));
  }
  flushInput(): void {
    this.pendingResponse = [];
  }
  enqueueResponse(bytes: number[] | Buffer): void {
    const arr = Buffer.isBuffer(bytes) ? [...bytes] : bytes;
    this.pendingResponse.push(...arr);
  }
}
