import { EmbeddedEdiabas, EdiabasClient } from "@emdzej/ediabasx-client";
import type { IEdiabas } from "@emdzej/ediabasx-core";
import {
  SerialInterface,
  WebSerialTransport,
  type WebSerialPortLike,
} from "@emdzej/ediabasx-interface-serial";
import { J2534Interface } from "@emdzej/ediabasx-interface-j2534";
import { WebSerialTransport as J2534WebSerialTransport } from "@emdzej/j2534-webserial";
import { GatewayClient } from "@emdzej/ediabasx-interfaces/client";
import { dial as dialConnect } from "@emdzej/swsrs-client";
import { makeBrowserSgbdResolver } from "./sgbd-resolver";
import { app } from "./state.svelte";

/**
 * One ECU session: a connected `IEdiabas` instance plus the teardown
 * thunk that closes whatever underlying transport / socket the
 * instance is using. Embedded mode wraps `EmbeddedEdiabas` (against
 * a local interface — Web Serial / J2534 / gateway); client mode
 * wraps `EdiabasClient` (JSON-RPC over WebSocket — direct or via the
 * Bimmerz Connect relay). Both implement IEdiabas, so the flash
 * runtime / cabi syscalls are mode-agnostic.
 */
export interface EdiabasSession {
  readonly ediabas: IEdiabas;
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
    if (app.config.mode === "client") {
      if (app.config.connectionMethod === "connect") {
        await connectBimmerzConnectImpl();
      } else {
        await connectServerImpl();
      }
      return;
    }

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
  const iface = new SerialInterface({
    port: "webserial",
    baudRate: s.baudRate ?? 115200,
    dataBits: (s.dataBits ?? 8) as 7 | 8,
    parity: (s.parity ?? "none") as "none" | "even" | "odd",
    stopBits: (s.stopBits ?? 1) as 1 | 2,
    timeoutMs: s.timeoutMs ?? 5000,
    transport: new WebSerialTransport(port),
    probeAdapterOnConnect: s.probeAdapterOnConnect ?? true,
  });

  await startEmbeddedSession(iface, async () => {
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
  const iface = new J2534Interface({
    transport: { kind: "instance", transport: j2534Transport },
    protocol: "ds2",
    baudRate: 9600,
  });
  await startEmbeddedSession(iface, async () => {
    /* J2534Interface.disconnect() via Ediabas.end() closes its
       transport; no extra cleanup. */
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
  const iface = new GatewayClient({ transport: "websocket", url });
  await startEmbeddedSession(iface, async () => {
    /* GatewayClient.disconnect() handled by Ediabas.end(). */
  }, `Gateway · ${url}`);
}

async function connectServerImpl(): Promise<void> {
  const url = app.config.serverUrl?.trim();
  if (!url) {
    throw new Error("Server URL is empty — set ws://host:port in Settings");
  }
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error("Server URL must start with ws:// or wss://");
  }
  const client = new EdiabasClient({ transport: "websocket", url });
  try {
    await client.init();
  } catch (err) {
    try {
      await client.end();
    } catch { /* swallow */ }
    throw err;
  }
  connection.session = {
    ediabas: client,
    disconnect: async () => {
      try {
        await client.end();
      } catch { /* swallow */ }
    },
  };
  connection.status = { kind: "connected", portInfo: `Server · ${url}` };
}

async function connectBimmerzConnectImpl(): Promise<void> {
  const sessionId = app.connectSessionId?.trim() ?? "";
  const token = app.connectToken?.trim() ?? "";
  if (!sessionId || !token) {
    /* No token paste yet — pop the dialog and bail. The dialog
       calls back into connect() once the user submits. */
    connection.status = { kind: "disconnected" };
    app.showConnectSession = true;
    return;
  }
  const relayUrl = app.config.connectRelayUrl?.trim() || "wss://connect.bimmerz.app";
  const peer = await dialConnect({ relayURL: relayUrl, sessionId, token });
  const client = new EdiabasClient({ transport: "websocket", socket: peer.socket });
  try {
    await client.init();
  } catch (err) {
    try {
      await client.end();
    } catch { /* swallow */ }
    throw err;
  }
  connection.session = {
    ediabas: client,
    disconnect: async () => {
      try {
        await client.end();
      } catch { /* swallow */ }
    },
  };
  connection.status = {
    kind: "connected",
    portInfo: `Bimmerz Connect · ${relayUrl}`,
  };
}

function portLabelFromWebSerial(port: WebSerialPortLike): string {
  const info =
    (port as unknown as { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }).getInfo?.() ?? {};
  return info.usbVendorId !== undefined
    ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`
    : "Serial port";
}

async function startEmbeddedSession(
  iface: ConstructorParameters<typeof EmbeddedEdiabas>[0]["interface"],
  closeTransport: () => Promise<void>,
  portInfo: string,
): Promise<void> {
  /* IEdiabas wraps the inner Ediabas; loadSgbdResolver reads SGBD
     bytes from the user-picked EDIABAS/Ecu folder so flash dispatches
     (FLASH_SCHREIBEN / status / etc.) actually resolve to bytes. */
  if (!app.install?.ediabasEcu) {
    throw new Error(
      "No EDIABAS/Ecu folder in the install — pick a BMW Standard Tools root that contains it.",
    );
  }
  const ediabas = new EmbeddedEdiabas({
    sgbdPath: ".",
    interface: iface,
    loadSgbdResolver: makeBrowserSgbdResolver(app.install.ediabasEcu),
  });
  try {
    await ediabas.init();
  } catch (err) {
    await closeTransport();
    throw err;
  }
  connection.session = {
    ediabas,
    disconnect: async () => {
      try {
        await ediabas.end();
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
  /* Bimmerz Connect tokens are transient — clear so a new
     session forces a fresh dialog (the relay host prints a new
     `sessionId.token` per session). */
  app.connectSessionId = null;
  app.connectToken = null;
}
