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

let activePort: WebSerialPortLike | null = null;
let activeTransport: WebDirectModeTransport | null = null;

class WebDirectModeTransport implements DirectModeTransport {
  private serial: WebSerialTransport;
  private session: Ds2Session;
  private woken = false;
  private sessionOpts: Ds2SessionOptions;

  constructor(port: WebSerialPortLike) {
    this.serial = new WebSerialTransport(port);
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
    await this.serial.open({
      baudRate: 9600,
      dataBits: 8,
      parity: "even",
      stopBits: 1,
    });
  }

  async close(): Promise<void> {
    await this.serial.close();
  }

  async wake(): Promise<void> {
    if (this.woken) return;
    await sendFastInit(this.serial as unknown as SerialTransport, { setDtr: true });
    try {
      await this.serial.read(3, 200);
    } catch {
      /* no keybytes — fine */
    }
    this.woken = true;
  }

  async transact(request: Uint8Array): Promise<Uint8Array> {
    if (!this.woken) await this.wake();
    return this.session.sendRequest(
      this.serial as unknown as SerialTransport,
      request,
    );
  }

  async reconfigureBaud(newBaud: number): Promise<void> {
    this.sessionOpts = { ...this.sessionOpts, baudRate: newBaud };
    this.session = new Ds2Session(this.sessionOpts);
    await this.serial.close();
    await this.serial.open({
      baudRate: newBaud,
      dataBits: 8,
      parity: "even",
      stopBits: 1,
    });
  }

  async setSessionTimeout(timeoutMs: number): Promise<void> {
    this.sessionOpts = { ...this.sessionOpts, timeoutStdMs: timeoutMs };
    this.session = new Ds2Session(this.sessionOpts);
  }
}

function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function isWebSerialSupported(): boolean {
  return isWebSerialAvailable();
}

export async function connectDirectmode(): Promise<void> {
  if (!isWebSerialAvailable()) {
    dm.status = { kind: "error", message: "Web Serial not available" };
    return;
  }
  dm.status = { kind: "connecting" };
  dm.lastError = null;
  try {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<WebSerialPortLike> } }).serial;
    const port = await serial.requestPort();
    const transport = new WebDirectModeTransport(port);
    await transport.open();
    activePort = port;
    activeTransport = transport;
    const info = (port as unknown as { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }).getInfo?.();
    const label = info?.usbVendorId !== undefined
      ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`
      : "K-line";
    dm.status = { kind: "connected", portInfo: label };
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      dm.status = { kind: "disconnected" };
      return;
    }
    dm.status = { kind: "error", message: (err as Error).message };
  }
}

export async function disconnectDirectmode(): Promise<void> {
  if (activeTransport) {
    try { await activeTransport.close(); } catch { /* best-effort */ }
    activeTransport = null;
  }
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
