import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { startNfsRuntimeFromPath } from './node.js';

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
    const handle = await startNfsRuntimeFromPath(IPO_PATH, { });

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
    const handle = await startNfsRuntimeFromPath(IPO_PATH, { });

    // cabimain switches on JOBNAME; an unknown one falls through
    // without populating any JOB[*] entries.
    await handle.runCabimain('NOT_A_REAL_JOB');

    const jobEntries = [...handle.state.cabdPars.keys()].filter((k) => /^JOB\[\d+\]$/.test(k));
    expect(jobEntries).toEqual([]);
  });

  it('dispatches CDHapiJob to the EDIABAS provider and reads results back', async () => {
    // End-to-end validation of the HwReferenzLesen flow:
    //   - CDHGetSgbdName returns the seeded sgbd
    //   - CDHapiJob fires with the right (ecu, job) and reads results
    //   - The mock recorded the call
    //   - CDHapiResultText reads JOB_STATUS / HW_REF_SG_KENNUNG / HW_REF_PROJEKT
    //   - cabimain returns cleanly (no stack-mgmt crash)
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_ACC65', 'HARDWARE_REFERENZ_LESEN', {
      JOB_STATUS: 'OKAY',
      HW_REF_STATUS: 1,
      HW_REF_SG_KENNUNG: 'ACC65-Kennung-Demo',
      HW_REF_PROJEKT: 'E60-ACC-Project',
    });

    const handle = await startNfsRuntimeFromPath(IPO_PATH, {
      sgbd: 'C_ACC65',
      ediabas,
    });

    await handle.runCabimain('HW_REFERENZ');

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

    const jobStatusRead = handle.state.trace.find(
      (t) => t.name === 'CDHapiResultText' && t.args.name === 'JOB_STATUS',
    );
    expect(jobStatusRead).toBeDefined();
    expect(jobStatusRead!.args.value).toBe('OKAY');

    console.log(
      `\n  HW_REFERENZ dispatch chain (${handle.state.trace.length} calls):\n` +
        handle.state.trace
          .map(
            (t, i) =>
              `    ${i + 1}. 0x${t.slot.toString(16).padStart(2, '0')} ${t.name.padEnd(20)} ${JSON.stringify(t.args).slice(0, 80)}`,
          )
          .join('\n'),
    );
  });

  it('SG_IDENT_LESEN — dispatches IDENT and publishes identity fields on success', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_ACC65', 'IDENT', {
      JOB_STATUS: 'OKAY',
      ID_BMW_NR: '6985684',
      ID_HW_NR: '04',
      ID_DIAG_INDEX: '03',
      ID_COD_INDEX: '02',
      ID_VAR_INDEX: '01',
      ID_DATUM: '15.03.2008',
      ID_LIEF_NR: '0152',
      ID_LIEF_TEXT: 'Conti',
      ID_SW_NR_MCV: 'A1B2C3',
      ID_SW_NR_FSV: 'D4E5F6',
      ID_SW_NR_OSV: '789ABC',
      ID_SW_NR_RES: '000000',
      ID_DATUM_TAG: 15,
      ID_DATUM_MONAT: 3,
      ID_DATUM_JAHR: 2008,
    });

    const handle = await startNfsRuntimeFromPath(IPO_PATH, {
      sgbd: 'C_ACC65',
      ediabas,
    });

    await handle.runCabimain('SG_IDENT_LESEN');

    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.job).toBe('IDENT');
    expect(handle.state.lastJob!.status).toBe('OKAY');

    // Spot-check published cabd-pars from the happy path.
    expect(handle.state.cabdPars.get('ID_BMW_NR')).toBe('6985684');
    expect(handle.state.cabdPars.get('ID_LIEF_TEXT')).toBe('Conti');
    expect(handle.state.cabdPars.get('ID_SW_NR_MCV')).toBe('A1B2C3');

    const apiJobs = handle.state.trace.filter((t) => t.name === 'CDHapiJob');
    console.log(
      `\n  SG_IDENT_LESEN (OK) — ${handle.state.trace.length} syscalls, ${apiJobs.length} apiJob, JOB_STATUS=${handle.state.lastJob!.status}`,
    );
  });

  it('SG_IDENT_LESEN — error path terminates cleanly when JOB_STATUS is empty', async () => {
    // No mock data → JOB_STATUS comes back empty → IPO takes the
    // error path (SetError → SetReturnVal → exit). With vm.stop()
    // wired, the trace ends right after the first exit instead of
    // running through the happy-path reads with stale data.
    const ediabas = new MockEdiabasProvider();
    const handle = await startNfsRuntimeFromPath(IPO_PATH, {
      sgbd: 'C_ACC65',
      ediabas,
    });

    await handle.runCabimain('SG_IDENT_LESEN');

    const lastSlot = handle.state.trace.at(-1);
    expect(lastSlot?.name).toBe('exit');

    const errors = handle.state.trace.filter((t) => t.name === 'CDHSetError');
    expect(errors.length).toBeGreaterThan(0);

    // Happy-path reads should NOT have fired.
    const happyReads = handle.state.trace.filter(
      (t) => t.name === 'CDHapiResultText' && (t.args.name === 'ID_BMW_NR' || t.args.name === 'ID_LIEF_TEXT'),
    );
    expect(happyReads).toHaveLength(0);
  });

  it('SG_AIF_LESEN — happy path reads AIF metadata', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_ACC65', 'AIF_LESEN', {
      JOB_STATUS: 'OKAY',
      AIF_GROESSE: 256,
      AIF_ADRESSE_LOW: 0x1000,
      AIF_ADRESSE_HIGH: 0,
      AIF_ANZ_FREI: 4,
      AIF_FG_NR_LANG: 'WBAAB12345CD67890',
      AIF_DATUM: '15.03.2008',
      AIF_SW_NR: 'SW-001',
      AIF_BEHOERDEN_NR: 'B12345',
      AIF_ZB_NR: 'ZB-9876',
      AIF_SERIEN_NR: 'SN-12345',
      AIF_HAENDLER_NR: 'D-007',
      AIF_KM: '12345',
      AIF_PROG_NR: 'P-001',
    });

    const handle = await startNfsRuntimeFromPath(IPO_PATH, {
      sgbd: 'C_ACC65',
      ediabas,
    });

    await handle.runCabimain('SG_AIF_LESEN');

    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.job).toBe('AIF_LESEN');
    expect(handle.state.lastJob!.status).toBe('OKAY');

    expect(handle.state.cabdPars.get('AIF_FG_NR')).toBe('WBAAB12345CD67890');
    expect(handle.state.cabdPars.get('AIF_ZB_NR')).toBe('ZB-9876');
    expect(handle.state.cabdPars.get('AIF_KM')).toBe('12345');

    console.log(
      `\n  SG_AIF_LESEN (OK) — ${handle.state.trace.length} syscalls, JOB_STATUS=${handle.state.lastJob!.status}`,
    );
  });

  it('SG_STATUS_LESEN — reads flash programming status', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_ACC65', 'FLASH_PROGRAMMIER_STATUS_LESEN', {
      JOB_STATUS: 'OKAY',
      FLASH_PROGRAMMIER_STATUS: 7, // arbitrary mock value
    });

    const handle = await startNfsRuntimeFromPath(IPO_PATH, {
      sgbd: 'C_ACC65',
      ediabas,
    });

    await handle.runCabimain('SG_STATUS_LESEN');

    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.job).toBe('FLASH_PROGRAMMIER_STATUS_LESEN');
    expect(handle.state.lastJob!.status).toBe('OKAY');

    console.log(
      `\n  SG_STATUS_LESEN (OK) — ${handle.state.trace.length} syscalls, JOB_STATUS=${handle.state.lastJob!.status}`,
    );
  });
});

/**
 * Phase 4 — FSC/cert workflow via the `00swt*.ipo` family.
 *
 * Each transport-specific 00swt*.ipo (DS2/DSC/EPS/KWP/KWS/MSD)
 * exposes the same 20-job CABI surface for FSC + cert + identity
 * management. The IPOs are thin wrappers around SGBD apiJob calls
 * with a standardised JOB_STATUS / JOB_STATUS_CODE → API_RESULT_CODE
 * / API_RESULT result-reporting pattern. The host pre-seeds
 * AUTH_MODE / SGBD_NAME / VARIANT / AUTH_KIND / APP_NR /
 * UPGRADE_INDEX cabd-pars before dispatch.
 */
const SWT_KWP_PATH = `${process.env.HOME}/Downloads/inpa/EC-APPS/NFS/SGDAT/00swtkwp.ipo`;

describe.skipIf(!existsSync(SWT_KWP_PATH))('Phase 4 — FSC + cert workflow (00swt*.ipo)', () => {
  it('CHECK_FSC — dispatches FREISCHALTCODE_PRUEFEN with the standard FSC result pattern', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_DSC_KWP', 'FREISCHALTCODE_PRUEFEN', {
      JOB_STATUS: 'OKAY',
      JOB_STATUS_CODE: 0,
    });

    const handle = await startNfsRuntimeFromPath(SWT_KWP_PATH, {
      sgbd: 'C_DSC_KWP',
      ediabas,
      cabdPars: {
        AUTH_MODE: '0',
        SGBD_NAME: 'C_DSC_KWP',
        VARIANT: 'DSC60',
        AUTH_KIND: '1',
        APP_NR: '01',
        UPGRADE_INDEX: '00',
      },
    });

    await handle.runCabimain('CHECK_FSC');

    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.job).toBe('FREISCHALTCODE_PRUEFEN');
    expect(handle.state.lastJob!.status).toBe('OKAY');

    // Verify the host-seeded cabd-pars were read by the IPO. Look
    // at the trace — every CDHGetCabdPar for AUTH_MODE/SGBD_NAME/etc
    // should return our seeded value, not empty string.
    const authModeRead = handle.state.trace.find(
      (t) => t.name === 'CDHGetCabdPar' && t.args.name === 'AUTH_MODE',
    );
    expect(authModeRead?.args.value).toBe('0');

    const sgbdRead = handle.state.trace.find(
      (t) => t.name === 'CDHGetCabdPar' && t.args.name === 'SGBD_NAME',
    );
    expect(sgbdRead?.args.value).toBe('C_DSC_KWP');
  });

  it('CHECK_FSC — error path publishes API_RESULT_CODE / API_RESULT', async () => {
    // When the SGBD doesn't respond (JOB_STATUS empty), the IPO
    // falls into the error path and publishes API_RESULT_CODE +
    // API_RESULT cabd-pars so the host can surface the failure to
    // the user.
    const ediabas = new MockEdiabasProvider();
    const handle = await startNfsRuntimeFromPath(SWT_KWP_PATH, {
      sgbd: 'C_DSC_KWP',
      ediabas,
    });

    await handle.runCabimain('CHECK_FSC');

    // API_RESULT_CODE + API_RESULT are published on the error path.
    expect(handle.state.cabdPars.has('API_RESULT_CODE')).toBe(true);
    expect(handle.state.cabdPars.has('API_RESULT')).toBe(true);

    const errorCall = handle.state.trace.find(
      (t) => t.name === 'CDHSetError' && t.args.proc === 'CheckFsc',
    );
    expect(errorCall).toBeDefined();
  });

  it('GET_VIN — dispatches FAHRGESTELLNUMMER_LESEN', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_DSC_KWP', 'FAHRGESTELLNUMMER_LESEN', {
      JOB_STATUS: 'OKAY',
      JOB_STATUS_CODE: 0,
      FAHRGESTELL_NR: 'WBAVB13546PT12345',
    });

    const handle = await startNfsRuntimeFromPath(SWT_KWP_PATH, {
      sgbd: 'C_DSC_KWP',
      ediabas,
      cabdPars: {
        AUTH_MODE: '0',
        SGBD_NAME: 'C_DSC_KWP',
        VARIANT: 'DSC60',
        AUTH_KIND: '1',
      },
    });

    await handle.runCabimain('GET_VIN');

    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.job).toBe('FAHRGESTELLNUMMER_LESEN');
    expect(handle.state.lastJob!.status).toBe('OKAY');
  });

  it('GET_TIME — no apiJob, returns the host-seeded TIME cabd-par', async () => {
    // GET_TIME is one of the few jobs that doesn't issue an apiJob —
    // it reads/republishes a TIME cabd-par the host pre-seeded.
    // Default ("000000000000Z") is the IPO's epoch when host didn't
    // set one.
    const ediabas = new MockEdiabasProvider();
    const handle = await startNfsRuntimeFromPath(SWT_KWP_PATH, {
      sgbd: 'C_DSC_KWP',
      ediabas,
      cabdPars: {
        AUTH_MODE: '0',
        SGBD_NAME: 'C_DSC_KWP',
        VARIANT: 'DSC60',
        AUTH_KIND: '1',
      },
    });

    await handle.runCabimain('GET_TIME');

    expect(ediabas.jobCalls).toHaveLength(0);
    expect(handle.state.cabdPars.get('TIME')).toBe('000000000000Z');
  });

  it('JOB_ERMITTELN — all 6 transport variants expose the same 20-job FSC surface', async () => {
    // Sanity check across the 00swt*.ipo family — confirms the
    // dispatcher works on every transport variant, and that they
    // all share the same job vocabulary (only the underlying SGBD
    // differs).
    const variants = ['00swtds2', '00swtdsc', '00swteps', '00swtkwp', '00swtkws', '00swtmsd'];
    const expectedJobs = [
      'JOB_ERMITTELN', 'INFO', 'STORE_FSC', 'STORE_CERTIFICATE', 'DISABLE_FSC',
      'CHECK_CERTIFICATE', 'CHECK_FSC', 'GET_CERTIFICATE', 'GET_FSC', 'GET_FSSTATUS',
      'GET_SWID', 'GET_ALL_SWID', 'GET_SIGSID', 'PERIODICAL_CHECK', 'FINGERPRINT_CHECK',
      'GET_TIME', 'SET_TIME', 'GET_VIN', 'SET_VIN', 'KEYFAKTOR_LESEN',
    ];

    for (const variant of variants) {
      const path = `${process.env.HOME}/Downloads/inpa/EC-APPS/NFS/SGDAT/${variant}.ipo`;
      if (!existsSync(path)) continue;
      const handle = await startNfsRuntimeFromPath(path, {});
      await handle.runCabimain('JOB_ERMITTELN');
      const published = [...handle.state.cabdPars.entries()]
        .filter(([k]) => /^JOB\[\d+\]$/.test(k))
        .sort(([a], [b]) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
        .map(([, v]) => v);
      expect(published).toEqual(expectedJobs);
    }
  });
});
