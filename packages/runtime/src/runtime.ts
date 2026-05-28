/**
 * `startNfsRuntime` — boots up an inpax VM around an NFS IPO and
 * exposes a `runCabimain(jobName)` entry point. Mirrors ncsx's
 * `startNcsRuntime` shape, scoped down to what NFS read-only flows
 * need.
 *
 * Three external dependencies, all from published inpax packages:
 *   - @emdzej/inpax-parser     — IPO bytecode → typed Instruction[]
 *   - @emdzej/inpax-interpreter — VM + scheduler
 *   - @emdzej/inpax-providers   — null providers for UI/SPS/etc.
 *   - @emdzej/inpax-mock-provider — mock EDIABAS (no real ECU needed)
 *
 * No ncsx dependency. Once `@emdzej/ncsx-inpax-cabi-provider` lands
 * on npm, the system-function table here is replaced by the full
 * one ncsx exposes, but the runtime shape stays the same.
 */

import { readFileSync } from 'node:fs';
import { parseIpo } from '@emdzej/inpax-parser';
import { VM } from '@emdzej/inpax-interpreter';
import { StackEntryFlags, ValueType, type FunctionBlock } from '@emdzej/inpax-core';
import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import {
  NullUIProvider,
  NullSimulationProvider,
  NullPrintProvider,
  NullPemProvider,
  NullDtmProvider,
  NullExternalProvider,
  NullSpsProvider,
} from '@emdzej/inpax-providers/null';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { CabiState } from './state.js';
import { buildSystemFunctions } from './system-functions.js';

export interface NfsRuntimeHandle {
  /** Path of the IPO that was loaded. */
  ipoPath: string;
  /** Underlying inpax VM — for advanced callers / debugging. */
  vm: VM;
  /** In-memory CABI state — cabd-pars + system-data + trace. */
  state: CabiState;
  /**
   * EDIABAS provider the runtime is using. Either the caller-
   * supplied one or a fresh `MockEdiabasProvider`. Exposed so
   * tests can pre-configure mock results before dispatch:
   *
   *     const h = await startNfsRuntime({ ipoPath });
   *     (h.ediabas as MockEdiabasProvider).setSimpleResult(
   *       'C_ACC65', 'IDENT', { ID_BMW_NR: '6985684', JOB_STATUS: 'OKAY' });
   *     await h.runCabimain('SG_IDENT_LESEN');
   */
  ediabas: IEdiabasProvider;
  /**
   * Run the IPO's `cabimain(JOBNAME)` dispatcher with the supplied
   * job name. Seeds JOBNAME into the cabd-par store + pushes it as
   * `local[0]`, then calls `vm.executeBlockWithContext(cabimain, ctx)`.
   *
   * Mirrors NCSEXPER's MFC-side dispatch: the C code seeds the
   * cabd-par map, pushes the job name onto the IPO's local stack,
   * and invokes the cabimain block. The IPO's switch on JOBNAME
   * then dispatches to the matching user function (`Jobs`,
   * `Ident`, `Cod`, etc.).
   *
   * Returns when the dispatch completes. Inspect `handle.state`
   * for results (cabd-pars the IPO published, last JOB_STATUS,
   * the syscall trace).
   */
  runCabimain: (jobName: string) => Promise<void>;
}

export interface StartNfsRuntimeOptions {
  /** Path to the IPO file to load. */
  ipoPath: string;
  /**
   * Optional pre-seed of cabd-pars before any dispatch. Useful for
   * setting APPLIKATION (chassis code) and other host-state the IPO
   * might consult.
   */
  cabdPars?: Record<string, string>;
  /**
   * Optional pre-seed of system-data entries.
   */
  systemData?: Record<string, string>;
  /**
   * EDIABAS provider for `CDHapiJob` dispatch. Defaults to a fresh
   * `MockEdiabasProvider` — fine for IPOs that don't dispatch any
   * apiJobs (like JOB_ERMITTELN). For IPOs that DO call apiJob,
   * supply a provider with pre-configured mock results, or a real
   * `EdiabasXProvider` when targeting a live ECU.
   */
  ediabas?: IEdiabasProvider;
  /**
   * SGBD basename for the ECU this runtime represents (e.g.
   * `C_ACC65`). Returned by `CDHGetSgbdName` (slot 0x33), which
   * NFS IPOs call to discover which SGBD to drive their apiJobs
   * against. Without this, apiJob calls in IPOs like
   * `HwReferenzLesen` / `Ident` dispatch to `""` and fail.
   */
  sgbd?: string;
  /**
   * Working directory for IPO file I/O via `fileopen` / `fileread` /
   * `filewrite` / `fileclose` syscall slots. For a flash session this
   * is typically `<spDaten>/data/<SG_TYP>/` — where the IPO finds the
   * `.0PA`/`.0DA` files referenced by KFCONF + ZB-NR table.
   *
   * Unset = file ops fail at the open call (safer default than
   * accidentally opening process.cwd()-relative paths).
   */
  workingDir?: string;
  /**
   * Firmware-record iterator for the IPO's flash loop. See
   * `BuildSystemFunctionsOptions.firmwareSource` in
   * `./system-functions.ts` for the contract. Wire from
   * `@emdzej/nfsx-flash` after parsing the `.0PA`.
   */
  firmwareSource?: import('./system-functions.js').FirmwareSource;
  /**
   * Retry knobs for slot 0x0E (CDHapiJobData) — see
   * `BuildSystemFunctionsOptions` in `./system-functions.ts` for
   * the full doc + defaults (2 retries, 200 ms backoff).
   */
  maxBinaryRetries?: number;
  retryBackoffMs?: number;
  retryableStatuses?: ReadonlySet<string>;
}

export async function startNfsRuntime(
  options: StartNfsRuntimeOptions,
): Promise<NfsRuntimeHandle> {
  // 1. Read + parse the IPO.
  const bytes = readFileSync(options.ipoPath);
  const ipo = parseIpo(bytes);

  // 2. CABI state. Pre-seed cabd-pars / system-data if asked.
  const state = new CabiState();
  for (const [k, v] of Object.entries(options.cabdPars ?? {})) state.cabdPars.set(k, v);
  for (const [k, v] of Object.entries(options.systemData ?? {})) state.systemData.set(k, v);

  // 3. EDIABAS provider — caller-supplied or fresh mock. Same
  //    instance is wired into both the inpax runtime (so the VM's
  //    own internal callers can see it) AND the syscall overrides
  //    (so our CDHapiJob handler dispatches through it).
  const ediabas: IEdiabasProvider = options.ediabas ?? new MockEdiabasProvider();

  // 4. System-function overrides — the NCSEXPER-style slot table.
  const systemFunctions = buildSystemFunctions(state, {
    ediabas,
    defaultSgbd: options.sgbd,
    workingDir: options.workingDir,
    firmwareSource: options.firmwareSource,
    maxBinaryRetries: options.maxBinaryRetries,
    retryBackoffMs: options.retryBackoffMs,
    retryableStatuses: options.retryableStatuses,
  });

  // 5. Build the VM. All UI / simulation / etc. providers are
  //    null — NFS IPOs we run for the hello-world path are
  //    batch-mode (Jobs / Ident / AifLesen / …); no screens,
  //    menus, or state-machines fire.
  const vm = new VM(ipo, {
    runtime: {
      ui: new NullUIProvider(),
      ediabas,
      simulation: new NullSimulationProvider(),
      print: new NullPrintProvider(),
      pem: new NullPemProvider(),
      dtm: new NullDtmProvider(),
      external: new NullExternalProvider(),
      sps: new NullSpsProvider(),
    },
    systemFunctions,
    debug: process.env.NFSX_VM_DEBUG === '1',
  });

  // 5. Pre-seed common globals NCSEXPER's MFC UI would set before
  //    invoking the IPO. Two known ones today:
  //
  //      global[11] = "Standard"  ← ProzessorTyp (per
  //                                  16ACC65.ipo's cabimain check)
  //
  //    These mappings come from cabimain disassembly observation;
  //    when other IPOs show different global checks we extend.
  const globals = vm.getGlobals();
  if (globals.length > 11) {
    globals[11] = {
      type: ValueType.String,
      flags: StackEntryFlags.ByValue,
      value: 'Standard',
    };
  }

  // We DON'T run `__inpa_startup__` — for NCSEXPER-style CABI
  // dispatchers it isn't required, and the null providers can't
  // service the interactive startup paths some NFS IPOs use. ncsx
  // runs it but catches errors; we skip outright since we've
  // seeded the globals startup would populate.

  const runCabimain = async (jobName: string): Promise<void> => {
    const cabimain = findFunction(vm, 'cabimain');
    if (!cabimain) {
      throw new Error(
        `cabimain not found in ${options.ipoPath} — this IPO isn't a CABI-style dispatcher`,
      );
    }
    // Seed JOBNAME so cabimain's CDHGetCabdPar("JOBNAME") returns
    // the right value. Also push it onto the local stack as
    // local[0] (defensive — some IPOs read it from there too).
    state.cabdPars.set('JOBNAME', jobName);
    const ctx = vm.createExecutionContext();
    ctx.pushString(jobName);
    await vm.executeBlockWithContext(cabimain, ctx);
  };

  return { ipoPath: options.ipoPath, vm, state, ediabas, runCabimain };
}

function findFunction(vm: VM, name: string): FunctionBlock | undefined {
  for (const block of vm.getIpo().functions.values()) {
    if (block.header.name === name) return block;
  }
  return undefined;
}
