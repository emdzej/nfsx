/**
 * NCSEXPER-style system-function overrides for the inpax VM.
 *
 * The IPO bytecode calls slots by numeric ID, not by name. NCSEXPER
 * and INPA assign DIFFERENT names + signatures to the same slot
 * IDs:
 *
 *   slot 0x2E — INPA: PEMSGZ_Kopfzeile(out bool)   1 ref
 *               NCSEXPER: CDHSetCabdPar(name, value, out retVal)   2 in + 1 ref
 *
 *   slot 0x2F — INPA: PEMTrennLinie(out bool)   1 ref
 *               NCSEXPER: CDHGetCabdPar(name, out value, out retVal)   1 in + 2 ref
 *
 * NFS IPOs were authored against the NCSEXPER (a.k.a. NCS Expert)
 * runtime, so we must override these slots — without it the VM
 * pops the wrong number of args and corrupts the stack.
 *
 * The override surface here is intentionally tiny — the five slots
 * cabimain + `Jobs()` actually exercise. As more flows light up
 * (Ident, AifLesen, etc. — which add CDHapiJob / CDHapiResultText)
 * we extend. The slot IDs are anchored against
 * `ncsx/packages/inpax-cabi-provider/src/ncsexper-syscalls.ts` —
 * once that package lands on npm we replace this hand-rolled table
 * with the full 80+ slot one.
 */

import type { ExecutionContext } from '@emdzej/inpax-interpreter';
import { StackEntryFlags, ValueType, type StackEntry, type Value } from '@emdzej/inpax-core';
import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { CabiState } from './state.js';

type SystemFunctionOverride = (
  ctx: ExecutionContext,
) => void | Promise<void>;

const NCSEXPER_SUCCESS = 0;

export interface BuildSystemFunctionsOptions {
  /**
   * EDIABAS provider that handles CDHapiJob dispatches. When unset
   * the CDH-EDIABAS slots are no-ops — the IPO can still dispatch
   * cabimain but actual ECU calls disappear. Pass a
   * `MockEdiabasProvider` (or a real `EdiabasXProvider`) to give
   * the IPO data to work with.
   */
  ediabas?: IEdiabasProvider;
  /**
   * Default SGBD name returned by `CDHGetSgbdName` (slot 0x33).
   * NCSEXPER's host populates this from `SGFAM.SGBD` for the
   * current ECU; the IPO uses it as the first arg to subsequent
   * `CDHapiJob` calls. Without this, the IPO's apiJob would
   * dispatch to `""` and fail.
   */
  defaultSgbd?: string;
}

export function buildSystemFunctions(
  state: CabiState,
  opts: BuildSystemFunctionsOptions = {},
): Map<number, SystemFunctionOverride> {
  const map = new Map<number, SystemFunctionOverride>();
  const ediabas = opts.ediabas;
  const defaultSgbd = opts.defaultSgbd ?? '';

  // ── slot 0x02 — exit() ──────────────────────────────────────────
  // INPA: setitem(int, string, bool); NCSEXPER: exit() — terminate
  // the IPO. Treat as a no-op here: when the dispatcher hits this,
  // execution unwinds to RET via the next instruction anyway. A
  // proper "halt the VM" signal would be cleaner but isn't needed
  // for read-only flows.
  map.set(0x02, () => {
    /* no-op — NCSEXPER's exit() is RET-equivalent at the script level */
  });

  // ── slot 0x0B — setjobstatus(in int JobStatus) ────────────────
  // Shared between INPA and NCSEXPER; same signature, just record
  // the value so the host can surface it after dispatch.
  map.set(0x0b, (ctx) => {
    const status = ctx.popInt();
    state.lastJobStatus = status;
    state.trace.push({ slot: 0x0b, name: 'setjobstatus', args: { status } });
  });

  // ── slot 0x0D — CDHapiJob(string ecu, string job, string para, string result)
  // THE bridge between the IPO and EDIABAS. Pop 4 in-strings, hand
  // off to the provider. The IPO follows up with CDHapiResult*
  // calls (0x0F/0x10/0x11/etc.) to read named results back.
  map.set(0x0d, async (ctx) => {
    const result = ctx.popString();
    const para = ctx.popString();
    const job = ctx.popString();
    const ecu = ctx.popString();
    state.trace.push({ slot: 0x0d, name: 'CDHapiJob', args: { ecu, job, para, result } });
    if (!ediabas) {
      state.lastJob = { ecu, job, para, status: 'NO_EDIABAS', ok: false };
      return;
    }
    try {
      await ediabas.job(ecu, job, para, result);
      // Status reading — providers expose JOB_STATUS as a result.
      // Mock returns 'OKAY' when results are configured, 'ERROR_*'
      // when setNextError was called.
      const status = readJobStatus(ediabas);
      state.lastJob = { ecu, job, para, status, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastJob = { ecu, job, para, status: `ERROR: ${message}`, ok: false };
    }
  });

  // ── slot 0x0F — CDHapiResultText(out string val, in string name, in int set, in string fmt)
  map.set(0x0f, (ctx) => {
    const fmt = ctx.popString();
    const set = ctx.popInt();
    const name = ctx.popString();
    const outRef = ctx.popRef();
    const value = ediabas ? safeResultText(ediabas, name, set, fmt) : '';
    writeString(ctx, outRef, value);
    state.trace.push({ slot: 0x0f, name: 'CDHapiResultText', args: { name, set, value } });
  });

  // ── slot 0x10 — CDHapiResultInt(out int val, in string name, in int set)
  map.set(0x10, (ctx) => {
    const set = ctx.popInt();
    const name = ctx.popString();
    const outRef = ctx.popRef();
    const value = ediabas ? safeResultInt(ediabas, name, set) : 0;
    writeInt(ctx, outRef, value);
    state.trace.push({ slot: 0x10, name: 'CDHapiResultInt', args: { name, set, value } });
  });

  // ── slot 0x11 — CDHapiResultSets(out int sets)
  map.set(0x11, (ctx) => {
    const outRef = ctx.popRef();
    const sets = ediabas ? ediabas.resultSets() : 0;
    writeInt(ctx, outRef, sets);
    state.trace.push({ slot: 0x11, name: 'CDHapiResultSets', args: { sets } });
  });

  // ── slot 0x15 — CDHapiCheckJobStatus(in string RefStr)
  // Compares lastJob.status against the reference and pushes a
  // bool result back. NCSEXPER uses this to detect specific error
  // codes (e.g. ERROR_NUMBER_ARGUMENT).
  map.set(0x15, (ctx) => {
    const refStr = ctx.popString();
    // No out param — the IPO checks state via CDHTestError after.
    // The "check" here is informational tracing only.
    const matches = state.lastJob?.status === refStr;
    state.trace.push({ slot: 0x15, name: 'CDHapiCheckJobStatus', args: { refStr, matches } });
  });

  // ── slot 0x33 — CDHGetSgbdName(out string SgbdName, out int RetVal)
  // NCSEXPER's host populates the current SGBD name before
  // dispatch (typically from SGFAM.SGBD lookup). We return the
  // configured defaultSgbd.
  map.set(0x33, (ctx) => {
    const retRef = ctx.popRef();
    const sgbdRef = ctx.popRef();
    writeString(ctx, sgbdRef, defaultSgbd);
    writeInt(ctx, retRef, NCSEXPER_SUCCESS);
    state.trace.push({ slot: 0x33, name: 'CDHGetSgbdName', args: { sgbd: defaultSgbd } });
  });

  // ── slot 0x2B — CDHSetReturnVal(in int Wert) ──────────────────
  // INPA's same-slot name is PEMInitialisiere with `(out bool)` —
  // wrong signature for an NFS IPO. We pop one int and record.
  map.set(0x2b, (ctx) => {
    const wert = ctx.popInt();
    state.trace.push({ slot: 0x2b, name: 'CDHSetReturnVal', args: { wert } });
  });

  // ── slot 0x2C — CDHSetSystemData(string name, string value, out int retVal)
  map.set(0x2c, (ctx) => {
    const retRef = ctx.popRef();
    const value = ctx.popString();
    const name = ctx.popString();
    state.systemData.set(name, value);
    writeInt(ctx, retRef, NCSEXPER_SUCCESS);
    state.trace.push({ slot: 0x2c, name: 'CDHSetSystemData', args: { name, value } });
  });

  // ── slot 0x2D — CDHGetSystemData(string name, out string value, out int retVal)
  map.set(0x2d, (ctx) => {
    const retRef = ctx.popRef();
    const valueRef = ctx.popRef();
    const name = ctx.popString();
    const value = state.systemData.get(name) ?? '';
    writeString(ctx, valueRef, value);
    writeInt(ctx, retRef, NCSEXPER_SUCCESS);
    state.trace.push({ slot: 0x2d, name: 'CDHGetSystemData', args: { name, value } });
  });

  // ── slot 0x2E — CDHSetCabdPar(string name, string value, out int retVal)
  // The slot `Jobs()` hammers to publish JOB[1..N] entries.
  map.set(0x2e, (ctx) => {
    const retRef = ctx.popRef();
    const value = ctx.popString();
    const name = ctx.popString();
    state.cabdPars.set(name, value);
    writeInt(ctx, retRef, NCSEXPER_SUCCESS);
    state.trace.push({ slot: 0x2e, name: 'CDHSetCabdPar', args: { name, value } });
  });

  // ── slot 0x2F — CDHGetCabdPar(string name, out string value, out int retVal)
  // The slot cabimain hits to read JOBNAME and dispatch.
  map.set(0x2f, (ctx) => {
    const retRef = ctx.popRef();
    const valueRef = ctx.popRef();
    const name = ctx.popString();
    const value = state.cabdPars.get(name) ?? '';
    writeString(ctx, valueRef, value);
    writeInt(ctx, retRef, NCSEXPER_SUCCESS);
    state.trace.push({ slot: 0x2f, name: 'CDHGetCabdPar', args: { name, value } });
  });

  // ── slot 0x52 — CDHResetError() ─────────────────────────────────
  // No args. NFS IPOs call this at startup to clear stale error
  // state; we just trace it.
  map.set(0x52, () => {
    state.trace.push({ slot: 0x52, name: 'CDHResetError', args: {} });
  });

  // ── slot 0x53 — CDHSetError(int ErrNr, string Module, string Proc, int LineNr, string ErrorInfo)
  // 5 in-args. The IPO's SetCDHFehler user function ends up here
  // when something goes wrong (e.g. unknown ProzessorTyp). We pop
  // + trace; the IPO continues.
  map.set(0x53, (ctx) => {
    const errorInfo = ctx.popString();
    const lineNr = ctx.popInt();
    const proc = ctx.popString();
    const modul = ctx.popString();
    const errNr = ctx.popInt();
    state.trace.push({
      slot: 0x53,
      name: 'CDHSetError',
      args: { errNr, modul, proc, lineNr, errorInfo },
    });
  });

  // ── slot 0x54 — CDHTestError(out int ErrNr) ────────────────────
  // Reads the current error number. We always say 0 (no error).
  map.set(0x54, (ctx) => {
    const ref = ctx.popRef();
    writeInt(ctx, ref, 0);
    state.trace.push({ slot: 0x54, name: 'CDHTestError', args: { errNr: 0 } });
  });

  return map;
}

function writeInt(ctx: ExecutionContext, ref: StackEntry, value: number): void {
  ctx.setOutParam(ref, makeEntry(ValueType.Int, value));
}

function writeString(ctx: ExecutionContext, ref: StackEntry, value: string): void {
  ctx.setOutParam(ref, makeEntry(ValueType.String, value));
}

/**
 * Build a by-value `StackEntry` for `setOutParam`. The inpax core
 * exports `Stack.createEntry` but it's not on the published API
 * surface for 0.7.1 — constructing the literal directly works and
 * matches what the inpax VM does internally for outs (ByValue
 * because the VM resolves the ref's `refInfo` to find where to
 * store, and uses our `value` field).
 */
function makeEntry(type: ValueType, value: Value): StackEntry {
  return { type, flags: StackEntryFlags.ByValue, value };
}

/**
 * Read JOB_STATUS from the most recent ediabas job. Providers
 * publish it as a string result on set 1 with name `JOB_STATUS`.
 * Defaults to `OKAY` when the provider doesn't surface a status
 * (e.g. mock with no setNextError). Falls back to empty string
 * if the result query throws.
 */
function readJobStatus(ediabas: IEdiabasProvider): string {
  try {
    if (!ediabas.hasResult('JOB_STATUS', 1)) return 'OKAY';
    return ediabas.resultText('JOB_STATUS', 1, '');
  } catch {
    return '';
  }
}

/** Wrap resultText with a defensive fallback — missing result → empty string. */
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

/** Wrap resultInt with a defensive fallback — missing result → 0. */
function safeResultInt(ediabas: IEdiabasProvider, name: string, set: number): number {
  try {
    if (!ediabas.hasResult(name, set)) return 0;
    return ediabas.resultInt(name, set);
  } catch {
    return 0;
  }
}
