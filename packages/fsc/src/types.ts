/**
 * Public types for the FSC orchestrator. All FSC IPO jobs share a
 * common result-reporting pattern:
 *
 *   1. JOB_STATUS = "OKAY" → happy path; lastJob.status === "OKAY"
 *   2. JOB_STATUS empty/error → IPO publishes API_RESULT_CODE +
 *      API_RESULT cabd-pars
 *
 * We collapse both into a single `FscResult<T>` shape so callers
 * don't have to special-case the two return paths.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { IpoRuntimeStart } from '@emdzej/nfsx-runtime';

/**
 * Common host pre-seeds the FSC IPOs read at the top of every job
 * before dispatching to the SGBD. Reasonable defaults for most
 * KWP-era ECUs — caller can override per-call.
 *
 * Per `00swtkwp.ipo` cabimain trace:
 *   - AUTH_MODE       — '0' = no auth, '1' = challenge-response
 *   - AUTH_KIND       — auth scheme variant
 *   - APP_NR          — FSC application slot (which FSC area)
 *   - UPGRADE_INDEX   — upgrade-context index
 *   - SGBD_NAME       — ECU SGBD basename (forwarded to apiJob)
 *   - VARIANT         — SG variant tag (e.g. DSC60)
 *   - PSGBD_NAME      — "protocol-SGBD" (transport-level driver)
 */
export interface FscCabdParPreseeds {
  AUTH_MODE?: string;
  AUTH_KIND?: string;
  APP_NR?: string;
  UPGRADE_INDEX?: string;
  SGBD_NAME?: string;
  VARIANT?: string;
  PSGBD_NAME?: string;
  /** Additional/arbitrary pre-seeds for jobs that need them. */
  [key: string]: string | undefined;
}

export interface FscManagerOptions {
  /**
   * Loads + starts an `NfsRuntimeHandle` for the FSC IPO. Node
   * consumers pass `startNfsRuntimeFromPath` from
   * `@emdzej/nfsx-runtime/node`; browsers pass a closure that pulls
   * bytes out of the mounted SP-Daten VFS and delegates to
   * `startNfsRuntime`. See `IpoRuntimeStart` for the contract.
   */
  startRuntime: IpoRuntimeStart;
  /**
   * Path to the 00swt*.ipo file for the ECU's transport.
   *
   *   - 00swtkwp.ipo  — KWP2000 (E60+, most common)
   *   - 00swtds2.ipo  — DS2 (E39/E46/E53)
   *   - 00swtdsc.ipo  — DS-C
   *   - 00swteps.ipo  — EPS
   *   - 00swtkws.ipo  — KWP-S
   *   - 00swtmsd.ipo  — MSD (motor)
   *
   * All six expose the same 20-job CABI surface; the transport
   * choice determines which underlying SGBD apiJob naming the IPO
   * resolves to.
   */
  ipoPath: string;
  /** ECU SGBD basename (returned by CDHGetSgbdName, used by apiJob). */
  sgbd: string;
  /** EDIABAS provider (mock or real). */
  ediabas: IEdiabasProvider;
  /**
   * Default cabd-pars seeded before every job. Per-job overrides
   * in the operation calls take precedence.
   */
  cabdPars?: FscCabdParPreseeds;
}

/**
 * Result envelope for every FSC operation. `ok` mirrors the IPO's
 * happy path; `error` is populated when the IPO took the
 * API_RESULT_CODE / API_RESULT error branch OR when an
 * EDIABAS-layer exception bubbled up.
 */
export interface FscResult<T = void> {
  /** `true` iff lastJob.status === "OKAY" and no exception fired. */
  ok: boolean;
  /** Mirrors lastJob.status — "OKAY" on success, "" or error string otherwise. */
  jobStatus: string;
  /**
   * Populated on the error path — IPO published API_RESULT_CODE
   * + API_RESULT cabd-pars before exiting.
   */
  error?: {
    code: string;
    message: string;
  };
  /** Job-specific structured data (e.g. `{vin: string}` for getVin). */
  data?: T;
  /** Full cabd-par store for advanced inspection. */
  cabdPars: Map<string, string>;
}

/** Returned by `getVin()`. */
export interface VinData {
  /** Vehicle Identification Number — 17-char ISO 3779 string. */
  vin: string;
}

/** Returned by `getTime()`. */
export interface TimeData {
  /**
   * Raw TIME cabd-par as the IPO surfaces it. Format is BMW-internal
   * "YYYYMMDDhhmmZ"-ish, but the IPO does no parsing — passes the
   * host-seeded value through unchanged. `"000000000000Z"` when the
   * host didn't seed one (epoch default).
   */
  time: string;
}

/** Returned by `getFsStatus()`. */
export interface FsStatusData {
  /** Raw integer status reported by FLASH_PROGRAMMIER_STATUS_LESEN. */
  status: number;
}
