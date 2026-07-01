/**
 * `FscManager` — high-level orchestrator for the FSC + cert +
 * identity workflow exposed by the `00swt*.ipo` family.
 *
 * Pattern (per the cabimain trace of any FSC job):
 *
 *   1. Pre-seed cabd-pars the IPO reads at job-prologue
 *      (AUTH_MODE, SGBD_NAME, VARIANT, AUTH_KIND, APP_NR,
 *       UPGRADE_INDEX, …).
 *   2. Spawn a fresh `startNfsRuntime` and dispatch the named
 *      JOBNAME via `runCabimain`.
 *   3. Inspect `lastJob.status` and the published cabd-pars to
 *      produce a typed `FscResult`.
 *
 * Each method spawns a fresh runtime — FSC operations are
 * fire-and-forget; runtime state (cabd-pars / system-data) doesn't
 * carry between jobs. This matches winkfpt's behaviour: every
 * `coapiKf*` call constructs a new CABI session.
 */

import { startNfsRuntimeFromPath, type NfsRuntimeHandle } from '@emdzej/nfsx-runtime/node';
import type {
  FscCabdParPreseeds,
  FscManagerOptions,
  FscResult,
  FsStatusData,
  TimeData,
  VinData,
} from './types.js';

/**
 * Defaults for the host-pre-seeded cabd-pars. NCSEXPER-derived from
 * tracing the IPO's prologue reads — the FSC IPOs expect non-empty
 * values here even for "no auth" flows.
 */
const DEFAULT_PRESEEDS: Required<Pick<FscCabdParPreseeds, 'AUTH_MODE' | 'AUTH_KIND' | 'APP_NR' | 'UPGRADE_INDEX'>> = {
  AUTH_MODE: '0',
  AUTH_KIND: '1',
  APP_NR: '00',
  UPGRADE_INDEX: '00',
};

export class FscManager {
  constructor(private readonly opts: FscManagerOptions) {}

  /**
   * `CHECK_FSC` — verify an existing FSC against the ECU.
   * Dispatches `FREISCHALTCODE_PRUEFEN` on the underlying SGBD.
   */
  async checkFsc(extraCabdPars?: Record<string, string>): Promise<FscResult> {
    const handle = await this.run('CHECK_FSC', extraCabdPars);
    return this.toResult(handle);
  }

  /**
   * `GET_FSC` — read the FSC length from the ECU.
   * Dispatches `FREISCHALTCODE_LAENGE_LESEN`. NFS pairs this with
   * a follow-up binary read; the length-first pattern lets the host
   * allocate a buffer before the actual transfer.
   */
  async getFsc(extraCabdPars?: Record<string, string>): Promise<FscResult> {
    const handle = await this.run('GET_FSC', extraCabdPars);
    return this.toResult(handle);
  }

  /**
   * `GET_FSSTATUS` — read the ECU's flash-programming status.
   * Dispatches `STATUS_LESEN`. The IPO itself only reads the result
   * set count — the actual `FLASH_PROGRAMMIER_STATUS` integer is
   * left in the EDIABAS provider's result store for the host to
   * read directly after the IPO returns.
   */
  async getFsStatus(extraCabdPars?: Record<string, string>): Promise<FscResult<FsStatusData>> {
    const handle = await this.run('GET_FSSTATUS', extraCabdPars);
    const result = this.toResult<FsStatusData>(handle);
    // Pull FLASH_PROGRAMMIER_STATUS directly from the provider —
    // the IPO doesn't publish it itself.
    let status = 0;
    try {
      if (this.opts.ediabas.hasResult('FLASH_PROGRAMMIER_STATUS', 1)) {
        status = this.opts.ediabas.resultInt('FLASH_PROGRAMMIER_STATUS', 1);
      }
    } catch {
      /* missing result → keep status = 0 */
    }
    result.data = { status };
    return result;
  }

  /**
   * `GET_VIN` — read the vehicle's chassis number (VIN) from the
   * ECU. Dispatches `FAHRGESTELLNUMMER_LESEN` on the SGBD, which
   * publishes the chassis number as `FG_NR` in the result set; the
   * IPO copies it into the `VIN` cabd-par.
   */
  async getVin(extraCabdPars?: Record<string, string>): Promise<FscResult<VinData>> {
    const handle = await this.run('GET_VIN', extraCabdPars);
    const result = this.toResult<VinData>(handle);
    result.data = { vin: handle.state.cabdPars.get('VIN') ?? '' };
    return result;
  }

  /**
   * `GET_TIME` — read the ECU's flash-time. The IPO publishes a
   * `TIME` cabd-par. On a real ECU (with a host-RTC interface
   * wired) this is a real timestamp; on a mock/missing-interface
   * setup the IPO publishes `"000000000000Z"` (epoch placeholder).
   *
   * Unique among FSC jobs in that it doesn't issue an apiJob — the
   * value is computed inside the IPO from internal sources.
   */
  async getTime(extraCabdPars?: Record<string, string>): Promise<FscResult<TimeData>> {
    const handle = await this.run('GET_TIME', extraCabdPars);
    const result = this.toResult<TimeData>(handle);
    const time = handle.state.cabdPars.get('TIME') ?? '';
    result.data = { time };
    // GET_TIME has no apiJob → lastJob undefined → toResult marks
    // ok=false. A non-empty TIME means the IPO ran through, which
    // is the operational definition of success here.
    if (time !== '') result.ok = true;
    return result;
  }

  /**
   * `GET_FSSTATUS` / `GET_VIN` / etc. dispatch helper. Subclassable
   * if you need to intercept the per-job pre-seeds.
   */
  protected async run(
    jobName: string,
    extraCabdPars?: Record<string, string>,
  ): Promise<NfsRuntimeHandle> {
    const cabdPars = this.buildPreseeds(extraCabdPars);
    const handle = await startNfsRuntimeFromPath(this.opts.ipoPath, {
      sgbd: this.opts.sgbd,
      ediabas: this.opts.ediabas,
      cabdPars,
    });
    await handle.runCabimain(jobName);
    return handle;
  }

  /**
   * Merge order: built-in defaults → ctor-level cabd-pars → per-job
   * extras. Last write wins, so callers can override anything.
   * `SGBD_NAME` defaults to the ctor's `sgbd` if not otherwise set.
   */
  protected buildPreseeds(extra?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...DEFAULT_PRESEEDS };
    if (!out.SGBD_NAME) out.SGBD_NAME = this.opts.sgbd;
    for (const [k, v] of Object.entries(this.opts.cabdPars ?? {})) {
      if (v !== undefined) out[k] = v;
    }
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /**
   * Collapse `runtime.state.lastJob` + cabd-pars into a typed
   * `FscResult`. Handles three cases:
   *
   *   - apiJob OK, JOB_STATUS == "OKAY" → ok: true
   *   - apiJob OK, JOB_STATUS != "OKAY" → ok: false + error from
   *     API_RESULT_CODE / API_RESULT cabd-pars
   *   - apiJob threw → ok: false, jobStatus reflects the exception
   */
  protected toResult<T>(handle: NfsRuntimeHandle): FscResult<T> {
    const status = handle.state.lastJob?.status ?? '';
    const ok = status === 'OKAY';
    const result: FscResult<T> = {
      ok,
      jobStatus: status,
      cabdPars: handle.state.cabdPars,
    };
    if (!ok) {
      const code = handle.state.cabdPars.get('API_RESULT_CODE') ?? '';
      const message = handle.state.cabdPars.get('API_RESULT') ?? status;
      result.error = { code, message };
    }
    return result;
  }
}
