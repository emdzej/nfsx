import { describe, it, expect } from 'vitest';
import { MockIEdiabas } from './mock-ediabas.js';
import {
  enterProgrammingMode,
  leaveProgrammingMode,
  suspendNormalTraffic,
} from './session-control.js';

function registerNoopResults(mock: MockIEdiabas, jobs: string[]): void {
  for (const job of jobs) mock.setResults(job, {});
}

describe('enterProgrammingMode', () => {
  it('runs the 4-step baud raise choreography for MS45.0 (DS2)', async () => {
    const m = new MockIEdiabas();
    registerNoopResults(m, [
      'diagnose_mode',
      'SET_PARAMETER',
      'ACCESS_TIMING_PARAMETER',
    ]);
    await enterProgrammingMode(m, 'D_Motor', 'DS2');
    expect(m.calls.map((c) => ({ job: c.job, arg: c.arg }))).toEqual([
      { job: 'diagnose_mode', arg: 'ECUPM;PC115200' },
      { job: 'SET_PARAMETER', arg: ';115200' },
      { job: 'ACCESS_TIMING_PARAMETER', arg: '00;120;24;240;00' },
      { job: 'SET_PARAMETER', arg: ';115200;;15' },
    ]);
  });

  it('runs a single diagnose_mode ECUPM job for MS45.1 (BMW-FAST)', async () => {
    const m = new MockIEdiabas();
    m.setResults('diagnose_mode', {});
    await enterProgrammingMode(m, 'D_Motor', 'BMW-FAST');
    expect(m.calls).toEqual([
      { ecu: 'D_Motor', job: 'diagnose_mode', arg: 'ECUPM' },
    ]);
  });
});

describe('leaveProgrammingMode', () => {
  it('drops back to 9600 baud on DS2', async () => {
    const m = new MockIEdiabas();
    registerNoopResults(m, ['diagnose_mode', 'SET_PARAMETER']);
    await leaveProgrammingMode(m, 'D_Motor', 'DS2');
    expect(m.calls.map((c) => ({ job: c.job, arg: c.arg }))).toEqual([
      { job: 'diagnose_mode', arg: 'DEFAULT;PC9600' },
      { job: 'SET_PARAMETER', arg: ';9600' },
    ]);
  });

  it('re-enables normal traffic on BMW-FAST', async () => {
    const m = new MockIEdiabas();
    registerNoopResults(m, ['diagnose_mode', 'normaler_datenverkehr']);
    await leaveProgrammingMode(m, 'D_Motor', 'BMW-FAST');
    expect(m.calls.map((c) => ({ job: c.job, arg: c.arg }))).toEqual([
      { job: 'diagnose_mode', arg: 'DEFAULT' },
      { job: 'normaler_datenverkehr', arg: 'ja;nein;ja' },
    ]);
  });
});

describe('suspendNormalTraffic', () => {
  it('sends the two-step normaler_datenverkehr sequence on BMW-FAST', async () => {
    const m = new MockIEdiabas();
    m.setResults('normaler_datenverkehr', {});
    await suspendNormalTraffic(m, 'D_Motor', 'BMW-FAST');
    expect(m.calls.map((c) => c.arg)).toEqual(['nein;nein;ja', 'ja;nein;nein']);
  });

  it('is a no-op on DS2', async () => {
    const m = new MockIEdiabas();
    await suspendNormalTraffic(m, 'D_Motor', 'DS2');
    expect(m.calls).toEqual([]);
  });
});
