/**
 * `nfsx run <ipo> --job <name>` — load an NFS IPO and dispatch the
 * given job via cabimain.
 *
 * Phase 3 hello-world: proves that the inpax VM + ncsx-style CABI
 * runtime can execute NFS IPOs end-to-end without code changes to
 * inpax (the slot-ID-compat hypothesis confirmed in
 * docs/architecture.md §9.5). After dispatch the CLI prints the
 * cabd-pars the IPO published, the last JOB_STATUS, and a syscall
 * trace.
 *
 * Default job is JOB_ERMITTELN — the metadata-publishing job every
 * NFS dispatcher implements. It populates JOB[1..N] cabd-pars with
 * the jobs the IPO supports.
 */

import { readFileSync } from 'node:fs';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { startNfsRuntime } from '@emdzej/nfsx-runtime';
import type { RunOptions } from './cli.js';

export async function runRun(flags: RunOptions): Promise<number> {
  const ediabas = flags.mockFile ? loadMockProvider(flags.mockFile) : undefined;

  const handle = await startNfsRuntime({
    ipoPath: flags.ipoPath,
    sgbd: flags.sgbd,
    ediabas,
  });
  await handle.runCabimain(flags.job);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ipoPath: flags.ipoPath,
          job: flags.job,
          lastJobStatus: handle.state.lastJobStatus,
          cabdPars: Object.fromEntries(handle.state.cabdPars),
          systemData: Object.fromEntries(handle.state.systemData),
          trace: handle.state.trace,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  process.stdout.write(`\nIPO:  ${flags.ipoPath}\n`);
  process.stdout.write(`Job:  ${flags.job}\n`);
  process.stdout.write(`Status: ${handle.state.lastJobStatus}\n\n`);

  // Pretty-print the JOB[*] entries if any — that's the
  // JOB_ERMITTELN happy path.
  const jobs = collectJobEntries(handle.state.cabdPars);
  if (jobs.length > 0) {
    process.stdout.write(`Published jobs (${jobs.length}):\n`);
    for (const j of jobs) {
      process.stdout.write(`  JOB[${j.index}] = ${j.name}\n`);
    }
    process.stdout.write(`\n`);
  }

  // Anything else the IPO wrote — surface as a flat list.
  const others = [...handle.state.cabdPars].filter(
    ([k]) => !/^JOB\[\d+\]$/.test(k) && k !== 'JOBNAME',
  );
  if (others.length > 0) {
    process.stdout.write(`Other cabd-pars set (${others.length}):\n`);
    for (const [k, v] of others) {
      process.stdout.write(`  ${k} = ${v}\n`);
    }
    process.stdout.write(`\n`);
  }

  if (handle.state.systemData.size > 0) {
    process.stdout.write(`System-data (${handle.state.systemData.size}):\n`);
    for (const [k, v] of handle.state.systemData) {
      process.stdout.write(`  ${k} = ${v}\n`);
    }
    process.stdout.write(`\n`);
  }

  if (flags.trace) {
    process.stdout.write(`Syscall trace (${handle.state.trace.length}):\n`);
    for (const t of handle.state.trace) {
      process.stdout.write(
        `  0x${t.slot.toString(16).padStart(2, '0')} ${t.name.padEnd(20)} ${JSON.stringify(t.args)}\n`,
      );
    }
  }

  return 0;
}

function collectJobEntries(cabdPars: Map<string, string>): Array<{ index: number; name: string }> {
  const jobs: Array<{ index: number; name: string }> = [];
  for (const [k, v] of cabdPars) {
    const m = k.match(/^JOB\[(\d+)\]$/);
    if (m) jobs.push({ index: Number.parseInt(m[1]!, 10), name: v });
  }
  return jobs.sort((a, b) => a.index - b.index);
}

function loadMockProvider(path: string): MockEdiabasProvider {
  const raw = readFileSync(path, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`error: --mock-file ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (!data || typeof data !== 'object') {
    process.stderr.write(`error: --mock-file ${path}: expected an object\n`);
    process.exit(2);
  }
  const provider = new MockEdiabasProvider();
  for (const [ecu, jobs] of Object.entries(data as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [job, results] of Object.entries(jobs)) {
      provider.setSimpleResult(ecu, job, results);
    }
  }
  return provider;
}
