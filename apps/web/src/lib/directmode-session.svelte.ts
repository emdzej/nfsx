import {
  WebSerialTransport,
  Ds2Session,
  sendFastInit,
  type WebSerialPortLike,
  type Ds2SessionOptions,
  type SerialTransport,
} from "@emdzej/ediabasx-interface-serial";
import {
  probe,
  readFlash,
  writeFlash,
  type DirectModeTransport,
  type DirectModeProgress,
  type DirectModeProbeResult,
  type DirectModeWriteResult,
  type FlashMode,
} from "@emdzej/nfsx-directmode";
import { isEmbedded, embeddedEndpoints } from "./embedded";
import { RpcUartTransport, UartRevokedError } from "./rpc-uart-transport";

export type DmConnectionStatus =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; portInfo: string }
  | { kind: "error"; message: string };

interface DmSessionState {
  status: DmConnectionStatus;
  busy: boolean;
  progress: DirectModeProgress | null;
  probeResult: DirectModeProbeResult | null;
  lastError: string | null;
}

export const dm: DmSessionState = $state({
  status: { kind: "disconnected" },
  busy: false,
  progress: null,
  probeResult: null,
  lastError: null,
});

/**
 * Module-scope handles for the active transport chain. Both live
 * outside the reactive state — proxying a class instance breaks
 * `this` bindings inside its methods.
 *
 * `activePort` is only used on the Web Serial path (we hold it so
 * we can close it on disconnect); the dongle path leaves it null.
 */
let activePort: WebSerialPortLike | null = null;
let activeSerial: SerialTransport | null = null;
/* Typed as the concrete local class so `close()` is reachable —
   `DirectModeTransport` (the flash package's interface) is
   intentionally narrow (transact / reconfigureBaud /
   setSessionTimeout) and doesn't include a close hook. */
let activeTransport: Ds2DirectModeTransport | null = null;

/**
 * DS2-backed `DirectModeTransport` implementation. Takes a bare
 * `SerialTransport` and layers the DS2 session (framing + timing) on
 * top. Two callers today:
 *
 *   • Web Serial path — `WebSerialTransport` around a
 *     `navigator.serial.requestPort()`-selected FTDI K+DCAN cable.
 *   • Dongle path (embedded) — `RpcUartTransport` around the Bimmerz
 *     Box's `/rpc/uart/0` WebSocket.
 *
 * Both are constructed here so the mode-switching lives in
 * `connectDirectmode()` below rather than being pushed into the
 * transport class itself.
 */
class Ds2DirectModeTransport implements DirectModeTransport {
  private readonly serial: SerialTransport;
  private session: Ds2Session;
  private woken = false;
  private sessionOpts: Ds2SessionOptions;

  constructor(serial: SerialTransport) {
    this.serial = serial;
    this.sessionOpts = {
      concept: 0x0006,
      baudRate: 9600,
      timeoutStdMs: 5000,
      regenTimeMs: 0,
      telegramEndTimeoutMs: 300,
      sendSetDtr: true,
      hasAdapterEcho: true,
    };
    this.session = new Ds2Session(this.sessionOpts);
  }

  async open(): Promise<void> {
    /* ediabasx 0.7.x split open() from configure() — open() now
       takes only an optional port string (or none), and
       baudRate/dataBits/parity/stopBits land via `configure()`. On
       the RpcUart path `configure()` is baud+parity only (K-line is
       fixed 8-bit framing); the extra fields are inert there. */
    await this.serial.configure({
      baudRate: 9600,
      dataBits: 8,
      parity: "even",
      stopBits: 1,
    });
    /* SerialTransport.open() takes a required port-name argument that
       both concrete impls here (WebSerialTransport wrapping an
       already-picked port; RpcUartTransport bound to a fixed
       ws:// URL) ignore. Passing "" preserves the interface contract
       without introducing a new sentinel value. */
    await this.serial.open("");
  }

  async close(): Promise<void> {
    await this.serial.close();
  }

  async wake(): Promise<void> {
    if (this.woken) return;
    await sendFastInit(this.serial, { setDtr: true });
    try {
      await this.serial.read(3, 200);
    } catch {
      /* no keybytes — fine */
    }
    this.woken = true;
  }

  async transact(request: Uint8Array): Promise<Uint8Array> {
    if (!this.woken) await this.wake();
    return this.session.sendRequest(this.serial, request);
  }

  async reconfigureBaud(newBaud: number): Promise<void> {
    this.sessionOpts = { ...this.sessionOpts, baudRate: newBaud };
    this.session = new Ds2Session(this.sessionOpts);
    await this.serial.close();
    await this.serial.configure({
      baudRate: newBaud,
      dataBits: 8,
      parity: "even",
      stopBits: 1,
    });
    /* SerialTransport.open() takes a required port-name argument that
       both concrete impls here (WebSerialTransport wrapping an
       already-picked port; RpcUartTransport bound to a fixed
       ws:// URL) ignore. Passing "" preserves the interface contract
       without introducing a new sentinel value. */
    await this.serial.open("");
  }

  async setSessionTimeout(timeoutMs: number): Promise<void> {
    this.sessionOpts = { ...this.sessionOpts, timeoutStdMs: timeoutMs };
    this.session = new Ds2Session(this.sessionOpts);
  }
}

function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Whether the Connect K-line button will work in this build. The
 * embedded build talks to the dongle over WebSocket, so Web Serial
 * availability is irrelevant — always show the button as usable.
 */
export function isWebSerialSupported(): boolean {
  return isEmbedded || isWebSerialAvailable();
}

export async function connectDirectmode(): Promise<void> {
  dm.status = { kind: "connecting" };
  dm.lastError = null;

  try {
    if (isEmbedded) {
      /* Dongle path — build the byte-pipe against `/rpc/uart/0`.
         Exclusive: true because a stray dashboard tab issuing an
         ediabasx `job` would fight for the same physical wire. The
         firmware refuses the cooperative open in that case, which
         surfaces here as a rejected `uart.open`. */
      const { uartWsUrl } = embeddedEndpoints();
      const serial: SerialTransport = new RpcUartTransport({
        wsUrl: uartWsUrl,
        exclusive: true,
        /* DS2 expects to see the K-line echo on rx (hasAdapterEcho:
           true in the session opts); leave consumeEcho at its
           default false so the firmware forwards the echo bytes
           unchanged. */
        consumeEcho: false,
        onRevoked: (by) => {
          dm.status = { kind: "error", message: `K-line taken by ${by}` };
        },
      });
      const transport = new Ds2DirectModeTransport(serial);
      await transport.open();
      activeSerial = serial;
      activeTransport = transport;
      dm.status = { kind: "connected", portInfo: "dongle K-line" };
      return;
    }

    /* Browser path — pop the port picker and wrap the granted port
       in a WebSerialTransport. */
    if (!isWebSerialAvailable()) {
      dm.status = { kind: "error", message: "Web Serial not available" };
      return;
    }
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<WebSerialPortLike> } }).serial;
    const port = await serial.requestPort();
    const webTransport = new WebSerialTransport(port);
    const transport = new Ds2DirectModeTransport(webTransport);
    await transport.open();
    activePort = port;
    activeSerial = webTransport;
    activeTransport = transport;
    const info = (port as unknown as { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }).getInfo?.();
    const label = info?.usbVendorId !== undefined
      ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`
      : "K-line";
    dm.status = { kind: "connected", portInfo: label };
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      /* User cancelled the port picker — silent revert to idle. */
      dm.status = { kind: "disconnected" };
      return;
    }
    const message = err instanceof UartRevokedError
      ? `K-line revoked by ${err.by}`
      : (err as Error).message;
    dm.status = { kind: "error", message };
  }
}

export async function disconnectDirectmode(): Promise<void> {
  if (activeTransport) {
    try { await activeTransport.close(); } catch { /* best-effort */ }
    activeTransport = null;
  }
  /* Ds2DirectModeTransport.close() already closes the SerialTransport
     it wraps (both Web Serial and RpcUart do the right thing there);
     nulling here is enough. */
  activeSerial = null;
  if (activePort) {
    try { await (activePort as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* */ }
    activePort = null;
  }
  dm.status = { kind: "disconnected" };
  dm.probeResult = null;
  dm.progress = null;
}

function onProgress(p: DirectModeProgress): void {
  dm.progress = { ...p };
}

export async function probeEcu(): Promise<DirectModeProbeResult | null> {
  if (!activeTransport) return null;
  dm.busy = true;
  dm.lastError = null;
  dm.progress = null;
  try {
    const result = await probe({ iface: activeTransport }, onProgress);
    dm.probeResult = result;
    return result;
  } catch (err) {
    dm.lastError = (err as Error).message;
    return null;
  } finally {
    dm.busy = false;
  }
}

export async function readEcuFlash(
  mode: FlashMode,
  readBaud?: number,
): Promise<Uint8Array | null> {
  if (!activeTransport) return null;
  dm.busy = true;
  dm.lastError = null;
  dm.progress = null;
  try {
    const { image } = await readFlash(
      { iface: activeTransport },
      { mode, readBaud },
      onProgress,
    );
    return image;
  } catch (err) {
    dm.lastError = (err as Error).message;
    return null;
  } finally {
    dm.busy = false;
  }
}

export async function writeEcuFlash(
  image: Uint8Array,
  mode: FlashMode,
  opts?: { skipVerify?: boolean; writeBaud?: number },
): Promise<DirectModeWriteResult | null> {
  if (!activeTransport) return null;
  dm.busy = true;
  dm.lastError = null;
  dm.progress = null;
  try {
    const result = await writeFlash(
      image,
      { iface: activeTransport },
      { mode, skipVerify: opts?.skipVerify, writeBaud: opts?.writeBaud },
      onProgress,
    );
    return result;
  } catch (err) {
    dm.lastError = (err as Error).message;
    return null;
  } finally {
    dm.busy = false;
  }
}
