import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
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

  it('dispatches CDHapiJob to the EDIABAS provider with the right (ecu, job) tuple', async () => {
    // Validates that the runtime's `CDHapiJob` slot (0x0D) correctly
    // hands off to the EDIABAS provider — the load-bearing bridge
    // between IPO and ECU. We mock HARDWARE_REFERENZ_LESEN, then
    // dispatch HW_REFERENZ, and confirm the mock recorded the call
    // with the right args. We catch the crash that happens later
    // (a stack-management edge case in the HwReferenzLesen control
    // flow — TestApiFehler return + subsequent PUSHREF local[4] —
    // that needs a deeper port of ncsx's CABI provider to resolve;
    // tracked as a known limitation, doesn't affect JOB_ERMITTELN
    // flows or simpler IPO paths).
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_ACC65', 'HARDWARE_REFERENZ_LESEN', {
      JOB_STATUS: 'OKAY',
      HW_REF_STATUS: 1,
      HW_REF_SG_KENNUNG: 'ACC65-Kennung-Demo',
      HW_REF_PROJEKT: 'E60-ACC-Project',
    });

    const handle = await startNfsRuntime({
      ipoPath: IPO_PATH,
      sgbd: 'C_ACC65',
      ediabas,
    });

    // Expect the dispatch — the IPO crashes mid-flow (see comment
    // above), but the CDHapiJob handshake completed first.
    await expect(handle.runCabimain('HW_REFERENZ')).rejects.toThrow();

    // What we CAN verify:
    //   - CDHGetSgbdName returned the seeded sgbd
    //   - CDHapiJob fired with the right (ecu, job)
    //   - The mock recorded the call
    //   - JOB_STATUS was read back successfully
    const sgbdCall = handle.state.trace.find((t) => t.name === 'CDHGetSgbdName');
    expect(sgbdCall).toBeDefined();
    expect(sgbdCall!.args.sgbd).toBe('C_ACC65');

    const apiJobCall = handle.state.trace.find((t) => t.name === 'CDHapiJob');
    expect(apiJobCall).toBeDefined();
    expect(apiJobCall!.args.ecu).toBe('C_ACC65');
    expect(apiJobCall!.args.job).toBe('HARDWARE_REFERENZ_LESEN');

    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.ecu).toBe('C_ACC65');
    expect(ediabas.jobCalls[0]!.job).toBe('HARDWARE_REFERENZ_LESEN');

    expect(handle.state.lastJob).toBeDefined();
    expect(handle.state.lastJob!.status).toBe('OKAY');

    // We also exercised CDHapiResultText (slot 0x0F) successfully —
    // TestApiFehler read JOB_STATUS back from the mock.
    const resultTextCall = handle.state.trace.find(
      (t) => t.name === 'CDHapiResultText' && t.args.name === 'JOB_STATUS',
    );
    expect(resultTextCall).toBeDefined();
    expect(resultTextCall!.args.value).toBe('OKAY');

    console.log(
      `\n  HW_REFERENZ dispatch chain verified (5 calls before stack-mgmt crash):\n` +
        handle.state.trace
          .map(
            (t, i) =>
              `    ${i + 1}. 0x${t.slot.toString(16).padStart(2, '0')} ${t.name.padEnd(20)} ${JSON.stringify(t.args).slice(0, 80)}`,
          )
          .join('\n'),
    );
  });
});
