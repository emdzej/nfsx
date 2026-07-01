import { describe, it, expect } from 'vitest';
import { MockIEdiabas, buildResponse } from './mock-ediabas.js';
import {
  runJob,
  getJobStatus,
  getResultString,
  getResultBinary,
  requireResultString,
  requireResultBinary,
  Ms45JobError,
} from './ms45-ediabas.js';

describe('runJob', () => {
  it('returns the response on OKAY status', async () => {
    const m = new MockIEdiabas();
    m.setResults('aif_lesen', { AIF_FG_NR: 'WBAEP31060PE84104' });
    const resp = await runJob(m, 'D_Motor', 'aif_lesen');
    expect(getResultString(resp, 'AIF_FG_NR')).toBe('WBAEP31060PE84104');
    expect(m.calls).toEqual([{ ecu: 'D_Motor', job: 'aif_lesen', arg: undefined }]);
  });

  it('throws Ms45JobError when JOB_STATUS is not OKAY', async () => {
    const m = new MockIEdiabas();
    m.setResponse('flash_schreiben', undefined, () =>
      buildResponse({}, 'ERROR_FLASH_WRITE_FAILED'),
    );
    await expect(runJob(m, 'D_Motor', 'flash_schreiben')).rejects.toBeInstanceOf(Ms45JobError);
    await expect(runJob(m, 'D_Motor', 'flash_schreiben')).rejects.toMatchObject({
      job: 'flash_schreiben',
      jobStatus: 'ERROR_FLASH_WRITE_FAILED',
    });
  });

  it('propagates exceptions from the underlying IEdiabas', async () => {
    const m = new MockIEdiabas();
    // No registration → mock throws.
    await expect(runJob(m, 'D_Motor', 'no_such_job')).rejects.toBeInstanceOf(Ms45JobError);
  });

  it('routes an exact arg match ahead of the wildcard registration', async () => {
    const m = new MockIEdiabas();
    m.setResponse('speicher_lesen_ascii', undefined, () =>
      buildResponse({ DATEN: new Uint8Array([0x00, 0x00, 0x00]) }),
    );
    m.setResponse('speicher_lesen_ascii', 'ROMX;262144;254', () =>
      buildResponse({ DATEN: new Uint8Array([0xaa, 0xbb, 0xcc]) }),
    );
    const resp = await runJob(m, 'D_Motor', 'speicher_lesen_ascii', 'ROMX;262144;254');
    expect(Array.from(getResultBinary(resp, 'DATEN')!)).toEqual([0xaa, 0xbb, 0xcc]);
  });
});

describe('result extractors', () => {
  it('getJobStatus finds JOB_STATUS across sets', () => {
    const r = buildResponse({}, 'OKAY');
    expect(getJobStatus(r)).toBe('OKAY');
  });

  it('getResultString returns null when the name is absent', () => {
    const r = buildResponse({});
    expect(getResultString(r, 'MISSING')).toBeNull();
  });

  it('getResultBinary decodes the number[] payload as Uint8Array', () => {
    const r = buildResponse({ DATEN: new Uint8Array([1, 2, 3, 4]) });
    expect(Array.from(getResultBinary(r, 'DATEN')!)).toEqual([1, 2, 3, 4]);
  });

  it('requireResultString throws Ms45JobError on missing field', () => {
    const r = buildResponse({});
    expect(() => requireResultString(r, 'aif_lesen', 'AIF_FG_NR')).toThrow(Ms45JobError);
  });

  it('requireResultBinary throws on missing field', () => {
    const r = buildResponse({});
    expect(() => requireResultBinary(r, 'flash_schreiben', 'DATEN')).toThrow(
      /missing binary result/,
    );
  });
});
