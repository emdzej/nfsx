/**
 * Svelte 5 session state module for bootmode.
 *
 * Mirrors the shape of `directmode-session.svelte.ts`:
 *
 *   - `bm` is a `$state` object holding connection status, progress,
 *     last error, plus the last integrity report so the view can
 *     render pass/fail per blob.
 *   - `connectBootmode()` / `disconnectBootmode()` manage the Web
 *     Serial port + `WebBootmodeTransport` lifecycle.
 *   - `probeBootmodeSession()` / `readBootmodeFlash()` /
 *     `writeBootmodeFlash()` wrap the package's transport-injected
 *     session functions.
 *   - `verifyBundleIntegrityWeb()` runs the SHA-256 integrity check
 *     without needing a connected ECU (safe anytime).
 */
import {
  probeBootmode as pkgProbe,
  readFullFlash as pkgReadFullFlash,
  writeFullFlash as pkgWriteFullFlash,
  type BootmodeProgress,
  type BootmodeSessionConfig,
  type BootmodeTransport,
  type BundleLoader,
  type IntegrityReport,
} from "@emdzej/nfsx-bootmode";
import { WebBootmodeTransport } from "./bootmode-transport";
import { createWebBundleLoader } from "./bootmode-bundle-loader";
import { isEmbedded, embeddedEndpoints } from "./embedded";
import { RpcUartTransport, UartRevokedError } from "./rpc-uart-transport";

export type BmConnectionStatus =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; portInfo: string; baud: number }
  | { kind: "error"; message: string };

interface BmSessionState {
  status: BmConnectionStatus;
  busy: boolean;
  progress: BootmodeProgress | null;
  lastError: string | null;
  /** Result of the most recent bundle integrity check (via probe/read/write or `verifyBundleIntegrityWeb`). */
  lastIntegrityReport: IntegrityReport | null;
}

export const bm: BmSessionState = $state({
  status: { kind: "disconnected" },
  busy: false,
  progress: null,
  lastError: null,
  lastIntegrityReport: null,
});

// Module-level (not part of state) — the active transport instance
// and the bundle loader. Neither is reactive. `activeTransport` is
// typed against the shared `BootmodeTransport` interface so either
// the Web Serial-backed `WebBootmodeTransport` or the dongle-path
// `RpcBootmodeTransport` adapter can live here interchangeably.
let activeTransport: BootmodeTransport | null = null;
let activeRpc: RpcUartTransport | null = null;
let bundleLoader: BundleLoader = createWebBundleLoader();

/**
 * Thin `BootmodeTransport` adapter around `RpcUartTransport`. The
 * dongle firmware strips the K-line half-duplex echo server-side
 * (via `consumeEcho: true` at open time), so the BSL layer sees
 * only response bytes — no echo-verify needed here. Handles the
 * timeout-argument mismatch: `BootmodeTransport.read` allows an
 * optional `timeoutMs`, `RpcUartTransport.read` requires it; we
 * fall back to a large default when the caller omits it.
 */
class RpcBootmodeTransport implements BootmodeTransport {
  constructor(private readonly rpc: RpcUartTransport, private readonly defaultTimeoutMs = 5000) {}

  async open(): Promise<void> {
    await this.rpc.open();
  }

  async close(): Promise<void> {
    await this.rpc.close();
  }

  async write(data: Uint8Array): Promise<void> {
    await this.rpc.write(data);
  }

  async read(count: number, timeoutMs?: number): Promise<Uint8Array> {
    return this.rpc.read(count, timeoutMs ?? this.defaultTimeoutMs);
  }

  flushInput(): void {
    this.rpc.flushInput();
  }
}

/**
 * Rebuild the bundle loader. Only useful for tests; the default
 * loader is idempotent and cached across calls.
 */
export function setBundleLoader(loader: BundleLoader): void {
  bundleLoader = loader;
}

function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Whether the Connect K-line button will work in this build. The
 * embedded build talks to the dongle over WebSocket instead of Web
 * Serial, so the browser API is irrelevant — always show the button
 * as usable there.
 */
export function isWebSerialSupported(): boolean {
  return isEmbedded || isWebSerialAvailable();
}

// ── connection lifecycle ───────────────────────────────────────────

export interface ConnectBootmodeOptions {
  /** Baud rate for the K-line link. Default 19200 (matches CLI default). */
  baudRate?: number;
  /** Cable echoes TX bytes back on RX. Default true. */
  hasAdapterEcho?: boolean;
}

export async function connectBootmode(opts: ConnectBootmodeOptions = {}): Promise<void> {
  bm.status = { kind: "connecting" };
  bm.lastError = null;
  const baud = opts.baudRate ?? 19200;

  try {
    if (isEmbedded) {
      /* Dongle path — RpcUartTransport with `consumeEcho: true` so
         the firmware strips the K-line half-duplex echo server-side.
         The BSL protocol above expects to only see response bytes,
         which matches. `exclusive: true` because a stray dashboard
         tab issuing an ediabasx `job` would fight over the same
         physical wire. */
      const { uartWsUrl } = embeddedEndpoints();
      const rpc = new RpcUartTransport({
        wsUrl: uartWsUrl,
        exclusive: true,
        consumeEcho: true,
        onRevoked: (by) => {
          bm.status = { kind: "error", message: `K-line taken by ${by}` };
        },
      });
      /* Baud has to be applied via configure() before open — the
         firmware's `uart.open` accepts a `baud` param, but we want
         to keep the RpcUartTransport constructor call-site agnostic.
         Configure here uses the transport's stashed config; open()
         picks it up. */
      await rpc.configure({ baudRate: baud, dataBits: 8, parity: "none", stopBits: 1 });
      const transport = new RpcBootmodeTransport(rpc);
      await transport.open();
      activeTransport = transport;
      activeRpc = rpc;
      bm.status = { kind: "connected", portInfo: "dongle K-line", baud };
      return;
    }

    /* Browser path — port picker + WebBootmodeTransport with the
       echo-verify layer above the raw Web Serial writes. */
    if (!isWebSerialAvailable()) {
      bm.status = { kind: "error", message: "Web Serial not available" };
      return;
    }
    const serial = (
      navigator as unknown as {
        serial: { requestPort(): Promise<PortHandle> };
      }
    ).serial;
    const port = await serial.requestPort();
    const transport = new WebBootmodeTransport(port, {
      baudRate: baud,
      hasAdapterEcho: opts.hasAdapterEcho ?? true,
    });
    await transport.open();
    activeTransport = transport;
    const info = port.getInfo?.();
    const label = info?.usbVendorId !== undefined
      ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`
      : "K-line";
    bm.status = { kind: "connected", portInfo: label, baud };
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      bm.status = { kind: "disconnected" };
      return;
    }
    const message = err instanceof UartRevokedError
      ? `K-line revoked by ${err.by}`
      : (err as Error).message;
    bm.status = { kind: "error", message };
  }
}

export async function disconnectBootmode(): Promise<void> {
  if (activeTransport) {
    try {
      await activeTransport.close();
    } catch {
      /* best effort */
    }
    activeTransport = null;
  }
  activeRpc = null;
  bm.status = { kind: "disconnected" };
  bm.progress = null;
}

function onProgress(p: BootmodeProgress): void {
  bm.progress = { ...p };
}

function requireTransport(): BootmodeTransport {
  if (!activeTransport) {
    throw new Error("bootmode: not connected — call connectBootmode() first");
  }
  return activeTransport;
}

function baseCfg(): BootmodeSessionConfig {
  return {
    transport: requireTransport(),
    bundle: bundleLoader,
  };
}

// ── operations ─────────────────────────────────────────────────────

/** Run the BSL handshake + comms probe. Does NOT close the transport. */
export async function probeBootmodeSession(): Promise<boolean> {
  if (!activeTransport) return false;
  bm.busy = true;
  bm.lastError = null;
  bm.progress = null;
  try {
    const result = await pkgProbe(baseCfg(), onProgress);
    return result.ready;
  } catch (err) {
    bm.lastError = (err as Error).message;
    return false;
  } finally {
    bm.busy = false;
  }
}

/** Read the full 512 KB flash image. Returns null on error. */
export async function readBootmodeFlash(): Promise<Uint8Array | null> {
  if (!activeTransport) return null;
  bm.busy = true;
  bm.lastError = null;
  bm.progress = null;
  try {
    return await pkgReadFullFlash(baseCfg(), onProgress);
  } catch (err) {
    bm.lastError = (err as Error).message;
    return null;
  } finally {
    bm.busy = false;
  }
}

export interface WriteBootmodeFlashOptions {
  skipVerify?: boolean;
}

/**
 * Write a 512 KB image. Returns `{ verified }` on success, null on
 * error. Verify is on by default; pass `{ skipVerify: true }` to
 * skip the post-write readback compare.
 */
export async function writeBootmodeFlash(
  image: Uint8Array,
  opts: WriteBootmodeFlashOptions = {},
): Promise<{ verified: boolean } | null> {
  if (!activeTransport) return null;
  bm.busy = true;
  bm.lastError = null;
  bm.progress = null;
  try {
    return await pkgWriteFullFlash(image, baseCfg(), { skipVerify: opts.skipVerify }, onProgress);
  } catch (err) {
    bm.lastError = (err as Error).message;
    return null;
  } finally {
    bm.busy = false;
  }
}

/**
 * Run SHA-256 integrity check on the bundled MiniMon blobs. Safe to
 * call without a connected ECU. Updates `bm.lastIntegrityReport`.
 */
export async function verifyBundleIntegrityWeb(): Promise<IntegrityReport | null> {
  bm.busy = true;
  bm.lastError = null;
  bm.progress = { stage: "integrity", message: "verifying bundled blobs" };
  try {
    const report = await bundleLoader.verifyIntegrity();
    bm.lastIntegrityReport = report;
    bm.progress = null;
    return report;
  } catch (err) {
    bm.lastError = (err as Error).message;
    return null;
  } finally {
    bm.busy = false;
  }
}

// ── Web Serial types (minimal — matches WebBootmodeTransport's shape) ──

interface PortHandle {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: {
    baudRate: number;
    dataBits?: 7 | 8;
    parity?: "none" | "even" | "odd";
    stopBits?: 1 | 2;
    flowControl?: "none" | "hardware";
  }): Promise<void>;
  close(): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
