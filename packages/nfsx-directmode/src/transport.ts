/**
 * Direct-DS2 transport — drives the K-line wire directly via ediabasx's
 * `NodeSerialTransport` + `Ds2Session`, with an explicit `sendFastInit`
 * wake before the first DS2 transaction.
 *
 * Why not use `SerialInterface` instead? Its high-level `transmitData`
 * with a DS2-configured `setCommParameter` doesn't drive any K-line
 * wake — the wake normally happens implicitly via the SGBD's BEST2
 * `xinit` opcode, a path raw-DS2 callers bypass. Going one layer
 * deeper lets us control init + framing + DTR explicitly.
 *
 * Settings: 9600 8N1 (DS2 default for K+DCAN cables), DTR-toggled
 * direction control, adapter-echo consumption.
 */
import { Buffer } from 'node:buffer';
import {
  Ds2Session,
  sendFastInit,
  type Ds2SessionOptions,
} from '@emdzej/ediabasx-interface-serial';
import { NodeSerialTransport } from '@emdzej/ediabasx-interface-serial/node';

export interface DirectModeTransportConfig {
  /** Serial device path, e.g. `/dev/cu.usbserial-A50285BI`. */
  port: string;
  /** Baud rate (DS2 default 9600). */
  baudRate?: number;
  /** Data bits (default 8). */
  dataBits?: 7 | 8;
  /** Parity (DS2 over K+DCAN is `"none"` — 8N1). */
  parity?: 'none' | 'even' | 'odd';
  /** Stop bits (default 1). */
  stopBits?: 1 | 2;
  /** ParTimeoutStd in ms (default 5000). */
  timeoutStdMs?: number;
  /** ParRegenTime in ms (default 0). */
  regenTimeMs?: number;
  /** ParTimeoutTelEnd in ms (default 100). */
  telegramEndTimeoutMs?: number;
  /** ParInterbyteTime in ms (default 0). */
  interByteTimeMs?: number;
  /**
   * Skip the fast-init wake before the first transaction. Default
   * `false` — most K-line ECUs require fast-init to come out of sleep.
   * Set true only if you know the bus is already warm (e.g. just ran
   * EDIABAS against the same ECU).
   */
  skipWake?: boolean;
  /**
   * Whether the cable has its own echo loop. For raw FTDI K+DCAN
   * (level-shifter only, no smart adapter MCU) this is `true` —
   * bytes echo back via the K-line transceiver and the transport
   * must consume them. Default `true`.
   */
  hasAdapterEcho?: boolean;
  /**
   * Raise DTR during TX so the K-line transceiver switches direction.
   * Default = `hasAdapterEcho`. Set `false` for cables that don't
   * need direction control.
   */
  sendSetDtr?: boolean;
}

export class DirectModeTransport {
  private transport: NodeSerialTransport;
  private session: Ds2Session;
  private opened = false;
  private woken = false;
  private verbose = false;
  private config: Required<
    Pick<
      DirectModeTransportConfig,
      | 'port'
      | 'baudRate'
      | 'dataBits'
      | 'parity'
      | 'stopBits'
      | 'timeoutStdMs'
      | 'regenTimeMs'
      | 'telegramEndTimeoutMs'
      | 'interByteTimeMs'
      | 'skipWake'
      | 'hasAdapterEcho'
      | 'sendSetDtr'
    >
  >;

  constructor(config: DirectModeTransportConfig) {
    const hasAdapterEcho = config.hasAdapterEcho ?? true;
    this.config = {
      port: config.port,
      baudRate: config.baudRate ?? 9600,
      dataBits: config.dataBits ?? 8,
      // DS2 spec is 8E1 (even parity). Matches the wire format the ECU
      // expects on K-line — some cables work with 8N1 too, but EVEN is
      // the canonical setting.
      parity: config.parity ?? 'even',
      stopBits: config.stopBits ?? 1,
      timeoutStdMs: config.timeoutStdMs ?? 5000,
      regenTimeMs: config.regenTimeMs ?? 0,
      telegramEndTimeoutMs: config.telegramEndTimeoutMs ?? 300,
      interByteTimeMs: config.interByteTimeMs ?? 0,
      // Raw K+DCAN cable (FTDI + transceiver, no smart MCU) needs an
      // explicit fast-init break pulse to wake the ECU's K-line. J2534
      // boxes do this internally so the J2534 example skips it — we
      // can't. Set true only when chaining transactions on an already-warm
      // bus.
      skipWake: config.skipWake ?? false,
      hasAdapterEcho,
      sendSetDtr: config.sendSetDtr ?? hasAdapterEcho,
    };
    this.transport = new NodeSerialTransport();
    const verbose = process.env.NFSX_DS2_VERBOSE === '1';
    const logger: Ds2SessionOptions['logger'] | undefined = verbose
      ? (tag, message, data) => {
          const hex = data
            ? ' ' + Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join(' ')
            : '';
          process.stderr.write(`[ds2:${tag}] ${message}${hex}\n`);
        }
      : undefined;
    const sessionOptions: Ds2SessionOptions = {
      concept: 0x0006,
      baudRate: this.config.baudRate,
      timeoutStdMs: this.config.timeoutStdMs,
      regenTimeMs: this.config.regenTimeMs,
      telegramEndTimeoutMs: this.config.telegramEndTimeoutMs,
      interByteTimeMs:
        this.config.interByteTimeMs > 0 ? this.config.interByteTimeMs : undefined,
      sendSetDtr: this.config.sendSetDtr,
      hasAdapterEcho: this.config.hasAdapterEcho,
      logger,
    };
    this.session = new Ds2Session(sessionOptions);
    this.verbose = verbose;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.transport.configure({
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
    });
    await this.transport.open(this.config.port);
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    await this.transport.close();
    this.opened = false;
    this.woken = false;
  }

  /**
   * Drive the K-line fast-init wake pulse. Idempotent across the
   * lifetime of this transport — only runs once. Subsequent calls
   * are no-ops until `close()` resets the state.
   *
   * After the break-pulse, the ECU may emit a sync byte / key-byte
   * sequence (KWP2000 init). We drain any pending bytes opportunistically
   * — DS2 frames work fine even if the ECU only does the wake without
   * full KWP2000 setup.
   */
  async wake(): Promise<void> {
    if (this.woken || this.config.skipWake) {
      this.woken = true;
      if (this.verbose) process.stderr.write('[ds2:wake] skipped\n');
      return;
    }
    if (!this.opened) throw new Error('transport not open');
    if (this.verbose) process.stderr.write(`[ds2:wake] sendFastInit setDtr=${this.config.sendSetDtr}\n`);
    await sendFastInit(this.transport, { setDtr: this.config.sendSetDtr });
    try {
      const keyBytes = await this.transport.read(3, 200);
      if (this.verbose) {
        const hex = Array.from(keyBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        process.stderr.write(`[ds2:wake] keybytes (${keyBytes.length}): ${hex}\n`);
      }
    } catch (err) {
      if (this.verbose) process.stderr.write(`[ds2:wake] no keybytes: ${(err as Error).message}\n`);
    }
    this.woken = true;
  }

  /**
   * Send a DS2 request payload (`[ADDR] LEN [CMD …]` — no trailing
   * XOR, the session appends it) and return the full received frame.
   * Triggers `wake()` on the first call.
   */
  async transact(request: Buffer): Promise<Buffer> {
    if (!this.opened) throw new Error('transport not open');
    if (!this.woken) await this.wake();
    const response = await this.session.sendRequest(
      this.transport,
      new Uint8Array(request),
    );
    return Buffer.from(response);
  }

  /**
   * Reconfigure the local UART to a new baud rate. Caller is responsible
   * for issuing the DS2 baud-switch command beforehand and confirming
   * the ECU accepted it — this only flips the host's serial speed.
   *
   * Recreates the `Ds2Session` so its internal DTR-drain timing math
   * uses the new baud.
   */
  async reconfigureBaud(newBaud: number): Promise<void> {
    if (!this.opened) throw new Error('transport not open');
    this.config.baudRate = newBaud;
    await this.transport.configure({
      baudRate: newBaud,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
    });
    const verbose = process.env.NFSX_DS2_VERBOSE === '1';
    const logger: Ds2SessionOptions['logger'] | undefined = verbose
      ? (tag, message, data) => {
          const hex = data
            ? ' ' + Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join(' ')
            : '';
          process.stderr.write(`[ds2:${tag}] ${message}${hex}\n`);
        }
      : undefined;
    this.session = new Ds2Session({
      concept: 0x0006,
      baudRate: newBaud,
      timeoutStdMs: this.config.timeoutStdMs,
      regenTimeMs: this.config.regenTimeMs,
      telegramEndTimeoutMs: this.config.telegramEndTimeoutMs,
      interByteTimeMs:
        this.config.interByteTimeMs > 0 ? this.config.interByteTimeMs : undefined,
      sendSetDtr: this.config.sendSetDtr,
      hasAdapterEcho: this.config.hasAdapterEcho,
      logger,
    });
  }
}

/** Build a request payload (no XOR — Ds2Session adds it). */
export function buildRequestPayload(addr: number, payload: Buffer): Buffer {
  const total = payload.length + 3;
  if (total > 0xff) {
    throw new Error(
      `DS2 frame too large: payload ${payload.length} bytes → LEN ${total} exceeds 0xFF`,
    );
  }
  const buf = Buffer.alloc(total - 1);
  buf[0] = addr & 0xff;
  buf[1] = total;
  payload.copy(buf, 2);
  return buf;
}
