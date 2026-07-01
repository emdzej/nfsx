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
  type BundleLoader,
  type IntegrityReport,
} from "@emdzej/nfsx-bootmode";
import { WebBootmodeTransport } from "./bootmode-transport";
import { createWebBundleLoader } from "./bootmode-bundle-loader";

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
// and the bundle loader. Neither is reactive.
let activeTransport: WebBootmodeTransport | null = null;
let bundleLoader: BundleLoader = createWebBundleLoader();

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

export function isWebSerialSupported(): boolean {
  return isWebSerialAvailable();
}

// ── connection lifecycle ───────────────────────────────────────────

export interface ConnectBootmodeOptions {
  /** Baud rate for the K-line link. Default 19200 (matches CLI default). */
  baudRate?: number;
  /** Cable echoes TX bytes back on RX. Default true. */
  hasAdapterEcho?: boolean;
}

export async function connectBootmode(opts: ConnectBootmodeOptions = {}): Promise<void> {
  if (!isWebSerialAvailable()) {
    bm.status = { kind: "error", message: "Web Serial not available" };
    return;
  }
  bm.status = { kind: "connecting" };
  bm.lastError = null;
  const baud = opts.baudRate ?? 19200;
  try {
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
    bm.status = { kind: "error", message: (err as Error).message };
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
  bm.status = { kind: "disconnected" };
  bm.progress = null;
}

function onProgress(p: BootmodeProgress): void {
  bm.progress = { ...p };
}

function requireTransport(): WebBootmodeTransport {
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
