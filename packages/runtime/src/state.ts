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
}
