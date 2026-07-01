/**
 * Node.js `BootmodeTransport` implementation over `serialport`.
 *
 * Kept in its own file so the browser code path (which imports
 * `transport-interface.ts` directly) never pulls in `node:buffer` or
 * `serialport`. Vite won't try to bundle those dependencies for the
 * browser build — they only reach the bundler via the Node subpath
 * entry (`@emdzej/nfsx-bootmode/node`).
 */
import { Buffer } from 'node:buffer';
import { SerialPort } from 'serialport';
import type {
  BootmodeTransport,
  BootmodeTransportConfig,
} from './transport-interface.js';

interface PendingRead {
  count: number;
  collected: number[];
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NodeBootmodeTransport implements BootmodeTransport {
  private port: SerialPort | null = null;
  private buffer: number[] = [];
  private pending: PendingRead | null = null;
  private readonly config: BootmodeTransportConfig;
  private readonly hasAdapterEcho: boolean;
  private readonly echoTimeoutMs: number;

  constructor(config: BootmodeTransportConfig) {
    if (!config.device) {
      throw new Error('NodeBootmodeTransport requires `device` in config');
    }
    this.config = config;
    this.hasAdapterEcho = config.hasAdapterEcho ?? true;
    this.echoTimeoutMs = config.echoTimeoutMs ?? 250;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.config.device!,
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
        for (let i = 0; i < chunk.length; i++) this.buffer.push(chunk[i]!);
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

  async write(data: Uint8Array): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      throw new Error('transport not open');
    }
    // `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)` wraps the
    // same memory — no copy — and satisfies serialport's Buffer arg.
    const nodeBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await new Promise<void>((resolve, reject) => {
      this.port!.write(nodeBuf, (err) => {
        if (err) return reject(err);
        this.port!.drain((drainErr) => {
          if (drainErr) reject(drainErr);
          else resolve();
        });
      });
    });
    if (this.hasAdapterEcho && data.length > 0) {
      const echo = await this.read(
        data.length,
        this.echoTimeoutMs + data.length, // small per-byte slack
      );
      for (let i = 0; i < data.length; i++) {
        if (echo[i] !== data[i]) {
          throw new Error(
            `echo mismatch at byte ${i}/${data.length}: TX=0x${data[i]!
              .toString(16)
              .padStart(2, '0')
              .toUpperCase()}, echo=0x${echo[i]!
              .toString(16)
              .padStart(2, '0')
              .toUpperCase()}`,
          );
        }
      }
    }
  }

  read(count: number, timeoutMs?: number): Promise<Uint8Array> {
    if (count <= 0) return Promise.resolve(new Uint8Array(0));
    if (this.pending) {
      return Promise.reject(new Error('read already in flight'));
    }
    const effectiveTimeout = timeoutMs ?? this.config.defaultTimeoutMs;
    return new Promise<Uint8Array>((resolve, reject) => {
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
      p.resolve(new Uint8Array(p.collected));
    }
  }
}
