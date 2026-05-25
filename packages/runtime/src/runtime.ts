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

  // 3. System-function overrides — the NCSEXPER-style slot table.
  const systemFunctions = buildSystemFunctions(state);

  // 4. Build the VM. All providers are null/mock — NFS IPOs that
  //    we'll run for the hello-world path are batch-mode (Jobs /
  //    Ident / AifLesen / etc.); no screens, menus, or
  //    state-machines fire. EDIABAS calls (CDHapiJob) go to the
  //    mock provider, which returns empty result sets — fine for
  //    read-only verification, real ECU comes later.
  const vm = new VM(ipo, {
    runtime: {
      ui: new NullUIProvider(),
      ediabas: new MockEdiabasProvider(),
      simulation: new NullSimulationProvider(),
      print: new NullPrintProvider(),
      pem: new NullPemProvider(),
      dtm: new NullDtmProvider(),
      external: new NullExternalProvider(),
      sps: new NullSpsProvider(),
    },
    systemFunctions,
    debug: false,
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

  return { ipoPath: options.ipoPath, vm, state, runCabimain };
}

function findFunction(vm: VM, name: string): FunctionBlock | undefined {
  for (const block of vm.getIpo().functions.values()) {
    if (block.header.name === name) return block;
  }
  return undefined;
}
