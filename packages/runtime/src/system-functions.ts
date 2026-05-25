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

function makeOverride(
  slot: CabiSlot,
  state: CabiState,
  opts: BuildSystemFunctionsOptions,
): SystemFunctionOverride {
  const ediabas = opts.ediabas;
  const defaultSgbd = opts.defaultSgbd ?? '';

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
        try {
          await ediabas.job(ecu, job, para, result);
          const status = readJobStatus(ediabas);
          state.lastJob = { ecu, job, para, status, ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          state.lastJob = { ecu, job, para, status: `ERROR: ${message}`, ok: false };
        }
      };

    case 'CDHapiResultText':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const value = ediabas
          ? safeResultText(
              ediabas,
              String(args.ApiResult),
              Number(args.ApiSet) | 0,
              String(args.ApiFormat ?? ''),
            )
          : '';
        writeOut(ctx, args.ResultText, 'string', value);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { name: String(args.ApiResult), set: Number(args.ApiSet), value },
        });
      };

    case 'CDHapiResultInt':
      return (ctx) => {
        const args = popArgs(ctx, slot.params);
        const value = ediabas
          ? safeResultInt(ediabas, String(args.ApiResult), Number(args.ApiSet) | 0)
          : 0;
        writeOut(ctx, args.ResultVal, 'int', value);
        state.trace.push({
          slot: slot.id,
          name: slot.name,
          args: { name: String(args.ApiResult), set: Number(args.ApiSet), value },
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
      return defaultOverride(slot);
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
 */
function defaultOverride(slot: CabiSlot): SystemFunctionOverride {
  return (ctx) => {
    popArgs(ctx, slot.params);
  };
}

function makeEntry(type: ValueType, value: Value): StackEntry {
  return { type, flags: StackEntryFlags.ByValue, value };
}

function readJobStatus(ediabas: IEdiabasProvider): string {
  try {
    if (!ediabas.hasResult('JOB_STATUS', 1)) return 'OKAY';
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
