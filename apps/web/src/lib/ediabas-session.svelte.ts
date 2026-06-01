import { Ediabas, type EdiabasConfig } from "@emdzej/ediabasx-ediabas";
import {
  SerialInterface,
  WebSerialTransport,
  type WebSerialPortLike,
} from "@emdzej/ediabasx-interface-serial";
import { J2534Interface } from "@emdzej/ediabasx-interface-j2534";
import { WebSerialTransport as J2534WebSerialTransport } from "@emdzej/j2534-webserial";
import { GatewayClient } from "@emdzej/ediabasx-interfaces/client";
import { app } from "./state.svelte";

type AnyEdiabasTransport = EdiabasConfig["transport"];

export interface EdiabasSession {
  readonly ediabas: Ediabas;
  disconnect(): Promise<void>;
}

export type ConnectionStatus =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; portInfo: string }
  | { kind: "error"; message: string };

interface EdiabasSessionState {
  status: ConnectionStatus;
  session: EdiabasSession | null;
}

export const connection: EdiabasSessionState = $state({
  status: { kind: "disconnected" },
  session: null,
});

interface WebNavigatorSerial {
  requestPort(options?: {
    filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
  }): Promise<WebSerialPortLike>;
  getPorts(): Promise<WebSerialPortLike[]>;
}

function getNavigatorSerial(): WebNavigatorSerial | null {
  if (typeof navigator === "undefined") return null;
  const serial = (navigator as unknown as { serial?: WebNavigatorSerial }).serial;
  return serial ?? null;
}

export async function connect(): Promise<void> {
  connection.status = { kind: "connecting" };

  try {
    if (app.config.interface === "webserial") {
      await connectWebSerialImpl();
    } else if (app.config.interface === "j2534") {
      await connectJ2534Impl();
    } else if (app.config.interface === "gateway") {
      await connectGatewayImpl();
    } else {
      throw new Error(`Interface "${String(app.config.interface)}" not supported in the web app`);
    }
  } catch (err) {
    connection.status = {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function connectWebSerialImpl(): Promise<void> {
  const serial = getNavigatorSerial();
  if (!serial) {
    throw new Error("Web Serial unavailable — use Chrome / Edge / Opera over HTTPS or localhost.");
  }

  let port: WebSerialPortLike;
  try {
    port = await serial.requestPort();
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      connection.status = { kind: "disconnected" };
      return;
    }
    throw err;
  }

  const s = app.config.serial ?? {};
  const transport = new SerialInterface({
    port: "webserial",
    baudRate: s.baudRate ?? 115200,
    dataBits: (s.dataBits ?? 8) as 7 | 8,
    parity: (s.parity ?? "none") as "none" | "even" | "odd",
    stopBits: (s.stopBits ?? 1) as 1 | 2,
    timeoutMs: s.timeoutMs ?? 5000,
    transport: new WebSerialTransport(port),
    probeAdapterOnConnect: s.probeAdapterOnConnect ?? true,
  });

  await startSession(transport as unknown as AnyEdiabasTransport, async () => {
    try {
      await (port as unknown as { close?: () => Promise<void> }).close?.();
    } catch {
      /* swallow */
    }
  }, portLabelFromWebSerial(port));
}

async function connectJ2534Impl(): Promise<void> {
  if (typeof navigator === "undefined" || !("serial" in navigator)) {
    throw new Error("Web Serial API not available — needs Chrome / Edge / Opera on desktop");
  }
  const j2534Transport = new J2534WebSerialTransport();
  const transport = new J2534Interface({
    transport: { kind: "instance", transport: j2534Transport },
    protocol: "ds2",
    baudRate: 9600,
  });
  await startSession(transport as unknown as AnyEdiabasTransport, async () => {
  }, "J2534 (OpenPort 2.0)");
}

async function connectGatewayImpl(): Promise<void> {
  const url = app.config.gateway?.url?.trim();
  if (!url) {
    throw new Error("Gateway URL is empty — set ws://host:port in Settings");
  }
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error("Gateway URL must start with ws:// or wss://");
  }
  const client = new GatewayClient({ transport: "websocket", url });
  await startSession(client as unknown as AnyEdiabasTransport, async () => {
  }, `Gateway · ${url}`);
}

function portLabelFromWebSerial(port: WebSerialPortLike): string {
  const info =
    (port as unknown as { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }).getInfo?.() ?? {};
  return info.usbVendorId !== undefined
    ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`
    : "Serial port";
}

async function startSession(
  transport: AnyEdiabasTransport,
  closeTransport: () => Promise<void>,
  portInfo: string,
): Promise<void> {
  const ediabas = new Ediabas({
    ecuPath: ".",
    transport,
  });
  try {
    await ediabas.connect();
  } catch (err) {
    await closeTransport();
    throw err;
  }
  connection.session = {
    ediabas,
    disconnect: async () => {
      try {
        await ediabas.disconnect();
      } catch {
        /* swallow — best-effort */
      }
      await closeTransport();
    },
  };
  connection.status = { kind: "connected", portInfo };
}

export async function disconnect(): Promise<void> {
  if (connection.session) {
    await connection.session.disconnect();
  }
  connection.session = null;
  connection.status = { kind: "disconnected" };
}
