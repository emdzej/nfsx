/**
 * `WebBootmodeTransport` — Web Serial-backed `BootmodeTransport`.
 *
 * Bootmode is 8N1 at a user-chosen baud, with the C167 BSL auto-bauding
 * off the first 0x00 byte. K-line cables (FTDI K+DCAN and friends)
 * echo every TX byte back on RX, so every write is followed by an
 * echo-verify read.
 *
 * The transport keeps its own byte-level receive buffer fed by a
 * background reader task, mirroring the `NodeBootmodeTransport` shape.
 * `flushInput()` drops any bytes queued in that buffer. `read(n, t)`
 * waits until either `n` bytes have arrived or `t` ms elapse.
 */

import type { BootmodeTransport } from "@emdzej/nfsx-bootmode";

/** Web Serial port shape — matches `navigator.serial.requestPort()` return. */
interface WebSerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: {
    baudRate: number;
    dataBits?: 7 | 8;
    parity?: "none" | "even" | "odd";
    stopBits?: 1 | 2;
    bufferSize?: number;
    flowControl?: "none" | "hardware";
  }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export interface WebBootmodeTransportOptions {
  baudRate: number;
  /** Default read-timeout per request (ms). */
  defaultTimeoutMs?: number;
  /** Whether the cable loops TX bytes back on RX. Default: true. */
  hasAdapterEcho?: boolean;
  /** Echo-verify read timeout (ms). Default: 250. */
  echoTimeoutMs?: number;
}

interface PendingRead {
  count: number;
  collected: number[];
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebBootmodeTransport implements BootmodeTransport {
  private readonly port: WebSerialPortLike;
  private readonly baudRate: number;
  private readonly defaultTimeoutMs: number;
  private readonly hasAdapterEcho: boolean;
  private readonly echoTimeoutMs: number;

  private rxBuffer: number[] = [];
  private pending: PendingRead | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readerAborted = false;
  private readerLoop: Promise<void> | null = null;
  private opened = false;

  constructor(port: WebSerialPortLike, opts: WebBootmodeTransportOptions) {
    this.port = port;
    this.baudRate = opts.baudRate;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 5000;
    this.hasAdapterEcho = opts.hasAdapterEcho ?? true;
    this.echoTimeoutMs = opts.echoTimeoutMs ?? 250;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
    });
    this.opened = true;
    this.readerAborted = false;
    this.startReaderLoop();
  }

  async close(): Promise<void> {
    this.readerAborted = true;
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch { /* best effort */ }
      try {
        this.reader.releaseLock();
      } catch { /* */ }
      this.reader = null;
    }
    if (this.readerLoop) {
      await this.readerLoop.catch(() => {});
      this.readerLoop = null;
    }
    if (this.writer) {
      try {
        await this.writer.close();
      } catch { /* */ }
      try {
        this.writer.releaseLock();
      } catch { /* */ }
      this.writer = null;
    }
    if (this.opened) {
      try {
        await this.port.close();
      } catch { /* */ }
      this.opened = false;
    }
    // Reject any in-flight read so the caller doesn't hang.
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new Error("transport closed"));
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error("transport not open");
    if (!this.port.writable) throw new Error("port not writable");
    if (!this.writer) this.writer = this.port.writable.getWriter();
    await this.writer.ready;
    // Copy — Chrome's Web Serial writer detaches the underlying buffer,
    // which invalidates any caller-held view over the same memory.
    const copy = new Uint8Array(data.length);
    copy.set(data);
    await this.writer.write(copy);
    if (this.hasAdapterEcho && data.length > 0) {
      const echo = await this.read(data.length, this.echoTimeoutMs + data.length);
      for (let i = 0; i < data.length; i++) {
        if (echo[i] !== data[i]) {
          throw new Error(
            `echo mismatch at byte ${i}/${data.length}: TX=0x${data[i]!
              .toString(16)
              .padStart(2, "0")
              .toUpperCase()}, echo=0x${echo[i]!
              .toString(16)
              .padStart(2, "0")
              .toUpperCase()}`,
          );
        }
      }
    }
  }

  read(count: number, timeoutMs?: number): Promise<Uint8Array> {
    if (count <= 0) return Promise.resolve(new Uint8Array(0));
    if (this.pending) return Promise.reject(new Error("read already in flight"));
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
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
    this.rxBuffer = [];
  }

  private startReaderLoop(): void {
    if (!this.port.readable) throw new Error("port not readable");
    this.reader = this.port.readable.getReader();
    this.readerLoop = (async () => {
      const reader = this.reader;
      if (!reader) return;
      while (!this.readerAborted) {
        try {
          const { value, done } = await reader.read();
          if (done) return;
          if (value && value.length > 0) {
            for (let i = 0; i < value.length; i++) this.rxBuffer.push(value[i]!);
            this.serviceRead();
          }
        } catch {
          // reader cancelled or port closed; end the loop.
          return;
        }
      }
    })();
  }

  private serviceRead(): void {
    const p = this.pending;
    if (!p) return;
    while (p.collected.length < p.count && this.rxBuffer.length > 0) {
      p.collected.push(this.rxBuffer.shift()!);
    }
    if (p.collected.length >= p.count) {
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(new Uint8Array(p.collected));
    }
  }
}
