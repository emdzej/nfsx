/**
 * `Ms45Session` — probe / read / write orchestration for MS45 DMEs.
 *
 * Consumes an already-connected `IEdiabas` (typically obtained via
 * `EdiabasXProvider.getEdiabas()` after the shared ediabasx setup
 * used elsewhere in nfsx), plus the SGBD name to dispatch against
 * (`D_Motor` groups both MS45.0 and MS45.1; the SGBD auto-resolves
 * to `MS450DS0.prg` / `10MDS45.prg` at first job).
 *
 * The read/write flow mirrors the reference flasher's choreography:
 *
 *   probe:
 *     identifyDme                         (no auth)
 *
 *   readFlash:
 *     identifyDme
 *     requestSecurityAccess
 *     enterProgrammingMode
 *     readMemory (ROMX and/or LAR)
 *     leaveProgrammingMode
 *
 *   writeFlash:
 *     identifyDme
 *     requestSecurityAccess
 *     enterProgrammingMode
 *     suspendNormalTraffic       (BMW-FAST only)
 *     eraseRegion
 *     applyChecksums + signature to the payload
 *     flashBlock (tune: 1 block; full: 2 blocks — external + MPC)
 *     leaveProgrammingMode
 *     verifyFlashSignature       (Daten;64 or Programm;64)
 *     resetEcu
 *
 * Every stage emits a progress event so the CLI can render a
 * running commentary. Errors surface as either `Ms45JobError`
 * (from `runJob`) or `Ms45SessionError` (session-level guard rails
 * like size checks on the payload).
 */

import type { IEdiabas } from '@emdzej/ediabasx-core';
import {
  identifyDme,
  isBmwFast,
  type DmeIdent,
} from './ident.js';
import { requestSecurityAccess, type AuthRandomSource } from './auth-flow.js';
import {
  enterProgrammingMode,
  leaveProgrammingMode,
  suspendNormalTraffic,
} from './session-control.js';
import { readMemory } from './read-memory.js';
import {
  eraseRegion,
  ERASE_TUNE,
  ERASE_PROGRAM,
  type EraseTarget,
} from './erase.js';
import {
  flashBlock,
  FLASH_TUNE,
  FLASH_PROGRAM,
  FLASH_MPC,
} from './flash-block.js';
import {
  verifyFlashSignature,
  flashProgrammingStatus,
  resetEcu,
} from './verify.js';
import {
  rewriteParameterChecksum,
  rewriteProgramChecksum,
} from './checksum.js';
import {
  rewriteParameterSignature,
  rewriteProgramSignature,
} from './signature.js';
import {
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  TUNE_BLOB_SIZE,
  PROGRAM_BLOB_HOST_OFFSET,
  PROGRAM_BLOB_SIZE,
  TUNE_BLOB_HOST_OFFSET,
} from './regions.js';

// ── config + types ─────────────────────────────────────────────────

export interface Ms45SessionConfig {
  /** Already-connected IEdiabas. Caller owns lifecycle. */
  ediabas: IEdiabas;
  /** SGBD name to dispatch against — usually `"D_Motor"`. */
  sgbd: string;
  /** Optional deterministic RNG for the security-access userID (tests). */
  random?: AuthRandomSource;
}

export type Ms45Stage =
  | 'ident'
  | 'auth'
  | 'enter-progmode'
  | 'suspend-traffic'
  | 'erase'
  | 'write-tune'
  | 'write-program'
  | 'write-mpc'
  | 'leave-progmode'
  | 'programming-status'
  | 'verify-signature'
  | 'reset'
  | 'read-external'
  | 'read-mpc'
  | 'done';

export interface Ms45Progress {
  stage: Ms45Stage;
  message: string;
  /** 0..1 within-stage progress. Absent means "atomic step". */
  fraction?: number;
}

export type Ms45ProgressFn = (p: Ms45Progress) => void;

export class Ms45SessionError extends Error {
  constructor(message: string, public readonly stage: Ms45Stage) {
    super(`ms45 ${stage}: ${message}`);
    this.name = 'Ms45SessionError';
  }
}

// ── probe ──────────────────────────────────────────────────────────

/** Identity probe. No auth, no destructive operations, safe to call anytime. */
export async function probe(config: Ms45SessionConfig): Promise<DmeIdent> {
  return identifyDme(config.ediabas, config.sgbd);
}

// ── read ───────────────────────────────────────────────────────────

export type ReadMode = 'tune' | 'full';

export interface ReadFlashOptions {
  mode: ReadMode;
  progress?: Ms45ProgressFn;
  /** Skip the identify step and use this pre-fetched ident. */
  ident?: DmeIdent;
}

export type ReadFlashResult =
  | { mode: 'tune'; ident: DmeIdent; tune: Uint8Array }
  | { mode: 'full'; ident: DmeIdent; external: Uint8Array; mpc: Uint8Array };

export async function readFlash(
  config: Ms45SessionConfig,
  options: ReadFlashOptions,
): Promise<ReadFlashResult> {
  const { ediabas, sgbd } = config;
  const progress = options.progress ?? (() => {});

  progress({ stage: 'ident', message: 'identifying DME' });
  const ident = options.ident ?? (await probe(config));

  progress({ stage: 'auth', message: 'requesting security access' });
  await requestSecurityAccess(ediabas, sgbd, { random: config.random });

  progress({ stage: 'enter-progmode', message: 'entering programming mode' });
  await enterProgrammingMode(ediabas, sgbd, ident.diagProtocol);

  try {
    if (options.mode === 'tune') {
      progress({ stage: 'read-external', message: 'reading tune (ROMX)', fraction: 0 });
      const tune = await readMemory(ediabas, sgbd, {
        segment: 'ROMX',
        start: TUNE_BLOB_HOST_OFFSET,
        end: TUNE_BLOB_HOST_OFFSET + TUNE_BLOB_SIZE - 1,
        onProgress: (n, t) =>
          progress({ stage: 'read-external', message: 'reading tune', fraction: n / t }),
      });
      return { mode: 'tune', ident, tune };
    }

    // full-mode: read both external + MPC
    progress({ stage: 'read-external', message: 'reading external flash', fraction: 0 });
    const external = await readMemory(ediabas, sgbd, {
      segment: 'ROMX',
      start: 0,
      end: EXTERNAL_FLASH_SIZE - 1,
      onProgress: (n, t) =>
        progress({
          stage: 'read-external',
          message: 'reading external flash',
          fraction: n / t,
        }),
    });

    progress({ stage: 'read-mpc', message: 'reading MPC flash', fraction: 0 });
    const mpc = await readMemory(ediabas, sgbd, {
      segment: 'LAR',
      start: 0,
      end: MPC_FLASH_SIZE - 1,
      onProgress: (n, t) =>
        progress({ stage: 'read-mpc', message: 'reading MPC flash', fraction: n / t }),
    });

    return { mode: 'full', ident, external, mpc };
  } finally {
    progress({ stage: 'leave-progmode', message: 'restoring diagnostic session' });
    await leaveProgrammingMode(ediabas, sgbd, ident.diagProtocol).catch(() => {
      // Never mask the original error — swallow leave-progmode failures.
    });
    progress({ stage: 'done', message: 'read complete' });
  }
}

// ── write ──────────────────────────────────────────────────────────

export type WriteMode = 'tune' | 'full';

export interface WriteCommonOptions {
  progress?: Ms45ProgressFn;
  ident?: DmeIdent;
  /** Do not recompute CRC-32 checksums before flashing. Default: false (recompute). */
  skipChecksum?: boolean;
  /** Do not recompute RSA signatures before flashing. Default: false (recompute). */
  skipSign?: boolean;
  /** Skip the post-flash `FLASH_SIGNATUR_PRUEFEN` step. Default: false. */
  skipVerify?: boolean;
}

export type WriteFlashOptions =
  | (WriteCommonOptions & { mode: 'tune'; tune: Uint8Array })
  | (WriteCommonOptions & { mode: 'full'; external: Uint8Array; mpc: Uint8Array });

export interface WriteFlashResult {
  ident: DmeIdent;
  /** Programming status text read after the flash completes. */
  programmingStatus: string | null;
}

export async function writeFlash(
  config: Ms45SessionConfig,
  options: WriteFlashOptions,
): Promise<WriteFlashResult> {
  const { ediabas, sgbd } = config;
  const progress = options.progress ?? (() => {});

  // ── validate payload up front (before any wire I/O) ────────────
  if (options.mode === 'tune') {
    if (options.tune.length !== TUNE_BLOB_SIZE) {
      throw new Ms45SessionError(
        `tune payload must be ${TUNE_BLOB_SIZE} bytes, got ${options.tune.length}`,
        'write-tune',
      );
    }
  } else {
    if (options.external.length !== EXTERNAL_FLASH_SIZE) {
      throw new Ms45SessionError(
        `external payload must be ${EXTERNAL_FLASH_SIZE} bytes, got ${options.external.length}`,
        'write-program',
      );
    }
    if (options.mpc.length !== MPC_FLASH_SIZE) {
      throw new Ms45SessionError(
        `mpc payload must be ${MPC_FLASH_SIZE} bytes, got ${options.mpc.length}`,
        'write-mpc',
      );
    }
  }

  progress({ stage: 'ident', message: 'identifying DME' });
  const ident = options.ident ?? (await probe(config));

  progress({ stage: 'auth', message: 'requesting security access' });
  await requestSecurityAccess(ediabas, sgbd, { random: config.random });

  progress({ stage: 'enter-progmode', message: 'entering programming mode' });
  await enterProgrammingMode(ediabas, sgbd, ident.diagProtocol);

  progress({ stage: 'suspend-traffic', message: 'suspending normal traffic' });
  await suspendNormalTraffic(ediabas, sgbd, ident.diagProtocol);

  let programmingStatus: string | null = null;
  let releaseNeeded = true;
  try {
    const eraseTarget: EraseTarget = options.mode === 'tune' ? ERASE_TUNE : ERASE_PROGRAM;
    progress({ stage: 'erase', message: 'erasing flash region' });
    await eraseRegion(ediabas, sgbd, eraseTarget);

    if (options.mode === 'tune') {
      // Prepare the payload as a mutable copy so we can rewrite CRC + sig.
      const payload = new Uint8Array(options.tune);
      if (!options.skipChecksum) rewriteParameterChecksum(payload);
      if (!options.skipSign) rewriteParameterSignature(payload);

      progress({ stage: 'write-tune', message: 'writing tune blob', fraction: 0 });
      await flashBlock(ediabas, sgbd, FLASH_TUNE, payload, {
        onProgress: (n, t) =>
          progress({ stage: 'write-tune', message: 'writing tune blob', fraction: n / t }),
      });
    } else {
      const external = new Uint8Array(options.external);
      const mpc = new Uint8Array(options.mpc);
      // Program checksums first — sig hashes the segments AFTER their CRC
      // has been recomputed (the CRC lives outside every signed segment
      // in stock firmware, but rewriting CRC first is the reference
      // flasher's ordering; keep parity).
      if (!options.skipChecksum) rewriteProgramChecksum(external, mpc);
      if (!options.skipSign) rewriteProgramSignature(external, mpc);

      const programSlice = external.subarray(
        PROGRAM_BLOB_HOST_OFFSET,
        PROGRAM_BLOB_HOST_OFFSET + PROGRAM_BLOB_SIZE,
      );

      progress({ stage: 'write-program', message: 'writing external program', fraction: 0 });
      await flashBlock(ediabas, sgbd, FLASH_PROGRAM, programSlice, {
        onProgress: (n, t) =>
          progress({
            stage: 'write-program',
            message: 'writing external program',
            fraction: n / t,
          }),
      });

      progress({ stage: 'write-mpc', message: 'writing MPC flash', fraction: 0 });
      await flashBlock(ediabas, sgbd, FLASH_MPC, mpc, {
        onProgress: (n, t) =>
          progress({ stage: 'write-mpc', message: 'writing MPC flash', fraction: n / t }),
      });
    }

    // Leave programming mode BEFORE the signature check — that's how
    // the reference flasher orders it (the DME verifies in default
    // diag mode, and the K-line/CAN link is already back at nominal
    // baud + traffic when the CHECK job dispatches).
    progress({ stage: 'leave-progmode', message: 'restoring diagnostic session' });
    await leaveProgrammingMode(ediabas, sgbd, ident.diagProtocol);
    releaseNeeded = false;

    progress({ stage: 'programming-status', message: 'reading flash programming status' });
    programmingStatus = await flashProgrammingStatus(ediabas, sgbd);

    if (!options.skipVerify) {
      progress({ stage: 'verify-signature', message: 'verifying flash signature' });
      await verifyFlashSignature(
        ediabas,
        sgbd,
        options.mode === 'tune' ? 'tune' : 'program',
      );
      // Refresh the programming status after the signature check —
      // reference flasher does this; the second read reflects the
      // ECU's post-verify state.
      programmingStatus = await flashProgrammingStatus(ediabas, sgbd);
    }

    progress({ stage: 'reset', message: 'resetting DME' });
    await resetEcu(ediabas, sgbd);

    progress({ stage: 'done', message: 'flash complete' });
    return { ident, programmingStatus };
  } catch (err) {
    // Best-effort: on any mid-flight failure, try to leave prog mode
    // so the ECU isn't stuck at 115200 with the K-line UART on the
    // host still at the raised baud. Never mask the original error.
    if (releaseNeeded) {
      try {
        if (!isBmwFast(ident.diagProtocol)) {
          // For DS2 the host also needs a baud reset to talk to the ECU
          // at all in a subsequent recovery attempt.
          await leaveProgrammingMode(ediabas, sgbd, ident.diagProtocol);
        }
      } catch {
        /* swallow */
      }
    }
    throw err;
  }
}
