import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { startNfsRuntime } from './runtime.js';

/**
 * Hello-world test for the runtime: load a real NFS IPO, dispatch
 * cabimain via JOB_ERMITTELN, confirm the IPO published its job
 * list via the CABI store.
 *
 * Self-skips when the SP-Daten install isn't present.
 */

const IPO_PATH = `${process.env.HOME}/Downloads/inpa/EC-APPS/NFS/SGDAT/16ACC65.ipo`;

describe.skipIf(!existsSync(IPO_PATH))('startNfsRuntime — Phase 3 hello-world', () => {
  it('runs cabimain(JOB_ERMITTELN) on a real NFS IPO and captures the published job list', async () => {
    const handle = await startNfsRuntime({ ipoPath: IPO_PATH });

    await handle.runCabimain('JOB_ERMITTELN');

    // After dispatch, the IPO's Jobs() function should have
    // published JOB[1], JOB[2], … cabd-pars.
    const jobEntries: Array<{ index: number; name: string }> = [];
    for (const [key, value] of handle.state.cabdPars) {
      const m = key.match(/^JOB\[(\d+)\]$/);
      if (m) jobEntries.push({ index: Number.parseInt(m[1]!, 10), name: value });
    }
    jobEntries.sort((a, b) => a.index - b.index);

    expect(jobEntries.length).toBeGreaterThan(5);

    // The first published job is always JOB_ERMITTELN (re-publishing
    // its own dispatch key — confirms the Jobs() function ran from
    // the top).
    expect(jobEntries[0]!.name).toBe('JOB_ERMITTELN');

    // Other expected job names from the disassembly (must be present
    // somewhere in the list — order is IPO-defined).
    const names = jobEntries.map((j) => j.name);
    expect(names).toContain('INFO');
    expect(names).toContain('SG_IDENT_LESEN');
    expect(names).toContain('SG_AIF_LESEN');
    expect(names).toContain('SG_PROGRAMMIEREN');

    console.log(
      `\n  Jobs published by 16ACC65.ipo (${jobEntries.length} total):\n` +
        jobEntries.map((j) => `    JOB[${j.index}] = ${j.name}`).join('\n'),
    );
    console.log(`  Last JOB_STATUS: ${handle.state.lastJobStatus}`);
    console.log(`  Syscall trace: ${handle.state.trace.length} calls`);
  });

  it('returns empty when an unknown JOBNAME is dispatched', async () => {
    const handle = await startNfsRuntime({ ipoPath: IPO_PATH });

    // cabimain switches on JOBNAME; an unknown one falls through
    // without populating any JOB[*] entries.
    await handle.runCabimain('NOT_A_REAL_JOB');

    const jobEntries = [...handle.state.cabdPars.keys()].filter((k) => /^JOB\[\d+\]$/.test(k));
    expect(jobEntries).toEqual([]);
  });
});
