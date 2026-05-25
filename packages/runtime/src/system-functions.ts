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
import type { CabiState } from './state.js';

type SystemFunctionOverride = (
  ctx: ExecutionContext,
) => void | Promise<void>;

const NCSEXPER_SUCCESS = 0;

export function buildSystemFunctions(
  state: CabiState,
): Map<number, SystemFunctionOverride> {
  const map = new Map<number, SystemFunctionOverride>();

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
