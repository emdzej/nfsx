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

interface RunFlags {
  ipoPath?: string;
  job: string;
  sgbd?: string;
  mockFile?: string;
  json: boolean;
  help: boolean;
  trace: boolean;
}

const HELP = `nfsx run — execute an NFS IPO's cabimain dispatcher.

Usage:
  nfsx run <ipo-path> [--job <name>] [--sgbd <name>] [--mock-file <path>] [--trace] [--json]

Arguments:
  <ipo-path>           Path to the .IPO file (e.g. ~/Downloads/inpa/EC-APPS/NFS/SGDAT/16ACC65.ipo)

Options:
  --job <name>         JOBNAME to dispatch. Default: JOB_ERMITTELN.
  --sgbd <name>        SGBD basename returned by CDHGetSgbdName. Required for
                       jobs that issue apiJob calls (HW_REFERENZ, SG_IDENT_LESEN,
                       SG_AIF_LESEN, etc.). E.g. C_ACC65 for 16ACC65.ipo.
  --mock-file <path>   Path to a JSON file with mock EDIABAS results. Schema:
                         { "ECU_NAME": { "JOB_NAME": { "RESULT_KEY": value, ... } } }
                       JOB_STATUS = "OKAY" is a sensible default per job.
  --trace              Print every CABI syscall the IPO made.
  --json               Emit machine-readable JSON.
  --help               Show this help.

Examples:
  nfsx run 16ACC65.ipo
  nfsx run 16ACC65.ipo --job HW_REFERENZ --sgbd C_ACC65 --mock-file mock.json
  nfsx run 16ACC65.ipo --job SG_IDENT_LESEN --sgbd C_ACC65 --trace
`;

export async function runRun(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!flags.ipoPath) {
    process.stderr.write('error: <ipo-path> is required\n\n');
    process.stderr.write(HELP);
    return 2;
  }

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

function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = { job: 'JOB_ERMITTELN', json: false, help: false, trace: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--trace':
        flags.trace = true;
        break;
      case '--job':
        flags.job = takeValue(args, i);
        i++;
        break;
      case '--sgbd':
        flags.sgbd = takeValue(args, i);
        i++;
        break;
      case '--mock-file':
        flags.mockFile = takeValue(args, i);
        i++;
        break;
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`error: unknown flag "${a}"\n\n`);
          process.stderr.write(HELP);
          process.exit(2);
        }
        if (flags.ipoPath !== undefined) {
          process.stderr.write(`error: unexpected extra argument "${a}"\n`);
          process.exit(2);
        }
        flags.ipoPath = a;
    }
  }

  return flags;
}

function takeValue(args: string[], idx: number): string {
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`error: ${args[idx]} requires a value\n`);
    process.exit(2);
  }
  return v;
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
