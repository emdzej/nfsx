/**
 * NCSEXPER-style system-function overrides for the inpax VM, driven
 * by the authoritative `NCSEXPER_CABI_SLOTS` table from
 * `@emdzej/ncsx-inpax-cabi-provider`.
 *
 * Each NFS IPO calls slots by numeric ID (e.g. `CALL sys 0x0F`). The
 * slot table maps ID → `(name, CABI-param-list)`. The IPO pushes args
 * top-down in declaration order, so the override pops LIFO (reverse
 * declaration order). Using the metadata for pop order eliminates the
 * hand-rolled signature guesswork that caused the HW_REFERENZ stack
 * corruption: the result-readers and `CDHGetSgbdName` have their
 * out-refs as the *first* params (bottom of stack), not the last —
 * the old code popped refs first and silently corrupted the stack.
 *
 * For HW_REFERENZ / Ident / AifLesen we only need the read-path slots
 * (CDHapi*, error mgmt, CABD/system-data, error scratchpad). Other
 * slots in the 99-entry NCSEXPER table get a default pop-and-no-op
 * via `defaultOverride` so the stack stays balanced.
 *
 * Once the flash-programming path (Phase 5) lights up, NFS-specific
 * slots (flash block transfer, FSC, AIF protocol) will need their own
 * overrides — those live in `winkfpt.exe`'s slot table, not NCSEXPER's.
 */

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { ExecutionContext, VM } from '@emdzej/inpax-interpreter';
import { StackEntryFlags, ValueType, type StackEntry, type Value } from '@emdzej/inpax-core';
import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import {
  NCSEXPER_CABI_SLOTS,
  type CabiParam,
  type CabiSlot,
} from '@emdzej/ncsx-inpax-cabi-provider';
import type { CabiState } from './state.js';

type SystemFunctionOverride = (
  ctx: ExecutionContext,
  vm: VM,
) => void | Promise<void>;

const NCSEXPER_SUCCESS = 0;

export interface BuildSystemFunctionsOptions {
  ediabas?: IEdiabasProvider;
  defaultSgbd?: string;
  /**
   * Working directory for IPO file I/O. The IPO references files by
   * basename (e.g. `7544721A.0PA`); we resolve relative paths under
   * this dir + reject anything that escapes it.
   *
   * For a flash session this is typically `<spDaten>/data/<SG_TYP>/`.
   * Unset = filesystem ops fail at the open call (safer default than
   * accidentally opening `process.cwd()`-relative paths).
   *
   * See [[feedback-sg-programmieren-primitive]] for context — SG_PROGRAMMIEREN
   * needs this set to find the `.0PA`/`.0DA` files referenced from
   * KFCONF + ZB-NR table.
   */
  workingDir?: string;
  /**
   * Firmware-record iterator the IPO's flash loop pops from via slot
   * 0x55 (`CDHGetApiJobByteData`). NFS reuses that slot — NCSEXPER's
   * "drain SGBD result" label is wrong here. The iterator hands back
   * one record at a time (`bytes` plus `eof` flag); when set, the
   * slot 0x55 handler ignores its NCSEXPER-style SGBD-result lookup
   * and reads from this source instead.
   *
   * Verified via winkfpt Ghidra walk 2026-05-27 — the host opens
   * `.0PA` via `datDekompOpen` (FUN_00468220) before dispatching
   * SG_PROGRAMMIEREN; slot 0x55 calls `dlReadRecord` (FUN_0046c510)
   * each time the IPO wants the next record.
   */
  firmwareSource?: FirmwareSource;
  /**
   * Maximum *retries* for a single CDHapiJobData (slot 0x0E) binary
   * dispatch — i.e. number of *additional* attempts after a transient
   * failure. Total attempts = `maxBinaryRetries + 1`. Default `2`
   * → 3 total attempts.
   *
   * A retry is triggered when EITHER:
   *   - `ed.executeJob` threw (wire / transport error), or
   *   - the returned `JOB_STATUS` is in `retryableStatuses`.
   *
   * BMW SGBDs are idempotent for flash writes: a failed
   * `FLASH_SCHREIBEN` reports `ERROR_WRITE_DATA` *before* committing
   * any change to the flash region, so re-dispatching the same chunk
   * is always safe. WinKFP almost certainly does the same — over
   * K+DCAN at 9600 baud, transient UART corruption gives a ~0.5-1%
   * per-dispatch failure rate; retrying drops the residual to ~10⁻⁶.
   */
  maxBinaryRetries?: number;
  /**
   * Job-status values that trigger a retry of the binary dispatch.
   * Default: `ERROR_WRITE_DATA`, `ERROR_INVALID_BIN_BUFFER`. The
   * second one is included because bit-flip corruption in the
   * outbound bytes makes the SGBD's structural check fail.
   */
  retryableStatuses?: ReadonlySet<string>;
  /**
   * Milliseconds to wait between binary-dispatch retries. Default
   * `200`. Bench evidence (GS20 over K+DCAN @ 9600): zero-backoff
   * retries reproduce the original failure 100% of the time; ~200 ms
   * lets the wire drain and the ECU clear its internal failed-write
   * state before the next attempt. Tune lower (50-100 ms) for
   * faster transports or higher (300-500 ms) on flaky cables.
   */
  retryBackoffMs?: number;
}

/**
 * One-shot, stateful iterator over a host-opened firmware archive
 * (`.0PA`). The IPO drives a `while (NrOfData > 0)` loop and pops
 * one record per call. Implementations choose how to chunk the
 * archive — by parsed BMW records, by fixed-size windows, etc. —
 * as long as each chunk fits within the SGBD's `BLOCKLAENGE_MAX`.
 */
export interface FirmwareSource {
  /**
   * Pop the next record from the firmware. `maxBytes` is the SGBD's
   * `BLOCKLAENGE_MAX` — the IPO will reject a chunk that exceeds it.
   *
   * Return `{ bytes, eof: false }` on a successful pop. Return
   * `{ bytes: Uint8Array(0), eof: true }` when the source is
   * exhausted — the IPO interprets that as the loop terminator.
   *
   * Stateful — called repeatedly from the same FlashSession run.
   */
  nextChunk(maxBytes: number): { bytes: Uint8Array; eof: boolean };
}

export function buildSystemFunctions(
  state: CabiState,
  opts: BuildSystemFunctionsOptions = {},
): Map<number, SystemFunctionOverride> {
  const map = new Map<number, SystemFunctionOverride>();
  for (const slot of NCSEXPER_CABI_SLOTS) {
    map.set(slot.id, makeOverride(slot, state, opts));
  }
  return map;
}

/** Default statuses the binary-dispatch retry loop treats as transient. */
const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<string> = new Set([
  'ERROR_WRITE_DATA',
  'ERROR_INVALID_BIN_BUFFER',
]);

function makeOverride(
  slot: CabiSlot,
  state: CabiState,
  opts: BuildSystemFunctionsOptions,
): SystemFunctionOverride {
  const ediabas = opts.ediabas;
  const defaultSgbd = opts.defaultSgbd ?? '';
  const maxBinaryRetries = opts.maxBinaryRetries ?? 2;
  const retryableStatuses = opts.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
  // 200 ms default: bench evidence (trace6 on GS20, K+DCAN @ 9600)
  // showed that zero-backoff retries fail with the same status as
  // the original attempt 100% of the time — the ECU / wire needs a
  // settle period after a failed write before it'll accept a new
  // one. 200 ms is empirically enough; smaller values may still
  // fail. See docs/architecture.md §11.14.
  const retryBackoffMs = opts.retryBackoffMs ?? 200;

  switch (slot.name) {
    // ── Flow control ─────────────────────────────────────────────────
    case 'exit':
      // NCSEXPER's RET-equivalent at the script level. Must halt the
      // VM — without `vm.stop()` the IPO's error-path `exit` is a
      // no-op and execution falls through into the happy path, which
      // runs with stale/empty result data. Real NFS IPOs like
      // IdentLesen / AifLesen rely on this for clean termination.
      return (ctx, vm) => {
        popArgs(ctx, slot.params);
        state.trace.push({ slot: slot.id, name: slot.name, args: {} });
        vm.stop();
      };

    // ── setjobstatus(in int JobStatus) — slot 0x0B in INPA, 0x0A here
    // (NCSEXPER's `simdigital`). Not in NFS read paths but harmless
    // through default handling.

    // ── EDIABAS bridge ──────────────────────────────────────────────
    case 'CDHapiInit':
      return () => {
        state.trace.push({ slot: slot.id, name: slot.name, args: {} });
      };

    case 'CDHapiEnd':
      return () => {
        state.trace.push({ slot: slot.id, name: slot.name, args: {} });
      };

    case 'CDHapiJob':
      return async (ctx) => {
        const args = popArgs(ctx, slot.params);
        const ecu = String(args.ecu || defaultSgbd);
        const job = String(args.job);
        const para = String(args.para);
        const result = String(args.result);
        state.trace.push({ slot: slot.id, name: slot.name, args: { ecu, job, para, result } });
        if (!ediabas) {
          state.lastJob = { ecu, job, para, status: 'NO_EDIABAS', ok: false };
          return;
        }
        // String-mode dispatch — provider's result cache becomes the
        // authoritative source, so clear any binary-path cache from a
        // prior `CDHapiJobData` call.
        state.lastJobSets = undefined;
        try {
          await ediabas.job(ecu, job, para, result);
          const status = readJobStatus(ediabas);
          state.lastJob = { ecu, job, para, status, ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          state.lastJob = { ecu, job, para, status: `ERROR: ${message}`, ok: false };
        }
      };

    case 'CDHapiJobData':
      // CDHapiJob with a BinBuf binary payload. WinKFP uses this for
      // FLASH_LOESCHEN / FLASH_SCHREIBEN / FLASH_SCHREIBEN_ENDE — the
      // SGBD's `pary` opcode reads the bytes from the binary param
      // channel (not the indexed-string args of plain `apiJob`).
      //
      // Wire path: `IEdiabasProvider.job()` is string-only, so we
      // duck-type to the underlying `Ediabas` via `getEdiabas()` (the
      // `EdiabasXProvider` escape hatch). On hit we call
      // `Ediabas.executeJob(job, { params: [bytes] })` directly + cache
      // the returned sets in `state.lastJobSets`. Subsequent
      // CDHapiResultText/Int slots prefer that cache (provider's own
      // cache is stale because we bypassed `provider.job()`).
      //
      // No-hit (mock + any string-only provider) falls back to
      // `provider.job(ecu, job, '', '')` — mock returns whatever was
      // seeded for the job name, lets the trace progress through the
      // IPO without hitting `ERROR_NO_BIN_BUFFER`.
      return async (ctx) => {
        const args = popArgs(ctx, slot.params);
        const ecu = String(args.ecu || defaultSgbd);
        const job = String(args.job);
        const handle = Number(args.BufHandle) | 0;
        const buf = state.binBufs.get(handle);
        const bytes = buf ? buf.bytes.slice(0, buf.size) : new Uint8Array(0);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { ecu, job, handle, bufSize: bytes.length },
        });
        if (!ediabas) {
          state.lastJob = { ecu, job, para: '', status: 'NO_EDIABAS', ok: false };
          state.lastJobSets = undefined;
          return;
        }
        // Try real binary path via getEdiabas() duck-type.
        const ed = getEdiabasInstance(ediabas);
        if (ed && bytes.length > 0) {
          // Match EdiabasXProvider.resolveSgbdFile: BMW SGBDs are .prg
          // (or .grp). Bare names like "10GD20" hit the filesystem as
          // ENOENT — `provider.job()` does this resolution internally
          // but our direct `ed.loadSgbd()` bypasses it.
          const sgbdFile = /\.(prg|grp)$/i.test(ecu) ? ecu : `${ecu}.prg`;
          const maxAttempts = maxBinaryRetries + 1;
          // Retry loop — see BuildSystemFunctionsOptions.maxBinaryRetries
          // for rationale. BMW flash dispatches are idempotent: a
          // FLASH_SCHREIBEN failure surfaces BEFORE the ECU commits
          // any change, so re-dispatching the same record is safe.
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              await ed.loadSgbd(sgbdFile);
              const sets = await ed.executeJob(job, { params: [bytes] });
              state.lastJobSets = sets.map((set) => {
                const m = new Map<string, unknown>();
                for (const r of set) m.set(r.name, r.value);
                return m;
              });
              const status = pickResultText(state.lastJobSets, 'JOB_STATUS', '');
              state.lastJob = { ecu, job, para: `binbuf[${bytes.length}]`, status, ok: true };
              if (retryableStatuses.has(status) && attempt < maxAttempts) {
                // Transient failure surfaced by the SGBD — log + retry.
                state.trace.push({
                  slot: slot.id,
                  name: `${slot.name}:retry`,
                  args: { job, path: 'binary', status, attempt, ofMax: maxAttempts },
                });
                if (retryBackoffMs > 0) {
                  await new Promise<void>((resolve) => setTimeout(resolve, retryBackoffMs));
                }
                continue;
              }
              state.trace.push({
                slot: slot.id,
                name: `${slot.name}:result`,
                args: {
                  job,
                  path: 'binary',
                  status,
                  attempt,
                  sets: state.lastJobSets.length,
                },
              });
              break;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              state.lastJob = { ecu, job, para: `binbuf[${bytes.length}]`, status: `ERROR: ${message}`, ok: false };
              state.lastJobSets = undefined;
              if (attempt < maxAttempts) {
                // Transport-level exception (timeout, port closed, etc.)
                // — retry. If the underlying ediabas connection is
                // truly broken, attempts will keep throwing and we'll
                // fall through to the final :error after maxAttempts.
                state.trace.push({
                  slot: slot.id,
                  name: `${slot.name}:retry`,
                  args: { job, path: 'binary', error: message, attempt, ofMax: maxAttempts },
                });
                if (retryBackoffMs > 0) {
                  await new Promise<void>((resolve) => setTimeout(resolve, retryBackoffMs));
                }
                continue;
              }
              state.trace.push({
                slot: slot.id,
                name: `${slot.name}:error`,
                args: { job, path: 'binary', error: message, attempt },
              });
              break;
            }
          }
          return;
        }
        state.trace.push({
          slot: slot.id,
          name: `${slot.name}:fallback`,
          args: { job, reason: !ed ? 'getEdiabas-null' : 'no-bytes', bytesLength: bytes.length },
        });
        // Mock / string-only fallback. Empty-string params keep the
        // IPO moving; real bench requires `getEdiabas()` to be
        // available (i.e. `EdiabasXProvider`).
        try {
          await ediabas.job(ecu, job, '', '');
          const status = readJobStatus(ediabas);
          state.lastJob = { ecu, job, para: `binbuf[${bytes.length}]`, status, ok: true };
          state.lastJobSets = undefined; // provider cache is authoritative
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          state.lastJob = { ecu, job, para: `binbuf[${bytes.length}]`, status: `ERROR: ${message}`, ok: false };
          state.lastJobSets = undefined;
        }
      };

    case 'CDHGetApiJobByteData':
      // NFS reuses slot 0x55 as the IPO's "give me the next firmware
      // record" iterator. NCSEXPER's "drain SGBD binary result" label
      // doesn't apply — the canonical NFS path is:
      //
      //   1. Host opens .0PA via datDekompOpen (FUN_00468220 in
      //      winkfpt.exe) before SG_PROGRAMMIEREN dispatch.
      //   2. IPO calls this slot once before the flash loop to learn
      //      the initial block count.
      //   3. Inside the loop, the IPO dispatches FLASH_SCHREIBEN with
      //      the BinBuf contents + calls this slot again to advance.
      //   4. When NrOfData hits 0, the IPO exits the loop.
      //
      // We expose `opts.firmwareSource` for the host (nfsx-flash) to
      // hand in a chunked-iterator view of the .0PA. When set, this
      // is the authoritative branch.
      //
      // Falls back to the SGBD-result-drain path (NCSEXPER's
      // documented semantic) when `firmwareSource` is absent — kept
      // for coding-style use cases where the SGBD ships bytes back
      // as a binary result.
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const maxData = Number(args.MaxData) | 0;
        const buf = state.binBufs.get(handle);
        if (!buf) {
          writeOut(ctx, args.BufSize, 'int', 0);
          writeOut(ctx, args.NrOfData, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({
            slot: slot.id,
            name: slot.name,
            args: { handle, maxData, error: 'invalid-handle' },
          });
          return;
        }
        // NFS happy path — host firmware source.
        if (opts.firmwareSource) {
          const chunk = opts.firmwareSource.nextChunk(maxData);
          if (chunk.bytes.length === 0 || chunk.eof) {
            writeOut(ctx, args.BufSize, 'int', 0);
            writeOut(ctx, args.NrOfData, 'int', 0);
            writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
            state.trace.push({
              slot: slot.id,
              name: slot.name,
              args: { handle, maxData, source: 'firmware', eof: true },
            });
            return;
          }
          if (chunk.bytes.length > maxData) {
            // IPO would reject this; bail with an error code rather
            // than silently truncating.
            writeOut(ctx, args.BufSize, 'int', 0);
            writeOut(ctx, args.NrOfData, 'int', 0);
            writeOut(ctx, args.RetVal, 'int', 2);
            state.trace.push({
              slot: slot.id,
              name: slot.name,
              args: { handle, maxData, error: 'chunk-exceeds-maxData', got: chunk.bytes.length },
            });
            return;
          }
          // Reset the buffer's effective size so each record starts
          // at position 0 — the IPO sends `buf[0..size]` as the
          // FLASH_SCHREIBEN binary payload.
          buf.size = 0;
          writeBinBufBytes(state, handle, 0, chunk.bytes);
          writeOut(ctx, args.BufSize, 'int', chunk.bytes.length);
          writeOut(ctx, args.NrOfData, 'int', 1);
          writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
          state.trace.push({
            slot: slot.id,
            name: slot.name,
            args: { handle, maxData, source: 'firmware', bytesWritten: chunk.bytes.length },
          });
          return;
        }
        // NCSEXPER fallback — drain SGBD binary result if present.
        if (!ediabas) {
          writeOut(ctx, args.BufSize, 'int', 0);
          writeOut(ctx, args.NrOfData, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
          state.trace.push({
            slot: slot.id,
            name: slot.name,
            args: { handle, maxData, note: 'no firmwareSource + no ediabas' },
          });
          return;
        }
        let bytes: Uint8Array | undefined;
        for (const name of ['TELEGRAMM', 'BIN_DATA', 'DATA']) {
          try {
            if (ediabas.hasResult(name, 1)) {
              bytes = ediabas.resultBinary(name, 1);
              break;
            }
          } catch {
            /* try next */
          }
        }
        if (!bytes) {
          writeOut(ctx, args.BufSize, 'int', 0);
          writeOut(ctx, args.NrOfData, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
          state.trace.push({
            slot: slot.id,
            name: slot.name,
            args: { handle, maxData, note: 'no binary result on last job' },
          });
          return;
        }
        buf.size = 0;
        writeBinBufBytes(state, handle, 0, bytes);
        writeOut(ctx, args.BufSize, 'int', bytes.length);
        writeOut(ctx, args.NrOfData, 'int', 1);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { handle, maxData, source: 'sgbd-result', bytesWritten: bytes.length },
        });
      };

    case 'CDHapiResultText':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const name = String(args.ApiResult);
        const set = Number(args.ApiSet) | 0;
        // Prefer the binary-path cache when set (last call was
        // `CDHapiJobData`); fall back to the provider for string-mode
        // dispatches.
        const value = state.lastJobSets
          ? pickResultText(state.lastJobSets, name, '', set)
          : ediabas
            ? safeResultText(ediabas, name, set, String(args.ApiFormat ?? ''))
            : '';
        writeOut(ctx, args.ResultText, 'string', value);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { name, set, value },
        });
      };

    case 'CDHapiResultInt':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const name = String(args.ApiResult);
        const set = Number(args.ApiSet) | 0;
        const value = state.lastJobSets
          ? pickResultInt(state.lastJobSets, name, 0, set)
          : ediabas
            ? safeResultInt(ediabas, name, set)
            : 0;
        writeOut(ctx, args.ResultVal, 'int', value);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { name, set, value },
        });
      };

    case 'CDHapiResultSets':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const sets = ediabas ? ediabas.resultSets() : 0;
        writeOut(ctx, args.sets, 'int', sets);
        state.trace.push({ slot: slot.id, name: slot.name, args: { sets } });
      };

    case 'CDHapiCheckJobStatus':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const refStr = String(args.RefStr);
        const matches = state.lastJob?.status === refStr;
        state.trace.push({ slot: slot.id, name: slot.name, args: { refStr, matches } });
      };

    // ── SG / SGBD identity ──────────────────────────────────────────
    case 'CDHGetSgbdName':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.SgbdName, 'string', defaultSgbd);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { sgbd: defaultSgbd } });
      };

    // ── CABD parameter store ────────────────────────────────────────
    case 'CDHSetCabdPar':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const name = String(args.Bezeichner);
        const value = String(args.Wert);
        state.cabdPars.set(name, value);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { name, value } });
      };

    case 'CDHGetCabdPar':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const name = String(args.Bezeichner);
        const value = state.cabdPars.get(name) ?? '';
        writeOut(ctx, args.Wert, 'string', value);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { name, value } });
      };

    // ── System-data store ───────────────────────────────────────────
    case 'CDHSetSystemData':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const name = String(args.Bezeichner);
        const value = String(args.Wert);
        state.systemData.set(name, value);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { name, value } });
      };

    case 'CDHGetSystemData':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const name = String(args.Bezeichner);
        const value = state.systemData.get(name) ?? '';
        writeOut(ctx, args.Wert, 'string', value);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { name, value } });
      };

    // ── Error scratchpad ────────────────────────────────────────────
    case 'CDHSetReturnVal':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        state.trace.push({ slot: slot.id, name: slot.name, args: { wert: Number(args.Wert) | 0 } });
      };

    case 'CDHResetError':
      return (ctx) => {
        popArgs(ctx, slot.params);
        state.trace.push({ slot: slot.id, name: slot.name, args: {} });
      };

    case 'CDHSetError':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: {
            errNr: Number(args.ErrNr) | 0,
            modul: String(args.ModulName),
            proc: String(args.ProcName),
            lineNr: Number(args.LineNr) | 0,
            errorInfo: String(args.ErrorInfo),
          },
        });
      };

    case 'CDHTestError':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.ErrNr, 'int', 0);
        state.trace.push({ slot: slot.id, name: slot.name, args: { errNr: 0 } });
      };

    // ── Binary buffers (NCSEXPER slots 0x49–0x51) ───────────────────
    //
    // The IPO's in-memory staging area between disk reads and SGBD
    // jobs. SG_PROGRAMMIEREN's path: alloc BinBuf → fileread into it
    // → BinBufToNettoData → CDHapiJob with binary payload.
    //
    // Logic mirrors `@emdzej/ncsx-inpax-cabi-provider`'s tested
    // BinBuf surface (provider.js's `CDHBinBuf*` methods). Replicated
    // here rather than depended-on because the ncsx CabiProvider
    // pulls in slot-table / FSW-PSW / dataOrg state we don't need.
    //
    // Endianness: NCSEXPER toggles per dataOrg.byteFolge (0 = LE,
    // 1 = BE). NFS IPOs we've inspected so far are little-endian;
    // we default to LE without exposing a flag yet — re-evaluate
    // when bench evidence shows otherwise.

    case 'CDHCheckDataUsed':
      // NCSEXPER verifies every slot's in-flight bit; for NFS this
      // is a no-op that just returns OK. ncsx's provider takes the
      // same approach.
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: {} });
      };

    case 'CDHBinBufToNettoData':
      // For NFS, this likely stashes the buffer as the next
      // CDHapiJob's binary payload. We don't yet wire that through
      // ediabas — trace + record the handle for downstream consumers.
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const buf = state.binBufs.get(handle);
        if (!buf) {
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, error: 'invalid-handle' } });
          return;
        }
        state.pendingBinBufPayload = { handle, size: buf.size };
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { handle, size: buf.size },
        });
      };

    case 'CDHBinBufCreate':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = state.nextBinBufHandle++;
        state.binBufs.set(handle, { bytes: new Uint8Array(64), size: 0 });
        writeOut(ctx, args.BufHandle, 'int', handle);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle } });
      };

    case 'CDHBinBufDelete':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const ok = state.binBufs.delete(handle);
        writeOut(ctx, args.RetVal, 'int', ok ? NCSEXPER_SUCCESS : 1);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle, ok } });
      };

    case 'CDHBinBufWriteByte':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const byteVal = Number(args.ByteVal) & 0xff;
        const position = Number(args.Position) | 0;
        if (!state.binBufs.has(handle)) {
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, error: 'invalid-handle' } });
          return;
        }
        writeBinBufBytes(state, handle, position, Uint8Array.of(byteVal));
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle, position, byteVal } });
      };

    case 'CDHBinBufWriteWord':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const wordVal = Number(args.WordVal) & 0xffff;
        const position = Number(args.Position) | 0;
        if (!state.binBufs.has(handle)) {
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, error: 'invalid-handle' } });
          return;
        }
        // LE default; ncsx flips to BE on dataOrg.byteFolge=1.
        const lo = wordVal & 0xff;
        const hi = (wordVal >> 8) & 0xff;
        writeBinBufBytes(state, handle, position, Uint8Array.of(lo, hi));
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle, position, wordVal } });
      };

    case 'CDHBinBufReadByte':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const position = Number(args.Position) | 0;
        const buf = state.binBufs.get(handle);
        if (!buf) {
          writeOut(ctx, args.ByteVal, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, error: 'invalid-handle' } });
          return;
        }
        if (position < 0 || position >= buf.size) {
          writeOut(ctx, args.ByteVal, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', 2);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, position, error: 'out-of-range', size: buf.size } });
          return;
        }
        const byteVal = buf.bytes[position]!;
        writeOut(ctx, args.ByteVal, 'int', byteVal);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle, position, byteVal } });
      };

    case 'CDHBinBufReadWord':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const position = Number(args.Position) | 0;
        const buf = state.binBufs.get(handle);
        if (!buf) {
          writeOut(ctx, args.WordVal, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, error: 'invalid-handle' } });
          return;
        }
        if (position < 0 || position + 1 >= buf.size) {
          writeOut(ctx, args.WordVal, 'int', 0);
          writeOut(ctx, args.RetVal, 'int', 2);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, position, error: 'out-of-range', size: buf.size } });
          return;
        }
        // LE default — see CDHBinBufWriteWord.
        const lo = buf.bytes[position]!;
        const hi = buf.bytes[position + 1]!;
        const wordVal = (hi << 8) | lo;
        writeOut(ctx, args.WordVal, 'int', wordVal);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle, position, wordVal } });
      };

    case 'CDHBinBufToStr':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const handle = Number(args.BufHandle) | 0;
        const buf = state.binBufs.get(handle);
        if (!buf) {
          writeOut(ctx, args.BinBufStr, 'string', '');
          writeOut(ctx, args.RetVal, 'int', 1);
          state.trace.push({ slot: slot.id, name: slot.name, args: { handle, error: 'invalid-handle' } });
          return;
        }
        let hex = '';
        for (let i = 0; i < buf.size; i++) {
          hex += buf.bytes[i]!.toString(16).padStart(2, '0').toUpperCase();
        }
        writeOut(ctx, args.BinBufStr, 'string', hex);
        writeOut(ctx, args.RetVal, 'int', NCSEXPER_SUCCESS);
        state.trace.push({ slot: slot.id, name: slot.name, args: { handle, size: buf.size } });
      };

    // ── File I/O (NCSEXPER slots 0x21/0x22/0x23) ────────────────────
    //
    // SG_PROGRAMMIEREN reads `.0PA`/`.0DA` from disk via these slots.
    // NCSEXPER's own definition is write-coding-focused (the doc says
    // "Open a file for write") but the slots are mode-parameterised
    // so we accept "r" for read.
    //
    // Single-open semantics: at most one file is open at a time, kept
    // in `state.openFile`. Mirrors WinKFP's interpreter behaviour where
    // fileclose() takes no args ("close the open file").
    //
    // `fileread` is NOT in the NCSEXPER table — NFS adds its own slot
    // for it. Number TBD; surfaces via observability (defaultOverride
    // traces unknown calls so we'll see it when SG_PROGRAMMIEREN runs).

    case 'fileopen':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const filename = String(args.FileName);
        const modeRaw = String(args.OpenMode).toLowerCase();
        const mode: 'r' | 'w' | 'a' =
          modeRaw.startsWith('r') ? 'r' : modeRaw.startsWith('a') ? 'a' : 'w';
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { filename, mode },
        });
        // Close any previously-open file before opening a new one.
        closeOpenFile(state);
        try {
          const path = resolveWorkingPath(opts.workingDir, filename);
          if (mode === 'r') {
            const buf = readFileSync(path);
            state.openFile = {
              path,
              mode,
              fd: -1,
              readBuffer: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
              readPos: 0,
            };
          } else {
            const fd = openSync(path, mode === 'w' ? 'w' : 'a');
            state.openFile = { path, mode, fd };
          }
        } catch (err) {
          // No way to signal error back to caller (the slot has no
          // out-ref + no return value). Record in the trace; the next
          // fileread/filewrite call will see `state.openFile` undefined
          // and behave as no-op.
          state.trace.push({
            slot: slot.id,
            name: 'fileopen:error',
            args: { filename, mode, error: err instanceof Error ? err.message : String(err) },
          });
        }
      };

    case 'fileclose':
      return (ctx) => {
        popArgs(ctx, slot.params);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { path: state.openFile?.path ?? null },
        });
        closeOpenFile(state);
      };

    case 'filewrite':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const str = String(args.str);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { length: str.length },
        });
        const f = state.openFile;
        if (!f || f.fd < 0) {
          state.trace.push({
            slot: slot.id,
            name: 'filewrite:error',
            args: { error: 'no file open for write' },
          });
          return;
        }
        try {
          writeSync(f.fd, str);
        } catch (err) {
          state.trace.push({
            slot: slot.id,
            name: 'filewrite:error',
            args: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      };

    // ── String / convert utilities the control flow may touch ──────
    case 'strlen':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.len, 'int', String(args.str).length);
      };

    case 'strcat':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.DestStr, 'string', String(args.SrcStr1) + String(args.SrcStr2));
      };

    case 'midstr':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const src = String(args.SrcStr);
        const start = Math.max(0, Number(args.FirstIndex) - 1);
        const count = Math.max(0, Number(args.Count));
        writeOut(ctx, args.ResultStr, 'string', src.substring(start, start + count));
      };

    case 'inttostring':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.s, 'string', String(Number(args.i) | 0));
      };

    case 'realtostring':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.s, 'string', String(args.r));
      };

    case 'testtimer':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        writeOut(ctx, args.expiredflag, 'bool', true);
      };

    default:
      return defaultOverrideWithTrace(slot, state);
  }
}

/**
 * Pop args off the IPO stack in reverse declaration order, returning
 * an object keyed by param name. `in` params resolve to JS values;
 * `out`/`inout` params resolve to a `StackEntry` ref the override
 * can write back through via `writeOut`.
 */
function popArgs(
  ctx: ExecutionContext,
  params: readonly CabiParam[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = params.length - 1; i >= 0; i--) {
    const param = params[i]!;
    if (param.direction === 'in') {
      switch (param.type) {
        case 'string': out[param.name] = ctx.popString(); break;
        case 'int':    out[param.name] = ctx.popInt(); break;
        case 'real':   out[param.name] = ctx.popReal(); break;
        case 'bool':   out[param.name] = ctx.popBool(); break;
      }
    } else {
      out[param.name] = ctx.popRef();
    }
  }
  return out;
}

function writeOut(
  ctx: ExecutionContext,
  ref: unknown,
  type: CabiParam['type'],
  value: string | number | boolean,
): void {
  const refEntry = ref as StackEntry | undefined;
  if (!refEntry?.refInfo) return;
  let entry: StackEntry;
  switch (type) {
    case 'string': entry = makeEntry(ValueType.String, String(value)); break;
    case 'int':    entry = makeEntry(ValueType.Int, Number(value) | 0); break;
    case 'real':   entry = makeEntry(ValueType.Real, Number(value)); break;
    case 'bool':   entry = makeEntry(ValueType.Bool, Boolean(value)); break;
  }
  ctx.setOutParam(refEntry, entry);
}

/**
 * For slots we haven't wired explicitly — pop args correctly per the
 * CABI signature so the stack stays balanced, then no-op. The VM's
 * `popFrame()` after each `CALL sys` truncates back to the FRAME
 * marker so even if out-refs aren't written, the IPO sees the ALLOC
 * default (0 / "" / false), which most paths interpret as "no error".
 *
 * Pre-2026-05-27 this was silently no-op; the rewrite added a trace
 * entry so unknown-slot calls show up in `state.trace`. That's how we
 * discover slot numbers for NFS-extended syscalls (e.g. `fileread`)
 * that aren't in the NCSEXPER table — dispatch SG_PROGRAMMIEREN
 * against the bench, look at the trace, see which slot IDs the IPO
 * hits but we haven't handled.
 */
function defaultOverride(slot: CabiSlot): SystemFunctionOverride {
  return (ctx) => {
    const args = popArgs(ctx, slot.params);
    // Only record args we can serialize without ref-juggling. For
    // out-refs, just note their presence so the trace stays compact.
    const serializable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        serializable[k] = v;
      } else {
        serializable[k] = '<out-ref>';
      }
    }
    // Trace via the slot's own state-trace; the caller can later
    // inspect to find unhandled slots. We can't reach `state` here
    // (defaultOverride is built without it), so we leave a marker via
    // the slot's own param-pop only. To get the trace, callers should
    // use the explicit handlers above.
    void serializable;
  };
}

/**
 * Same as `defaultOverride` but with access to `state` so it can log
 * to `state.trace`. Used in the main switch's catch-all so the
 * observability surface is consistent.
 */
function defaultOverrideWithTrace(
  slot: CabiSlot,
  state: CabiState,
): SystemFunctionOverride {
  return (ctx) => {
    const args = popArgs(ctx, slot.params);
    const serializable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        serializable[k] = v;
      } else {
        serializable[k] = '<out-ref>';
      }
    }
    state.trace.push({
      slot: slot.id,
      name: `${slot.name} (default)`,
      args: serializable,
    });
  };
}

/**
 * Resolve a basename or relative path against the configured working
 * directory. Throws if the resolved path escapes (e.g. `../foo`) or if
 * `workingDir` is unset and the path isn't absolute — better to fail
 * loud than silently open files from the current process directory.
 */
function resolveWorkingPath(workingDir: string | undefined, filename: string): string {
  if (isAbsolute(filename)) {
    return filename;
  }
  if (!workingDir) {
    throw new Error(
      `fileopen('${filename}'): no workingDir configured. Pass BuildSystemFunctionsOptions.workingDir to enable relative file references.`,
    );
  }
  const baseDir = resolve(workingDir);
  const full = resolve(baseDir, filename);
  if (full !== baseDir && !full.startsWith(baseDir + sep)) {
    throw new Error(`fileopen('${filename}'): refusing to open path that escapes workingDir ${baseDir}`);
  }
  return full;
}

/**
 * Write `src` into the binbuf at `position`, growing capacity if
 * needed. Doubles the backing array on overflow (matches ncsx
 * provider's growth strategy). `size` is bumped to cover the new
 * tail. Implicit gap bytes stay zero per the underlying Uint8Array.
 */
function writeBinBufBytes(
  state: CabiState,
  handle: number,
  position: number,
  src: Uint8Array,
): void {
  const buf = state.binBufs.get(handle);
  if (!buf) return;
  const needed = position + src.length;
  if (needed > buf.bytes.length) {
    let cap = buf.bytes.length || 64;
    while (cap < needed) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(buf.bytes.subarray(0, buf.size));
    buf.bytes = grown;
  }
  buf.bytes.set(src, position);
  if (needed > buf.size) buf.size = needed;
}

/** Tear down whatever file is open in `state.openFile`. Idempotent. */
function closeOpenFile(state: CabiState): void {
  const f = state.openFile;
  if (!f) return;
  if (f.fd >= 0) {
    try {
      closeSync(f.fd);
    } catch {
      /* ignore */
    }
  }
  state.openFile = undefined;
}

function makeEntry(type: ValueType, value: Value): StackEntry {
  return { type, flags: StackEntryFlags.ByValue, value };
}

function readJobStatus(ediabas: IEdiabasProvider): string {
  // Default to '' (not 'OKAY') when JOB_STATUS isn't published — mirrors
  // what the IPO sees when it reads JOB_STATUS via CDHapiResultText.
  // The 'OKAY' default would mis-flag mock-less / failed dispatches as
  // successful in `state.lastJob.status`, which downstream consumers
  // (FscManager.toResult) rely on for ok/error routing.
  try {
    if (!ediabas.hasResult('JOB_STATUS', 1)) return '';
    return ediabas.resultText('JOB_STATUS', 1, '');
  } catch {
    return '';
  }
}

function safeResultText(
  ediabas: IEdiabasProvider,
  name: string,
  set: number,
  fmt: string,
): string {
  try {
    if (!ediabas.hasResult(name, set)) return '';
    return ediabas.resultText(name, set, fmt);
  } catch {
    return '';
  }
}

function safeResultInt(ediabas: IEdiabasProvider, name: string, set: number): number {
  try {
    if (!ediabas.hasResult(name, set)) return 0;
    return ediabas.resultInt(name, set);
  } catch {
    return 0;
  }
}

/**
 * Duck-typed Ediabas-instance escape hatch. `EdiabasXProvider`
 * exposes `getEdiabas(): Ediabas | null`; other providers (mock,
 * Inp1Adapter, etc.) don't. Returns the underlying instance on hit,
 * `undefined` on miss. Typed loosely on purpose — we can't import
 * `@emdzej/ediabasx-ediabas` from nfsx-runtime without adding a
 * dependency that contaminates browser builds.
 */
interface EdiabasInstance {
  loadSgbd(filename: string): Promise<void>;
  executeJob(
    jobName: string,
    options?: { params?: (string | Uint8Array)[]; timeout?: number },
  ): Promise<Array<Array<{ name: string; value: unknown }>>>;
}

function getEdiabasInstance(provider: IEdiabasProvider): EdiabasInstance | undefined {
  const getter = (provider as unknown as { getEdiabas?: () => unknown }).getEdiabas;
  if (typeof getter !== 'function') return undefined;
  const ed = getter.call(provider);
  if (!ed || typeof (ed as { executeJob?: unknown }).executeJob !== 'function') return undefined;
  return ed as EdiabasInstance;
}

/**
 * Read a named field from a cached job-set snapshot, coercing to
 * text. Used after `CDHapiJobData` to read result fields without
 * going through the provider (which has a stale cache because we
 * bypassed `provider.job()`).
 */
function pickResultText(
  sets: ReadonlyArray<ReadonlyMap<string, unknown>>,
  name: string,
  fallback: string,
  set: number = 1,
): string {
  const s = sets[set - 1];
  if (!s) return fallback;
  const v = s.get(name);
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) {
    // Try UTF-8 decode for text-like binary results; fall back to hex.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(v);
    } catch {
      return Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  return String(v);
}

/**
 * Read a named field from a cached job-set snapshot, coercing to
 * integer. Companion to `pickResultText`.
 */
function pickResultInt(
  sets: ReadonlyArray<ReadonlyMap<string, unknown>>,
  name: string,
  fallback: number,
  set: number = 1,
): number {
  const s = sets[set - 1];
  if (!s) return fallback;
  const v = s.get(name);
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
