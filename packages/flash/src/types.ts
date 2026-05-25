/**
 * Public types for `@emdzej/nfsx-flash` — the host-side
 * flash-programming orchestrator.
 *
 * Lifecycle:
 *
 *   1. Caller constructs a `FlashSession` with config (target ECU,
 *      flash binary path, EDIABAS provider, etc.).
 *   2. Caller calls `session.run({dryRun, confirm})`. The session
 *      walks the 7-stage pipeline (see `Stage` below), emitting
 *      events at each transition.
 *   3. Session resolves with a `FlashResult` summarising what
 *      happened — stage completion, bytes transferred, ECU resets,
 *      any errors that aborted mid-flight.
 *
 * Default options are **safe** — `dryRun: true` so a misuse can't
 * actually write to an ECU. Destructive operation requires explicit
 * opt-in (`{dryRun: false}`) AND, by default, per-stage confirmation
 * via the `confirm` callback.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { MemoryRegion } from '@emdzej/nfsx-flash-data';

/**
 * The 7-stage flash pipeline. Stages run in this order; abort is
 * safe before SESSION (stage 4) — afterwards the ECU is in
 * programming mode and the only sane recovery is to finish.
 */
export type Stage =
  | 'RESOLVE'        // SP-Daten lookup: HWNR + ZBN → IPO + SGBD
  | 'PRECHECK'       // battery / ignition / FSC / ECU comms sanity
  | 'AUTHENTICATE'   // UDS 0x27 SecurityAccess (seed → key)
  | 'SESSION'        // UDS 0x10 0x02 — switch to programming mode
  | 'TRANSFER'       // UDS 0x34 / 0x36 / 0x37 — block transfer
  | 'AIF_WRITE'      // post-flash identity stamp write
  | 'POSTCHECK';     // ECU reset, verify status

/** Per-ECU descriptor needed by the orchestrator. */
export interface EcuTarget {
  /** SGBD basename for apiJob dispatch (e.g. `C_DSC_KWP`). */
  sgbd: string;
  /** Diagnostic address (`0x6A` etc) — for logging + audit only. */
  diagAddr?: number;
  /**
   * Path to the FSC/cert/SWT IPO (`00swt{ds2|dsc|eps|kwp|kws|msd}.ipo`).
   * Used by PRECHECK for `CHECK_FSC` and similar.
   */
  swtIpoPath: string;
}

/**
 * Pre-flash safety thresholds. Defaults are conservative — operator
 * can relax for lab testing.
 */
export interface PrecheckOptions {
  /** Minimum battery voltage required (V). Default 12.5. */
  minBatteryVoltage?: number;
  /** Skip individual checks (lab/test use). Never skip in production. */
  skip?: ReadonlyArray<'battery' | 'ignition' | 'ecu_comms' | 'fsc'>;
}

/**
 * Authentication strategy — produces a key from a seed. The actual
 * BMW algorithm is ECU-specific and lives in the SGBD's `.PRG` file
 * (BMW-internal, not bundled with nfsx). Callers supply their own
 * strategy:
 *
 *   - `PassthroughKeyDerivation` (default) — returns the seed as
 *     the key. Useful only when the ECU has security access disabled.
 *   - Custom — implement `KeyDerivationStrategy` per ECU type.
 *
 * Note: a real production flash needs the actual algorithm. Without
 * it the AUTHENTICATE stage will fail when the ECU rejects the wrong
 * key, which is the correct behaviour — better to fail at auth than
 * to risk a partial flash.
 */
export interface KeyDerivationStrategy {
  /** Human-readable label for trace output. */
  readonly name: string;
  /** Compute the key bytes from the seed bytes the ECU sent. */
  derive(seed: Uint8Array, ecu: EcuTarget): Promise<Uint8Array> | Uint8Array;
}

/**
 * Transfer-protocol customisation. Defaults work for most KWP2000
 * ECUs; per-ECU tweaks (different block size, different SGBD job
 * names) override individual fields.
 */
export interface TransferOptions {
  /**
   * SGBD job name for RequestDownload (UDS 0x34). Default
   * `FLASH_PROGRAMMIEREN_START`.
   */
  requestDownloadJob?: string;
  /**
   * SGBD job name for TransferData (UDS 0x36). Default
   * `FLASH_PROGRAMMIEREN_BLOCK`.
   */
  transferDataJob?: string;
  /**
   * SGBD job name for RequestTransferExit (UDS 0x37). Default
   * `FLASH_PROGRAMMIEREN_ENDE`.
   */
  requestTransferExitJob?: string;
  /**
   * Block size override. When unset, queries the SGBD's
   * RequestDownload response for the max block size.
   * Default fallback when neither is available: 256 bytes.
   */
  blockSize?: number;
  /**
   * How many retries per block on a transient error (NRC 0x21
   * BusyRepeatRequest, 0x23 ConditionsNotCorrect). Default 1.
   */
  maxRetries?: number;
}

/** Top-level options for `FlashSession.run`. */
export interface RunOptions {
  /**
   * When `true` (the default), no actual ECU writes occur. The
   * RESOLVE + PRECHECK stages still run for real (they're
   * read-only); destructive stages (AUTHENTICATE / SESSION /
   * TRANSFER / AIF_WRITE) are simulated by no-ops that emit the
   * same events as the real path.
   */
  dryRun?: boolean;
  /**
   * Called before each destructive stage. Return `true` to proceed,
   * `false` to abort. Default rejects everything — set explicitly
   * to confirm.
   *
   * Never called when `dryRun: true`.
   */
  confirm?: (stage: Stage, ctx: ConfirmContext) => Promise<boolean> | boolean;
}

/** Context passed to `confirm` before each destructive stage. */
export interface ConfirmContext {
  ecu: EcuTarget;
  /** Aggregate size of the firmware about to be transferred. */
  totalBytes?: number;
  /** Region count (number of contiguous chunks). */
  regionCount?: number;
}

/**
 * Event payloads — the session emits these via an `EventTarget`
 * pattern; subscribe via `session.on('progress', handler)`.
 */
export type FlashEvent =
  | { type: 'stage:start'; stage: Stage }
  | { type: 'stage:done'; stage: Stage; durationMs: number }
  | { type: 'stage:skipped'; stage: Stage; reason: string }
  | {
      type: 'block:transferred';
      blockIndex: number;
      totalBlocks: number;
      bytesSent: number;
      bytesTotal: number;
      address: number;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Final result. */
export interface FlashResult {
  /** All stages completed successfully. */
  ok: boolean;
  /** Stages that ran (in execution order). */
  stagesRun: Stage[];
  /** Stage that aborted, if any. */
  abortedAt?: Stage;
  /** Why the abort happened. */
  abortReason?: string;
  /** Bytes successfully transferred (TRANSFER stage). */
  bytesTransferred: number;
  /** Total bytes in the firmware payload. */
  totalBytes: number;
  /** Whether this run was dry-run (no actual ECU writes). */
  dryRun: boolean;
  /** Full event log. */
  events: FlashEvent[];
}

/** Input descriptor for a flash session. */
export interface FlashSessionOptions {
  ecu: EcuTarget;
  /** Firmware to flash — either S37 file bytes or already-parsed regions. */
  firmware: { regions: MemoryRegion[] } | { s37Bytes: Uint8Array };
  ediabas: IEdiabasProvider;
  precheck?: PrecheckOptions;
  transfer?: TransferOptions;
  keyDerivation?: KeyDerivationStrategy;
}
