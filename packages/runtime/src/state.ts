/**
 * In-memory CABI state — the host-side store IPO bytecode reads
 * and writes via CDHSetCabdPar / CDHGetCabdPar / CDHSetSystemData /
 * CDHGetSystemData.
 *
 * Scoped down from ncsx's full `CabiProvider` to what an NFS IPO
 * actually needs for read-only execution:
 *
 *   - cabd-par map: the per-job key/value store. JOBNAME goes here
 *     for cabimain dispatch; `Jobs()` publishes JOB[1..N] here for
 *     the host to read back.
 *   - system-data map: the slot-0x2D store (NCSEXPER's CDHSetSystemData
 *     / coapiSetSystemData). FAHRGESTELL_NR, AUTH material etc. live
 *     here. Empty for vanilla read flows.
 *   - lastJobStatus: last value passed to setjobstatus.
 *
 * Once `@emdzej/ncsx-inpax-cabi-provider` is published, this will be
 * replaced by a thin adapter around `CabiProvider`. Until then this
 * minimal store is enough to validate end-to-end VM execution of NFS
 * IPOs (the Phase 3 hello-world milestone).
 */

export interface LastJob {
  ecu: string;
  job: string;
  para: string;
  /**
   * Most recent JOB_STATUS reported by the SGBD. `OKAY` on success,
   * `ERROR_*` on failure. Empty when no apiJob has run yet.
   */
  status: string;
  /** Whether the job dispatched at all (vs. throwing in ediabas). */
  ok: boolean;
}

export class CabiState {
  /**
   * CABD parameter store (slot 0x2E / 0x2F — NCSEXPER's
   * CDHSetCabdPar / CDHGetCabdPar). Keys are well-known strings
   * like "JOBNAME", "APPLIKATION", "FAHRGESTELL_NR", "JOB[1]", etc.
   */
  readonly cabdPars = new Map<string, string>();

  /**
   * System-data store (slot 0x2C / 0x2D — NCSEXPER's
   * CDHSetSystemData / CDHGetSystemData). NCSEXPER stores
   * FAHRGESTELL_NR + per-AIF identity stamps here.
   */
  readonly systemData = new Map<string, string>();

  /** Last value passed to setjobstatus (slot 0x0B). */
  lastJobStatus: number = 0;

  /**
   * Result of the most recent `CDHapiJob` (slot 0x0D). Result data
   * itself lives in the IEdiabasProvider — this just tracks
   * dispatch metadata so the host can introspect what happened
   * without re-reading the underlying buffer.
   */
  lastJob: LastJob | undefined;

  /**
   * Capture every CDH* / system call the IPO makes, in order. Lets
   * the test harness (and the CLI demo) print a trace of what the
   * IPO did without needing a real ECU.
   */
  readonly trace: Array<{
    slot: number;
    name: string;
    args: Record<string, unknown>;
  }> = [];

  /**
   * Currently-open file from the `fileopen` syscall (slot 0x21). The
   * NCSEXPER CABI table uses single-open semantics — "the open file"
   * per the slot doc-string — so we track at most one descriptor here.
   *
   * For read mode, the entire file is slurped into `readBuffer` on
   * open + a position cursor tracks consumption for later read calls.
   * For write/append, `fd` is a real `node:fs` file descriptor.
   *
   * Used by SG_PROGRAMMIEREN to read `.0PA`/`.0DA` from disk — see
   * `docs/architecture.md` §11.8.
   */
  openFile?: OpenFileState;

  /**
   * Binary-buffer store for the CDHBinBuf* slot family (0x49–0x51).
   * Each `CDHBinBufCreate` allocates a new entry; the handle the IPO
   * uses is the map key. WinKFP's BinBuf is the in-memory staging
   * area between disk reads (`fileread` → BinBufWrite*) and SGBD
   * flash jobs (BinBufToNettoData → CDHapiJob with binary payload).
   *
   * Buffers grow on demand — `WriteByte` at position 1000 with a
   * fresh handle results in a >=1001-byte buffer with the first 1000
   * bytes implicit-zero. Mirrors C-malloc + memset(0) semantics.
   *
   * Layout matches `ncsx-inpax-cabi-provider`'s — `bytes` is the raw
   * backing store (capacity may exceed used range), `size` is the
   * effective length the IPO has written to.
   */
  readonly binBufs = new Map<number, BinBuf>();

  /** Monotonic counter for the next BinBuf handle. 0 is reserved as invalid. */
  nextBinBufHandle: number = 1;

  /**
   * Most-recent `CDHBinBufToNettoData` invocation — used by the next
   * `CDHapiJob` to pick up the binary payload. NFS's exact semantic
   * is TBD; this is the host's stash-for-later until we observe the
   * actual SG_PROGRAMMIEREN flow against real hardware. See task
   * notes in [[feedback-sg-programmieren-primitive]].
   */
  pendingBinBufPayload?: { handle: number; size: number };
}

export interface BinBuf {
  /** Raw backing array — capacity may exceed `size`. */
  bytes: Uint8Array;
  /** Number of bytes the IPO has written (max position + 1). */
  size: number;
}

export interface OpenFileState {
  /** Absolute resolved path. */
  path: string;
  /** Open mode: `r` read / `w` write (truncate) / `a` append. */
  mode: 'r' | 'w' | 'a';
  /** `node:fs` file descriptor for write/append modes. `-1` for read. */
  fd: number;
  /** Slurped file contents for read mode. */
  readBuffer?: Uint8Array;
  /** Current read position in `readBuffer` (bytes consumed). */
  readPos?: number;
}
