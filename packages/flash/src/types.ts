/**
 * Public types for `@emdzej/nfsx-flash` — the host-side
 * flash-programming orchestrator.
 *
 * **Architectural model (2026-05-27 rewrite, mirrors WinKFP's
 * `coapiKfProgSgD2`):**
 *
 * The flash is a single IPO dispatch of `SG_PROGRAMMIEREN`. The IPO
 * encapsulates every wire-level concern (security access, programming-
 * session entry, block transfer, post-flash verification). The host's
 * job is to:
 *
 *   1. Validate the target ECU's identity vs. SP-Daten
 *   2. Capture an audit backup
 *   3. Seed the right cabd-pars (DOMINANTE, BSUTIME, PROG_WITH_AIF,
 *      optionally AIF_*)
 *   4. Dispatch SG_PROGRAMMIEREN
 *   5. Verify the ECU still responds afterwards
 *
 * Pipeline:
 *
 *   RESOLVE   — parse the .0PA/.0DA firmware file for integrity check
 *               (does NOT pass bytes to the IPO; the IPO reads files
 *               via CABF* file-IO syscalls).
 *   PRECHECK  — IPO-driven discovery (HW_REFERENZ + SG_STATUS_LESEN +
 *               SG_IDENT_LESEN + SG_AIF_LESEN + ZIF + FSC + hwnr match).
 *   BACKUP    — IPO-driven audit snapshot via ZIF_BACKUP + identity reads,
 *               persisted as JSON. NOT a brick-recovery image — see
 *               docs/architecture.md §11.6.
 *   PROGRAM   — single SG_PROGRAMMIEREN IPO dispatch. Optional inline
 *               AIF write via PROG_WITH_AIF=1.
 *   POSTCHECK — re-read HW_REFERENZ + SG_IDENT_LESEN, verify ECU still
 *               answers + reports the new identity.
 *
 * Pre-2026-05-27 design notes: the previous pipeline had explicit
 * AUTHENTICATE / SESSION / TRANSFER / AIF_WRITE stages implementing
 * UDS 0x27/0x10/0x34/0x36/0x37 directly on the wire. That was
 * architecturally wrong — WinKFP delegates all of that to the IPO.
 * The wire-level modules (`auth.ts`, `transfer.ts`, `aif-write.ts`)
 * were removed in the rewrite.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { MemoryRegion } from '@emdzej/nfsx-flash-data';

/** Flash pipeline stages. */
export type Stage =
  | 'RESOLVE'    // SP-Daten lookup + firmware-file integrity parse
  | 'PRECHECK'   // IPO-driven discovery + identity check (see precheck.ts)
  | 'BACKUP'     // IPO-driven audit snapshot (see backup.ts)
  | 'PROGRAM'    // single SG_PROGRAMMIEREN IPO dispatch (see prog-sg.ts)
  | 'POSTCHECK'; // ECU still-alive sanity reads after PROGRAM

/** Per-ECU descriptor needed by the orchestrator. */
export interface EcuTarget {
  /** SGBD basename for apiJob dispatch (e.g. `10GD20`). */
  sgbd: string;
  /** Diagnostic address (`0x6A` etc) — for logging + audit only. */
  diagAddr?: number;
  /**
   * Path to the target SG's IPO (`10GD20.ipo`, `16ACC65.ipo`, etc.).
   * Used by PRECHECK / BACKUP / PROGRAM / POSTCHECK — every cabimain
   * dispatch routes through this IPO. The IPO embeds all chassis-
   * specific bus knowledge (which SGBD job to invoke, which result
   * names to expect, when to dispatch SEED_KEY, etc.).
   */
  ipoPath: string;
  /**
   * Path to the FSC/cert/SWT IPO (`00swt{ds2|dsc|eps|kwp|kws|msd}.ipo`).
   * Used by PRECHECK's FSC check (via `@emdzej/nfsx-fsc`).
   */
  swtIpoPath: string;
  /**
   * Working directory for IPO file I/O — the IPO references `.0PA` /
   * `.0DA` / `.HIS` / `.DAT` / `.HWH` / `.DIR` files by basename via
   * the `fileopen` / `fileread` / `filewrite` / `fileclose` syscalls.
   *
   * For SP-Daten this is `<spDaten>/data/<SG_TYP>/`. Required for the
   * PROGRAM stage (SG_PROGRAMMIEREN reads `.0PA`/`.0DA` from disk);
   * optional for PRECHECK / BACKUP, which generally don't touch files.
   */
  workingDir?: string;
  /**
   * Optional: expected HWNR for cross-checking `ID_BMW_NR` from
   * `SG_IDENT_LESEN`. When set + the values disagree, PRECHECK fails.
   */
  expectedHwnr?: string;
}

/**
 * Pre-flash checks — see `precheck.ts`. Each skip key maps to one
 * cabimain dispatch.
 */
export interface PrecheckOptions {
  skip?: ReadonlyArray<
    'hw_referenz' | 'sg_status' | 'sg_ident' | 'sg_aif' | 'hwnr_match' | 'fsc'
  >;
}

/**
 * Backup options — see `backup.ts`. Captures an audit snapshot
 * before any destructive operation.
 */
export interface BackupOptions {
  /** Output directory. */
  outputDir?: string;
  /** Filename override. Default: `<HWNR>-<ZB>-<timestamp>.json`. */
  filename?: string;
  /** When `true`, skip the BACKUP stage entirely. Default `false`. */
  skip?: boolean;
}

/**
 * Top-level options for `FlashSession.run`. Destructive stages
 * (PROGRAM) are gated by both `dryRun: false` AND `confirm` returning
 * `true`. The defaults are intentionally safe.
 */
export interface RunOptions {
  /**
   * When `true` (the default), the PROGRAM stage is simulated — no
   * actual IPO dispatch. RESOLVE / PRECHECK / BACKUP / POSTCHECK still
   * run for real (they're read-only).
   */
  dryRun?: boolean;
  /**
   * Called before the PROGRAM stage in non-dry-run mode. Return `true`
   * to proceed, `false` to abort. Default rejects everything.
   */
  confirm?: (stage: Stage, ctx: ConfirmContext) => Promise<boolean> | boolean;
}

/** Context passed to `confirm` before the PROGRAM stage. */
export interface ConfirmContext {
  ecu: EcuTarget;
  /** Aggregate size of the firmware about to be flashed (informational). */
  totalBytes?: number;
  /** Region count from the .0PA/.0DA parse (informational). */
  regionCount?: number;
}

/**
 * Event payloads — the session emits these via an `EventTarget`
 * pattern; subscribe via `session.on('event', cb)`.
 */
export type FlashEvent =
  | { type: 'stage:start'; stage: Stage }
  | { type: 'stage:done'; stage: Stage; durationMs: number }
  | { type: 'stage:skipped'; stage: Stage; reason: string }
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
  /** Path to the BACKUP JSON, if BACKUP ran. */
  backupPath?: string;
  /** Total bytes in the firmware payload (from RESOLVE). */
  totalBytes: number;
  /** Whether this run was dry-run (no actual ECU writes). */
  dryRun: boolean;
  /** Full event log. */
  events: FlashEvent[];
}

/** Input descriptor for a flash session. */
export interface FlashSessionOptions {
  ecu: EcuTarget;
  /**
   * Firmware — parsed for integrity in RESOLVE but NOT passed to the
   * IPO. The IPO reads the actual `.0PA`/`.0DA` from disk via CABF*
   * syscalls (see [[inpax-cabf-syscalls]] for the open question).
   */
  firmware: { regions: MemoryRegion[] } | { s37Bytes: Uint8Array } | { paDaBytes: Uint8Array };
  ediabas: IEdiabasProvider;
  precheck?: PrecheckOptions;
  backup?: BackupOptions;
  /** Cabd-pars + AIF metadata for the SG_PROGRAMMIEREN dispatch. */
  program?: import('./prog-sg.js').ProgramOptions;
}
