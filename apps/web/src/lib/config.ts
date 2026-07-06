import { isEmbedded, embeddedEndpoints } from "./embedded";

export type InterfaceType = "webserial" | "j2534" | "gateway";
export type SerialProtocol = "uart" | "kwp" | "isotp" | "tp20";
export type SerialInitMode = "fast" | "five-baud";

/**
 * Top-level mode — embedded (local cable) vs client (remote
 * ediabasx-server, direct WebSocket or via Bimmerz Connect relay).
 * Mirrors inpax-web / ncsx-web naming so the shared
 * `@emdzej/ediabasx-web-ui` config panels bind directly.
 */
export type ConnectionMode = "embedded" | "client";
/** Client-mode method — direct WebSocket vs Bimmerz Connect relay. */
export type ClientConnectionMethod = "direct" | "connect";

export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "silent";

export const LOG_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
];

export interface WebLoggerConfig {
  level?: LogLevel;
  categories?: Record<string, LogLevel>;
}

export interface WebConfig {
  /** Top-level mode — embedded vs client. Defaults to `embedded`. */
  mode: ConnectionMode;
  /** Client-mode submode. */
  connectionMethod?: ClientConnectionMethod;
  /** Direct-WebSocket URL to an `ediabasx-server`. */
  serverUrl?: string;
  /** Bimmerz Connect relay URL — credential pasted at Connect time, not persisted. */
  connectRelayUrl?: string;

  /** Embedded mode: which local interface drives the cable. */
  interface: InterfaceType;
  serial?: {
    baudRate?: number;
    dataBits?: 7 | 8;
    parity?: "none" | "even" | "odd";
    stopBits?: 1 | 2;
    protocol?: SerialProtocol;
    initMode?: SerialInitMode;
    testerCanId?: string;
    ecuCanId?: string;
    timeoutMs?: number;
    probeAdapterOnConnect?: boolean;
  };
  gateway?: {
    url?: string;
  };
  logging?: WebLoggerConfig;
}

const STORAGE_KEY = "nfsx.web.config.v1";

const DEFAULT_CONFIG: WebConfig = {
  mode: "embedded",
  connectionMethod: "direct",
  serverUrl: "ws://localhost:6802",
  connectRelayUrl: "wss://connect.bimmerz.app",
  interface: "webserial",
  serial: {
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    protocol: "uart",
    initMode: "fast",
    timeoutMs: 5000,
    probeAdapterOnConnect: true,
  },
  gateway: {
    url: "ws://localhost:6801",
  },
  logging: {
    level: "info",
  },
};

/**
 * Connection fields the embedded build owns at compile/boot time —
 * the user shouldn't (and can't) change these on the dongle. Other
 * persisted preferences (logging, per-feature toggles) still flow
 * through the regular localStorage merge below.
 *
 * `serverUrl` is derived from `window.location.origin` so the same
 * embedded artefact works regardless of whether the dongle hosts
 * itself at `http://172.16.7.1`, a reverse-proxied host, or a future
 * IP the user routes to.
 */
function embeddedConnectionOverrides(): Pick<
  WebConfig,
  "mode" | "connectionMethod" | "serverUrl"
> {
  return {
    mode: "client",
    connectionMethod: "direct",
    serverUrl: embeddedEndpoints().serverWsUrl,
  };
}

export function loadConfig(): WebConfig {
  if (typeof localStorage === "undefined") {
    return isEmbedded
      ? { ...structuredClone(DEFAULT_CONFIG), ...embeddedConnectionOverrides() }
      : structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const base = !raw
      ? structuredClone(DEFAULT_CONFIG)
      : (() => {
          const parsed = JSON.parse(raw) as Partial<WebConfig>;
          const iface: InterfaceType =
            parsed.interface === "webserial" ||
            parsed.interface === "j2534" ||
            parsed.interface === "gateway"
              ? parsed.interface
              : DEFAULT_CONFIG.interface;
          const mode: ConnectionMode =
            parsed.mode === "embedded" || parsed.mode === "client"
              ? parsed.mode
              : DEFAULT_CONFIG.mode;
          const connectionMethod: ClientConnectionMethod =
            parsed.connectionMethod === "direct" || parsed.connectionMethod === "connect"
              ? parsed.connectionMethod
              : DEFAULT_CONFIG.connectionMethod!;
          return {
            ...structuredClone(DEFAULT_CONFIG),
            ...parsed,
            mode,
            connectionMethod,
            interface: iface,
            serial: { ...DEFAULT_CONFIG.serial, ...parsed.serial },
            gateway: { ...DEFAULT_CONFIG.gateway, ...parsed.gateway },
          };
        })();
    /* In embedded builds the connection fields are dongle-owned —
       the persisted mode/serverUrl/connectionMethod are stale junk
       (the dongle's IP/host can change between sessions). Override
       on every load; leave logging/etc. intact. */
    if (isEmbedded) {
      return { ...base, ...embeddedConnectionOverrides() };
    }
    return base;
  } catch {
    return isEmbedded
      ? { ...structuredClone(DEFAULT_CONFIG), ...embeddedConnectionOverrides() }
      : structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: WebConfig): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function resetConfig(): WebConfig {
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  return structuredClone(DEFAULT_CONFIG);
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function isSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}
