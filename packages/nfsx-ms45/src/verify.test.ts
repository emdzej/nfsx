import { describe, it, expect } from 'vitest';
import { MockIEdiabas } from './mock-ediabas.js';
import { verifyFlashSignature, flashProgrammingStatus, resetEcu } from './verify.js';

describe('verifyFlashSignature', () => {
  it('sends "Daten;64" for tune blobs', async () => {
    const m = new MockIEdiabas();
    m.setResults('FLASH_SIGNATUR_PRUEFEN', {});
    await verifyFlashSignature(m, 'D_Motor', 'tune');
    expect(m.calls).toEqual([
      { ecu: 'D_Motor', job: 'FLASH_SIGNATUR_PRUEFEN', arg: 'Daten;64' },
    ]);
  });

  it('sends "Programm;64" for program blobs', async () => {
    const m = new MockIEdiabas();
    m.setResults('FLASH_SIGNATUR_PRUEFEN', {});
    await verifyFlashSignature(m, 'D_Motor', 'program');
    expect(m.calls[0]!.arg).toBe('Programm;64');
  });

  it('surfaces non-OKAY as Ms45JobError', async () => {
    const m = new MockIEdiabas();
    m.setResponse('FLASH_SIGNATUR_PRUEFEN', undefined, () => ({
      sets: [{ JOB_STATUS: { name: 'JOB_STATUS', type: 'text', value: 'ERROR_SIG_INVALID' } }],
    }));
    await expect(verifyFlashSignature(m, 'D_Motor', 'tune')).rejects.toMatchObject({
      job: 'FLASH_SIGNATUR_PRUEFEN',
      jobStatus: 'ERROR_SIG_INVALID',
    });
  });
});

describe('flashProgrammingStatus', () => {
  it('returns FLASH_PROGRAMMIER_STATUS_TEXT', async () => {
    const m = new MockIEdiabas();
    m.setResults('FLASH_PROGRAMMIER_STATUS_LESEN', {
      FLASH_PROGRAMMIER_STATUS_TEXT: 'Programmierung erfolgreich',
    });
    const s = await flashProgrammingStatus(m, 'D_Motor');
    expect(s).toBe('Programmierung erfolgreich');
  });
});

describe('resetEcu', () => {
  it('dispatches STEUERGERAETE_RESET', async () => {
    const m = new MockIEdiabas();
    m.setResults('STEUERGERAETE_RESET', {});
    await resetEcu(m, 'D_Motor');
    expect(m.calls.map((c) => c.job)).toEqual(['STEUERGERAETE_RESET']);
  });
});
