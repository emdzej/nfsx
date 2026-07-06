/**
 * `RpcUartTransport` — dongle-side raw K-line access via the Bimmerz
 * Box firmware's `/rpc/uart/0` JSON-RPC-over-WebSocket endpoint.
 *
 * Purpose: drop-in replacement for `WebSerialTransport` (from
 * `@emdzej/ediabasx-interface-serial`) and `WebBootmodeTransport`
 * (from `apps/web/src/lib/bootmode-transport.ts`) when the app is
 * running dongle-embedded. Same DS2 / BSL protocol code sits above;
 * only the byte-pipe changes.
 *
 * Wire protocol (source: `bimmerz-box/firmware/components/rpc_uart/`):
 *
 *   Requests (id + method + params → result):
 *     uart.open      { exclusive?, baud?, parity?, dataBits?, stopBits?, consumeEcho? }
 *     uart.configure { baud?, parity?, consumeEcho? }
 *     uart.write     { data: <base64> }
 *     uart.transact  { data: <base64>, readMs, readBytes? }
 *     uart.slowInit  { value, bitTimeMs?, baudAfter?, parityAfter? }
 *     uart.fastInit  { breakMs?, idleMs? }
 *     uart.close     {}
 *
 *   Notifications (server → holder):
 *     uart.rx        { data: <base64> }
 *     uart.revoked   { by: <peer-ip> }
 *     uart.error     { message }
 *
 * The dongle's `/rpc/uart/0` arbitrates against the `ediabasx-server`'s
 * own K-line access: while `/rpc/uart/0` is held, the VM's `job` calls
 * fail with a transport error. Callers must close the transport (or
 * disconnect the WebSocket) before switching back to SGBD flows.
 *
 * Only the subset of `SerialTransport` that DS2 / BSL actually use is
 * implemented meaningfully:
 *   - `open` / `close`
 *   - `configure` (baud + parity; dataBits/stopBits ignored — K-line is 8N1 / 8E1)
 *   - `purge` / `flushInput` (drop local RX buffer)
 *   - `write` / `read`
 *   - `setBreak` — routed to `uart.fastInit({ breakMs })`, matching the
 *     way `sendFastInit(transport, { setDtr })` currently drives fast
 *     init.
 *   - `setDtr` / `setRts` — no-ops. The dongle's L9637D K-line
 *     transceiver has no equivalent lines; browser cables need these
 *     for the FTDI smart-cable handshake, on the dongle path there's
 *     no adapter to talk to.
 *
 * Not covered: `sendPulse`, `setTelegramEndTimeout` (the latter is set
 * at construction time via options.telegramEndTimeoutMs).
 */

import type { SerialTransport, SerialTransportConfig } from "@emdzej/ediabasx-interface-serial";

/** Options mirror `WebSerialTransport`'s where practical. */
export interface RpcUartTransportOptions {
  /**
   * Fully-qualified WebSocket URL for the dongle's UART endpoint —
   * typically `${origin.replace(/^http/, "ws")}/rpc/uart/0`.
   */
  wsUrl: string;
  /**
   * When true, the dongle refuses cooperative opens from other peers
   * for the lifetime of this session. Default `false` — ncsx and inpax
   * both talk to `/rpc/ediabasx` cooperatively, but nfsx's flashing
   * flows want exclusivity so a stray dashboard tab doesn't steal the
   * wire mid-write.
   */
  exclusive?: boolean;
  /**
   * If true, the dongle side strips the K-line half-duplex echo bytes
   * from every `uart.rx` before streaming to us. Default `false` —
   * DS2 / BSL both construct sessions with `hasAdapterEcho: true`,
   * meaning they *expect* to see the echo on rx and consume it in
   * software. Set to `true` if a higher layer is deliberately built
   * against the echo-stripped view.
   */
  consumeEcho?: boolean;
  /**
   * Idle-detection timeout once at least one byte has arrived — mirrors
   * `WebSerialTransport.telegramEndTimeoutMs`. Default 20 ms. Set to 0
   * to disable and always wait for the full requested length.
   */
  telegramEndTimeoutMs?: number;
  /**
   * Timeout for a single JSON-RPC round-trip (open, configure, write,
   * etc.). Defaults to 5000 ms. Reads have their own timeout parameter
   * and are not bounded by this.
   */
  rpcTimeoutMs?: number;
  /**
   * Called when the server sends `uart.revoked` — another peer opened
   * the endpoint cooperatively and took the wire. The transport
   * enters a permanent error state; caller should decide whether to
   * reconnect. Default: no callback (pending reads reject with a
   * revoked error).
   */
  onRevoked?: (by: string) => void;
  /**
   * Optional info sink. Wired to the app's bimmerz-logger category by
   * the calling session module.
   */
  log?: (msg: string, level?: "info" | "warn" | "error") => void;
  /**
   * Test seam — swap in a fake WebSocket constructor for unit tests.
   * The fake must match the standard `WebSocket` shape (constructor +
   * `send` + `close` + `onopen` / `onmessage` / `onerror` / `onclose`).
   * Defaults to `globalThis.WebSocket`.
   */
  webSocketFactory?: (url: string) => IWebSocketLike;
}

/** Minimum WebSocket surface this transport needs. */
export interface IWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer | Blob }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

const DEFAULT_CONFIG: SerialTransportConfig = {
  baudRate: 9600,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
};

const READY_STATE_OPEN = 1;

interface PendingRpc {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingRead {
  length: number;
  collected: number[];
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  telegramTimeoutId: ReturnType<typeof setTimeout> | null;
}

interface RpcResponse {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

interface UartOpenResult {
  ok?: boolean;
  baud?: number;
  parity?: string;
  exclusive?: boolean;
  consumeEcho?: boolean;
  error?: string;
}

interface UartRxParams {
  data?: string;
}

interface UartRevokedParams {
  by?: string;
}

interface UartErrorParams {
  message?: string;
}

/**
 * Base64 helpers scoped to the transport so the file doesn't drag in a
 * larger polyfill for the sake of two calls. Browsers ship `atob` /
 * `btoa`, which round-trip Latin-1 (one byte per char) — safe for our
 * binary buffers as long as we stick to `String.fromCharCode` /
 * `charCodeAt` and skip any Unicode-aware helpers.
 */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return globalThis.btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = globalThis.atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Discriminator for the "transport revoked by another peer" error path. */
export class UartRevokedError extends Error {
  constructor(public readonly by: string) {
    super(`uart revoked by ${by}`);
    this.name = "UartRevokedError";
  }
}

/**
 * `SerialTransport` implementation backed by the dongle's
 * `/rpc/uart/0` JSON-RPC WebSocket endpoint. Constructor is
 * synchronous; call `open()` to actually connect + issue `uart.open`.
 */
export class RpcUartTransport implements SerialTransport {
  private readonly options: RpcUartTransportOptions;
  private readonly telegramEndTimeoutMs: number;
  private readonly rpcTimeoutMs: number;

  private config: SerialTransportConfig = { ...DEFAULT_CONFIG };
  private ws: IWebSocketLike | null = null;
  private opened = false;
  private closing = false;

  private nextRpcId = 1;
  private pendingRpcs = new Map<number, PendingRpc>();

  private rxBuffer: number[] = [];
  private pendingReads: PendingRead[] = [];

  /**
   * When the server sends `uart.revoked` we stash it here so any
   * subsequent read / write fails with a clear error rather than
   * silently hanging on a socket the dongle has stopped feeding.
   */
  private revokedBy: string | null = null;

  constructor(options: RpcUartTransportOptions) {
    this.options = options;
    this.telegramEndTimeoutMs = options.telegramEndTimeoutMs ?? 20;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 5000;
  }

  /**
   * Open the WebSocket + issue `uart.open` with the currently-stashed
   * config. The `_port` argument from `SerialTransport.open` is
   * ignored — the endpoint is fixed at construction time.
   */
  async open(_port?: string): Promise<void> {
    if (this.opened) return;
    if (this.revokedBy !== null) {
      throw new UartRevokedError(this.revokedBy);
    }

    await this.connectSocket();

    const params = {
      exclusive: this.options.exclusive ?? false,
      consumeEcho: this.options.consumeEcho ?? false,
      baud: this.config.baudRate,
      parity: this.config.parity,
      dataBits: this.config.dataBits,
      stopBits: this.config.stopBits,
    };
    const result = (await this.request("uart.open", params)) as UartOpenResult;
    if (result?.error) {
      /* Roll back the socket connection so callers can retry cleanly
         after fixing the arbitration issue (e.g. releasing the wire
         from ediabasx-server). */
      await this.closeSocket();
      throw new Error(`uart.open failed: ${result.error}`);
    }
    this.opened = true;
    this.log(
      `uart.open ok — baud=${result?.baud} parity=${result?.parity} exclusive=${result?.exclusive} consumeEcho=${result?.consumeEcho}`,
      "info",
    );
  }

  async close(): Promise<void> {
    if (!this.opened && this.ws === null) return;
    this.closing = true;

    /* Best-effort uart.close so the dongle releases the wire promptly
       — the WebSocket disconnect below is the fallback trigger (the
       firmware releases on holder-fd close), but a clean shutdown
       cooperates better with rapid reconnect scenarios (Settings →
       Disconnect → Connect within a few ms). */
    if (this.opened && this.ws?.readyState === READY_STATE_OPEN) {
      try {
        await this.request("uart.close", {});
      } catch {
        /* ignore — we're tearing down */
      }
    }

    /* Reject any outstanding reads so callers don't hang on close. */
    for (const pending of this.pendingReads.splice(0)) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      if (pending.telegramTimeoutId) clearTimeout(pending.telegramTimeoutId);
      pending.reject(new Error("uart transport closed"));
    }
    for (const pending of this.pendingRpcs.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("uart transport closed"));
    }
    this.pendingRpcs.clear();

    await this.closeSocket();
    this.rxBuffer.length = 0;
    this.opened = false;
    this.closing = false;
  }

  async configure(config: SerialTransportConfig): Promise<void> {
    const same =
      this.config.baudRate === config.baudRate &&
      this.config.parity === config.parity;
    this.config = { ...config };
    if (!this.opened || same) return;
    /* K-line only cares about baud + parity; dataBits/stopBits are
       fixed by the transceiver + framing (8N1 or 8E1). Pass what the
       firmware actually consumes. */
    const result = (await this.request("uart.configure", {
      baud: this.config.baudRate,
      parity: this.config.parity,
      consumeEcho: this.options.consumeEcho ?? false,
    })) as UartOpenResult;
    if (result?.error) {
      throw new Error(`uart.configure failed: ${result.error}`);
    }
  }

  async setDtr(_value: boolean): Promise<void> {
    /* No-op — the dongle L9637D K-line transceiver has no DTR line.
       DS2's `sendFastInit(transport, { setDtr: true })` still works
       because `setBreak` (below) fires `uart.fastInit`, which is the
       transceiver-driver equivalent of the DTR-toggle wake pulse. */
  }

  async setRts(_value: boolean): Promise<void> {
    /* Same reasoning as setDtr — RTS is a passthrough concept for
       browser-side USB serial adapters and doesn't map onto the
       dongle's UART driver. */
  }

  async setBreak(durationMs: number): Promise<void> {
    if (!this.opened) return;
    /* `sendFastInit(transport, { setDtr })` calls setBreak once with
       the fast-init break duration, then reads keybytes. Route that
       to `uart.fastInit` — the firmware drives the K-line into a
       controlled break for `breakMs` and returns when the pulse is
       done. idleMs=0 leaves the post-break settle time to the caller
       (DS2's next `read(3, 200)` covers the keybyte window). */
    const result = (await this.request("uart.fastInit", {
      breakMs: Math.max(0, Math.round(durationMs)),
      idleMs: 0,
    })) as UartOpenResult;
    if (result?.error) {
      throw new Error(`uart.fastInit failed: ${result.error}`);
    }
  }

  async purge(): Promise<void> {
    this.rxBuffer.length = 0;
  }

  /** Alias for `purge()` to satisfy `BootmodeTransport.flushInput`. */
  flushInput(): void {
    this.rxBuffer.length = 0;
  }

  async write(data: Uint8Array): Promise<void> {
    /* revoked-check ahead of opened-check: uart.revoked flips `opened`
       back to false, so falling into the generic "not open" branch
       would mask a real arbitration event with a less specific error
       (and callers would lose access to `UartRevokedError`). */
    if (this.revokedBy !== null) throw new UartRevokedError(this.revokedBy);
    if (!this.opened) throw new Error("uart transport not open");
    const result = (await this.request("uart.write", {
      data: toBase64(data),
    })) as UartOpenResult;
    if (result?.error) {
      throw new Error(`uart.write failed: ${result.error}`);
    }
  }

  read(length: number, timeoutMs: number): Promise<Uint8Array> {
    if (length <= 0) return Promise.resolve(new Uint8Array(0));
    if (this.revokedBy !== null) {
      return Promise.reject(new UartRevokedError(this.revokedBy));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingRead = {
        length,
        collected: [],
        resolve,
        reject,
        timeoutId: null,
        telegramTimeoutId: null,
      };
      /* Drain anything already buffered from earlier `uart.rx`
         notifications. Mirrors WebSerialTransport's fast path. */
      if (this.rxBuffer.length > 0) {
        const take = Math.min(this.rxBuffer.length, length);
        pending.collected = this.rxBuffer.splice(0, take);
        if (pending.collected.length === length) {
          resolve(Uint8Array.from(pending.collected));
          return;
        }
      }
      this.pendingReads.push(pending);
      if (timeoutMs > 0) {
        pending.timeoutId = setTimeout(() => {
          this.removePending(pending);
          reject(
            new Error(
              `uart read timeout: wanted ${length}, got ${pending.collected.length} in ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  /* ─── firmware-specific escape hatches ─────────────────────────
     These sit alongside the SerialTransport surface so a session that
     knows it's on the dongle path can drive `uart.fastInit` /
     `uart.slowInit` directly (with their full parameter set) instead
     of round-tripping through `setBreak`. Optional — the generic
     path via setBreak already works for standard fast init. */

  /** Full-parameter `uart.fastInit` — break-then-idle in one call. */
  async fastInit(opts: { breakMs?: number; idleMs?: number } = {}): Promise<void> {
    if (!this.opened) throw new Error("uart transport not open");
    const result = (await this.request("uart.fastInit", {
      breakMs: opts.breakMs ?? 0,
      idleMs: opts.idleMs ?? 0,
    })) as UartOpenResult;
    if (result?.error) {
      throw new Error(`uart.fastInit failed: ${result.error}`);
    }
  }

  /**
   * 5-baud wake — `uart.slowInit` sends the byte at 5 baud on the
   * K-line, then optionally reconfigures baud/parity for the KWP2000
   * handshake that follows. Not used by DS2 / BSL, exposed for future
   * KWP-over-dongle needs.
   */
  async slowInit(opts: {
    value: number;
    bitTimeMs?: number;
    baudAfter?: number;
    parityAfter?: "none" | "even" | "odd";
  }): Promise<void> {
    if (!this.opened) throw new Error("uart transport not open");
    const result = (await this.request("uart.slowInit", opts)) as UartOpenResult;
    if (result?.error) {
      throw new Error(`uart.slowInit failed: ${result.error}`);
    }
  }

  /* ─── internals ────────────────────────────────────────────── */

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const factory =
        this.options.webSocketFactory ??
        ((url: string) =>
          new (globalThis as unknown as { WebSocket: new (u: string) => IWebSocketLike }).WebSocket(url));
      let ws: IWebSocketLike;
      try {
        ws = factory(this.options.wsUrl);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => {
        /* Any error before onopen fires means the socket never
           connected; reject with a generic message rather than
           surface the browser's opaque `Event` object. Once open, we
           rely on onclose to detect drops. */
        if (!this.opened) reject(new Error(`uart transport: WebSocket error opening ${this.options.wsUrl}`));
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = (ev) => {
        this.ws = null;
        if (this.closing) return;
        /* Unsolicited close — reject pending stuff so callers unblock. */
        const err = new Error(
          `uart transport WebSocket closed (code=${ev.code ?? "?"}, reason=${ev.reason || "?"})`,
        );
        for (const pending of this.pendingRpcs.values()) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(err);
        }
        this.pendingRpcs.clear();
        for (const pending of this.pendingReads.splice(0)) {
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          if (pending.telegramTimeoutId) clearTimeout(pending.telegramTimeoutId);
          pending.reject(err);
        }
        this.opened = false;
      };
    });
  }

  private closeSocket(): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws) {
        resolve();
        return;
      }
      const prev = ws.onclose;
      ws.onclose = (ev) => {
        this.ws = null;
        prev?.(ev);
        resolve();
      };
      try {
        ws.close();
      } catch {
        this.ws = null;
        resolve();
      }
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== READY_STATE_OPEN) {
      return Promise.reject(new Error(`uart transport: WebSocket not open (${method})`));
    }
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRpc = {
        method,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingRpcs.delete(id);
          reject(new Error(`uart transport: ${method} timed out after ${this.rpcTimeoutMs}ms`));
        }, this.rpcTimeoutMs),
      };
      this.pendingRpcs.set(id, pending);
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      try {
        ws.send(frame);
      } catch (err) {
        this.pendingRpcs.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(raw: string | ArrayBuffer | Blob): void {
    if (typeof raw !== "string") {
      /* The dongle only sends text frames; ignore binary defensively. */
      this.log("dropped non-text WS frame", "warn");
      return;
    }
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(raw) as RpcResponse;
    } catch {
      this.log(`dropped malformed JSON frame: ${raw.slice(0, 80)}…`, "warn");
      return;
    }

    if (typeof parsed.method === "string") {
      this.onNotification(parsed.method, parsed.params);
      return;
    }
    if (typeof parsed.id === "number") {
      const pending = this.pendingRpcs.get(parsed.id);
      if (!pending) {
        this.log(`response for unknown id ${parsed.id} (${parsed.result ? "ok" : "err"})`, "warn");
        return;
      }
      this.pendingRpcs.delete(parsed.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(
          new Error(`${pending.method}: ${parsed.error.message ?? "unknown error"}`),
        );
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case "uart.rx": {
        const p = params as UartRxParams | undefined;
        if (!p?.data) return;
        let bytes: Uint8Array;
        try {
          bytes = fromBase64(p.data);
        } catch {
          this.log(`uart.rx: base64 decode failed`, "warn");
          return;
        }
        for (let i = 0; i < bytes.length; i++) this.rxBuffer.push(bytes[i]!);
        this.deliverToPendingReads();
        break;
      }
      case "uart.revoked": {
        const p = params as UartRevokedParams | undefined;
        const by = p?.by ?? "unknown";
        this.revokedBy = by;
        this.opened = false;
        this.log(`uart.revoked by ${by}`, "warn");
        for (const pending of this.pendingReads.splice(0)) {
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          if (pending.telegramTimeoutId) clearTimeout(pending.telegramTimeoutId);
          pending.reject(new UartRevokedError(by));
        }
        this.options.onRevoked?.(by);
        break;
      }
      case "uart.error": {
        const p = params as UartErrorParams | undefined;
        this.log(`uart.error: ${p?.message ?? "unknown"}`, "error");
        break;
      }
      default:
        this.log(`unknown notification: ${method}`, "warn");
    }
  }

  private deliverToPendingReads(): void {
    while (this.pendingReads.length > 0 && this.rxBuffer.length > 0) {
      const pending = this.pendingReads[0]!;
      const needed = pending.length - pending.collected.length;
      const take = Math.min(needed, this.rxBuffer.length);
      const slice = this.rxBuffer.splice(0, take);
      pending.collected.push(...slice);

      /* Refresh the idle-detection timer each time a byte lands.
         Once the requested length is reached, resolve immediately. */
      if (pending.telegramTimeoutId) {
        clearTimeout(pending.telegramTimeoutId);
        pending.telegramTimeoutId = null;
      }
      if (pending.collected.length === pending.length) {
        this.completePending(pending);
      } else if (this.telegramEndTimeoutMs > 0) {
        pending.telegramTimeoutId = setTimeout(() => {
          this.completePending(pending);
        }, this.telegramEndTimeoutMs);
      }
    }
  }

  private completePending(pending: PendingRead): void {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    if (pending.telegramTimeoutId) clearTimeout(pending.telegramTimeoutId);
    this.removePending(pending);
    pending.resolve(Uint8Array.from(pending.collected));
  }

  private removePending(pending: PendingRead): void {
    const idx = this.pendingReads.indexOf(pending);
    if (idx >= 0) this.pendingReads.splice(idx, 1);
  }

  private log(msg: string, level: "info" | "warn" | "error" = "info"): void {
    this.options.log?.(msg, level);
  }
}
