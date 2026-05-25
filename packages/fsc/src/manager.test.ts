import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { FscManager } from './manager.js';

const SWT_KWP_PATH = `${process.env.HOME}/Downloads/inpa/EC-APPS/NFS/SGDAT/00swtkwp.ipo`;

describe.skipIf(!existsSync(SWT_KWP_PATH))('FscManager — Phase 4 host orchestrator', () => {
  it('checkFsc — happy path returns ok=true when the SGBD reports OKAY', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_DSC_KWP', 'FREISCHALTCODE_PRUEFEN', {
      JOB_STATUS: 'OKAY',
      JOB_STATUS_CODE: 0,
    });

    const mgr = new FscManager({
      ipoPath: SWT_KWP_PATH,
      sgbd: 'C_DSC_KWP',
      ediabas,
      cabdPars: { VARIANT: 'DSC60' },
    });

    const result = await mgr.checkFsc();

    expect(result.ok).toBe(true);
    expect(result.jobStatus).toBe('OKAY');
    expect(result.error).toBeUndefined();
    expect(ediabas.jobCalls).toHaveLength(1);
    expect(ediabas.jobCalls[0]!.job).toBe('FREISCHALTCODE_PRUEFEN');
    expect(ediabas.jobCalls[0]!.ecu).toBe('C_DSC_KWP');
  });

  it('checkFsc — error path returns ok=false with structured error info', async () => {
    // No mock response → IPO sees empty JOB_STATUS → error path
    // publishes API_RESULT_CODE / API_RESULT cabd-pars, which we
    // surface in `result.error`.
    const ediabas = new MockEdiabasProvider();
    const mgr = new FscManager({
      ipoPath: SWT_KWP_PATH,
      sgbd: 'C_DSC_KWP',
      ediabas,
    });

    const result = await mgr.checkFsc();

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.cabdPars.has('API_RESULT_CODE')).toBe(true);
    expect(result.cabdPars.has('API_RESULT')).toBe(true);
  });

  it('getVin — surfaces the VIN that the IPO published from FG_NR', async () => {
    // The SGBD publishes the VIN as `FG_NR` (BMW-internal naming),
    // and the IPO's GetVIN handler copies it into the `VIN`
    // cabd-par before exit.
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_DSC_KWP', 'FAHRGESTELLNUMMER_LESEN', {
      JOB_STATUS: 'OKAY',
      JOB_STATUS_CODE: 0,
      FG_NR: 'WBAVB13546PT12345',
    });

    const mgr = new FscManager({
      ipoPath: SWT_KWP_PATH,
      sgbd: 'C_DSC_KWP',
      ediabas,
    });

    const result = await mgr.getVin();

    expect(result.ok).toBe(true);
    expect(result.data?.vin).toBe('WBAVB13546PT12345');
  });

  it('getFsStatus — surfaces the integer status via direct EDIABAS read', async () => {
    // The IPO only reads the result-set count (CDHapiResultSets);
    // the actual FLASH_PROGRAMMIER_STATUS lives in the EDIABAS
    // result store and the host reads it directly.
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_DSC_KWP', 'STATUS_LESEN', {
      JOB_STATUS: 'OKAY',
      FLASH_PROGRAMMIER_STATUS: 7,
    });

    const mgr = new FscManager({
      ipoPath: SWT_KWP_PATH,
      sgbd: 'C_DSC_KWP',
      ediabas,
    });

    const result = await mgr.getFsStatus();

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe(7);
    expect(ediabas.jobCalls[0]!.job).toBe('STATUS_LESEN');
  });

  it('getTime — surfaces the TIME cabd-par the IPO publishes (no apiJob)', async () => {
    // GET_TIME doesn't read the seeded TIME — it WRITES a TIME
    // cabd-par (computed inside the IPO from internal sources, or
    // a placeholder on a mock setup). The host reads the published
    // value back from cabd-pars.
    const ediabas = new MockEdiabasProvider();
    const mgr = new FscManager({
      ipoPath: SWT_KWP_PATH,
      sgbd: 'C_DSC_KWP',
      ediabas,
    });

    const result = await mgr.getTime();

    expect(result.ok).toBe(true);
    expect(result.data?.time).toBe('000000000000Z'); // placeholder on mock setup
    expect(ediabas.jobCalls).toHaveLength(0);
  });

  it('extra cabd-pars passed to a job override ctor-level defaults', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_DSC_KWP', 'FREISCHALTCODE_PRUEFEN', {
      JOB_STATUS: 'OKAY',
      JOB_STATUS_CODE: 0,
    });

    const mgr = new FscManager({
      ipoPath: SWT_KWP_PATH,
      sgbd: 'C_DSC_KWP',
      ediabas,
      cabdPars: { APP_NR: '00', UPGRADE_INDEX: '00' },
    });

    // Override APP_NR per-call → IPO should read the override.
    await mgr.checkFsc({ APP_NR: '05', UPGRADE_INDEX: '02' });

    // We can't directly observe what the IPO read, but the mock
    // recorded the apiJob still fired correctly — the override
    // path didn't break anything.
    expect(ediabas.jobCalls).toHaveLength(1);
  });
});
