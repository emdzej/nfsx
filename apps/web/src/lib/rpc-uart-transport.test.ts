/**
 * `RpcUartTransport` unit tests — drive the transport against a fake
 * WebSocket that speaks the same JSON-RPC envelope the dongle's
 * `/rpc/uart/0` endpoint speaks. No dongle required; the fake exposes
 * a small "server side" API (`serverReceive`, `serverNotify`) to
 * simulate the firmware's responses and streamed rx frames.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RpcUartTransport,
  UartRevokedError,
  type IWebSocketLike,
} from "./rpc-uart-transport";

const WS_URL = "ws://dongle.test/rpc/uart/0";

interface RpcFrame {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * A single fake `WebSocket` instance. Behaves like the dongle's WS
 * endpoint enough to drive the transport through its states.
 *
 * The transport calls `send()` with JSON-encoded requests; the fake
 * parses them and lets the test respond via `respond()` / `notify()`.
 * `flush()` is called by the fake once per test to actually deliver
 * pending `onopen` / `onmessage` events on a microtask (matching the
 * real API's asynchronicity).
 */
class FakeWebSocket implements IWebSocketLike {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer | Blob }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  /** Frames the client (transport) has sent, in order. */
  readonly sentFrames: RpcFrame[] = [];
  private closed = false;

  constructor(public readonly url: string) {
    /* Simulate the open handshake landing on the next microtask so
       the transport's connectSocket promise settles after callers
       have wired handlers. */
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    if (this.closed) throw new Error("send on closed socket");
    this.sentFrames.push(JSON.parse(data) as RpcFrame);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    /* Fire onclose on a microtask to match browser semantics — a
       close() call returns synchronously but the onclose handler is
       invoked async. */
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /**
   * "Server side" — deliver a JSON-RPC response frame back to the
   * transport. Awaits the next microtask before firing so the caller
   * has a chance to see the sent frame and construct the reply.
   */
  respond(id: number, result: unknown, error?: { code?: number; message?: string }): void {
    const frame: RpcFrame = { jsonrpc: "2.0", id, ...(error ? { error } : { result }) };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }

  /** Deliver a notification (no id). */
  notify(method: string, params?: unknown): void {
    const frame: RpcFrame = { jsonrpc: "2.0", method, params };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }

  /** Deliver a raw frame verbatim — useful for malformed-input tests. */
  rawInbound(data: string): void {
    queueMicrotask(() => this.onmessage?.({ data }));
  }
}

/**
 * Build a transport hooked to a fresh fake socket. The fake is
 * returned separately so the test can drive the server side.
 */
function build(opts: {
  telegramEndTimeoutMs?: number;
  exclusive?: boolean;
  onRevoked?: (by: string) => void;
} = {}) {
  let capturedSocket: FakeWebSocket | null = null;
  const transport = new RpcUartTransport({
    wsUrl: WS_URL,
    telegramEndTimeoutMs: opts.telegramEndTimeoutMs ?? 0,
    exclusive: opts.exclusive,
    onRevoked: opts.onRevoked,
    webSocketFactory: (url) => {
      capturedSocket = new FakeWebSocket(url);
      return capturedSocket;
    },
  });
  return {
    transport,
    /* getter so tests read the socket after `open()` has run through
       the factory */
    get ws(): FakeWebSocket {
      if (!capturedSocket) throw new Error("socket not yet created");
      return capturedSocket;
    },
  };
}

/**
 * Advance one microtask + start a settlement cycle so both queued
 * `queueMicrotask` callbacks in the fake WS and the transport's
 * follow-on state updates get to run.
 */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RpcUartTransport", () => {
  beforeEach(() => {
    /* atob / btoa are already available in Node 20+; make it explicit
       so a hostile jsdom env doesn't shadow them. */
    if (typeof globalThis.btoa !== "function") {
      globalThis.btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
    }
    if (typeof globalThis.atob !== "function") {
      globalThis.atob = (s: string) => Buffer.from(s, "base64").toString("binary");
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("open()", () => {
    it("connects the socket and sends uart.open with configured params", async () => {
      const built = build({ exclusive: true });
      const opening = built.transport.open();
      /* Let onopen fire, then let the transport's request() land in the
         sent-frames log. */
      await tick();
      expect(built.ws.sentFrames).toHaveLength(1);
      const frame = built.ws.sentFrames[0]!;
      expect(frame.method).toBe("uart.open");
      expect(frame.params).toMatchObject({
        exclusive: true,
        consumeEcho: false,
        baud: 9600,
        parity: "none",
      });
      built.ws.respond(frame.id!, {
        ok: true,
        baud: 9600,
        parity: "none",
        exclusive: true,
        consumeEcho: false,
      });
      await opening;
    });

    it("throws with the firmware's error message when uart.open reports arbitration failure", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      const frame = built.ws.sentFrames[0]!;
      built.ws.respond(frame.id!, { error: "bus_busy" });
      await expect(opening).rejects.toThrow(/uart\.open failed: bus_busy/);
    });

    it("is idempotent — a second open() while open is a no-op", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;
      await built.transport.open();
      expect(built.ws.sentFrames).toHaveLength(1);
    });
  });

  describe("write() and read()", () => {
    async function openTransport() {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;
      return built;
    }

    it("base64-encodes the payload on write", async () => {
      const { transport, ws } = await openTransport();
      const writing = transport.write(new Uint8Array([0xf1, 0x02, 0x03]));
      await tick();
      const frame = ws.sentFrames[ws.sentFrames.length - 1]!;
      expect(frame.method).toBe("uart.write");
      expect(frame.params).toEqual({ data: btoa("\xf1\x02\x03") });
      ws.respond(frame.id!, { ok: true, wrote: 3 });
      await writing;
    });

    it("delivers bytes from uart.rx notifications to a pending read", async () => {
      const { transport, ws } = await openTransport();
      const reading = transport.read(4, 500);
      await tick();
      /* Stream in two rx frames — the transport should reassemble
         them into a single 4-byte read result. */
      ws.notify("uart.rx", { data: btoa("\xaa\xbb") });
      ws.notify("uart.rx", { data: btoa("\xcc\xdd") });
      const result = await reading;
      expect(Array.from(result)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    });

    it("drains bytes buffered from prior uart.rx frames before waiting", async () => {
      const { transport, ws } = await openTransport();
      /* Byte arrives before any read is queued — should be buffered. */
      ws.notify("uart.rx", { data: btoa("\x01\x02\x03") });
      await tick();
      const result = await transport.read(3, 500);
      expect(Array.from(result)).toEqual([0x01, 0x02, 0x03]);
    });

    it("returns partial data after telegramEndTimeoutMs of silence", async () => {
      vi.useFakeTimers();
      const built = build({ telegramEndTimeoutMs: 20 });
      const opening = built.transport.open();
      await vi.advanceTimersByTimeAsync(0);
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await vi.advanceTimersByTimeAsync(0);
      await opening;

      const reading = built.transport.read(10, 1000);
      built.ws.notify("uart.rx", { data: btoa("\x11\x22") });
      /* Deliver the notification. */
      await vi.advanceTimersByTimeAsync(0);
      /* No more rx for the idle window → transport should give up and
         return the two bytes it has. */
      await vi.advanceTimersByTimeAsync(25);
      const result = await reading;
      expect(Array.from(result)).toEqual([0x11, 0x22]);
    });

    it("times out with an error when no bytes arrive in the read window", async () => {
      vi.useFakeTimers();
      const built = build();
      const opening = built.transport.open();
      await vi.advanceTimersByTimeAsync(0);
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await vi.advanceTimersByTimeAsync(0);
      await opening;

      const reading = built.transport.read(1, 100);
      /* Attach the rejection assertion BEFORE advancing timers — with
         fake timers, the setTimeout callback fires synchronously during
         `advanceTimersByTimeAsync`, and Node flags a rejection as
         unhandled if there's no `.catch` at the moment it rejects.
         Racing the assertion in first gives it a real handler. */
      const rejected = expect(reading).rejects.toThrow(/uart read timeout/);
      await vi.advanceTimersByTimeAsync(101);
      await rejected;
    });
  });

  describe("setBreak() → uart.fastInit", () => {
    it("routes setBreak(N ms) to uart.fastInit with breakMs=N and idleMs=0", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;

      const breaking = built.transport.setBreak(25);
      await tick();
      const frame = built.ws.sentFrames[built.ws.sentFrames.length - 1]!;
      expect(frame.method).toBe("uart.fastInit");
      expect(frame.params).toEqual({ breakMs: 25, idleMs: 0 });
      built.ws.respond(frame.id!, { ok: true });
      await breaking;
    });
  });

  describe("uart.revoked", () => {
    it("rejects pending reads with UartRevokedError and invokes onRevoked", async () => {
      const onRevoked = vi.fn();
      const built = build({ onRevoked });
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;

      const reading = built.transport.read(1, 500);
      built.ws.notify("uart.revoked", { by: "192.168.4.42" });
      await expect(reading).rejects.toBeInstanceOf(UartRevokedError);
      expect(onRevoked).toHaveBeenCalledWith("192.168.4.42");
    });

    it("fails subsequent reads with UartRevokedError until close()", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;

      built.ws.notify("uart.revoked", { by: "10.0.0.5" });
      await tick();
      await expect(built.transport.read(1, 500)).rejects.toBeInstanceOf(UartRevokedError);
      await expect(built.transport.write(new Uint8Array([0]))).rejects.toBeInstanceOf(UartRevokedError);
    });
  });

  describe("close()", () => {
    it("sends uart.close then closes the socket", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;

      const closing = built.transport.close();
      await tick();
      const frame = built.ws.sentFrames[built.ws.sentFrames.length - 1]!;
      expect(frame.method).toBe("uart.close");
      built.ws.respond(frame.id!, { ok: true });
      await closing;
      expect(built.ws.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it("rejects any in-flight read with 'transport closed'", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await opening;

      const reading = built.transport.read(4, 5000);
      /* Kick off close in parallel — the uart.close request needs to
         be responded to before the transport tears down. */
      const closing = built.transport.close();
      await tick();
      built.ws.respond(built.ws.sentFrames[built.ws.sentFrames.length - 1]!.id!, { ok: true });
      await closing;
      await expect(reading).rejects.toThrow(/transport closed/);
    });
  });

  describe("malformed input tolerance", () => {
    it("drops non-JSON frames without breaking pending requests", async () => {
      const built = build();
      const opening = built.transport.open();
      await tick();
      built.ws.rawInbound("this is not json");
      /* Now respond correctly — the transport should still resolve. */
      built.ws.respond(built.ws.sentFrames[0]!.id!, { ok: true });
      await expect(opening).resolves.toBeUndefined();
    });
  });
});
