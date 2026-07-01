import { describe, it, expect } from 'vitest';
import { MockIEdiabas } from './mock-ediabas.js';
import { classifyVariant, isBmwFast, identifyDme } from './ident.js';
import { HW_REF_MS45_0, HW_REF_MS45_1 } from './regions.js';

describe('classifyVariant', () => {
  it('maps 0044560 → MS45.0', () => {
    expect(classifyVariant(HW_REF_MS45_0)).toBe('MS45.0');
  });
  it('maps 0044570 → MS45.1', () => {
    expect(classifyVariant(HW_REF_MS45_1)).toBe('MS45.1');
  });
  it('returns undefined for unknown refs', () => {
    expect(classifyVariant('9999999')).toBeUndefined();
  });
});

describe('isBmwFast', () => {
  it('true only for the exact "BMW-FAST" string', () => {
    expect(isBmwFast('BMW-FAST')).toBe(true);
    expect(isBmwFast('DS2')).toBe(false);
    expect(isBmwFast('bmw-fast')).toBe(false);
    expect(isBmwFast('')).toBe(false);
  });
});

function withHappyMs450(mock: MockIEdiabas): void {
  mock.setResults('aif_lesen', { AIF_FG_NR: 'WBAEP31060PE84104' });
  mock.setResults('hardware_referenz_lesen', { HARDWARE_REFERENZ: '0044560' });
  mock.setResults('daten_referenz_lesen', { DATEN_REFERENZ: '7551234' });
  mock.setResults('flash_programmier_status_lesen', {
    FLASH_PROGRAMMIER_STATUS_TEXT: 'Programmierung erfolgreich',
  });
  mock.setResults('DIAGNOSEPROTOKOLL_LESEN', { DIAG_PROT_IST: 'DS2' });
}

function withHappyMs451(mock: MockIEdiabas): void {
  mock.setResults('aif_lesen', { AIF_FG_NR: 'WBANE710X0CZ12345' });
  mock.setResults('hardware_referenz_lesen', { HARDWARE_REFERENZ: '0044570' });
  mock.setResults('daten_referenz_lesen', { DATEN_REFERENZ: '7566178' });
  mock.setResults('flash_programmier_status_lesen', {
    FLASH_PROGRAMMIER_STATUS_TEXT: 'Programmierung erfolgreich',
  });
  mock.setResults('DIAGNOSEPROTOKOLL_LESEN', { DIAG_PROT_IST: 'BMW-FAST' });
}

describe('identifyDme', () => {
  it('resolves an MS45.0 DS2 DME end-to-end', async () => {
    const m = new MockIEdiabas();
    withHappyMs450(m);
    const ident = await identifyDme(m, 'D_Motor');
    expect(ident).toEqual({
      variant: 'MS45.0',
      vin: 'WBAEP31060PE84104',
      hwRef: '0044560',
      swRef: '7551234',
      programmingStatus: 'Programmierung erfolgreich',
      diagProtocol: 'DS2',
    });
    expect(m.calls.map((c) => c.job)).toEqual([
      'aif_lesen',
      'hardware_referenz_lesen',
      'daten_referenz_lesen',
      'flash_programmier_status_lesen',
      'DIAGNOSEPROTOKOLL_LESEN',
    ]);
  });

  it('resolves an MS45.1 BMW-FAST DME end-to-end', async () => {
    const m = new MockIEdiabas();
    withHappyMs451(m);
    const ident = await identifyDme(m, 'D_Motor');
    expect(ident.variant).toBe('MS45.1');
    expect(ident.diagProtocol).toBe('BMW-FAST');
    expect(isBmwFast(ident.diagProtocol)).toBe(true);
  });

  it('returns variant=undefined when HW ref is not recognised', async () => {
    const m = new MockIEdiabas();
    withHappyMs450(m);
    m.setResults('hardware_referenz_lesen', { HARDWARE_REFERENZ: '9999999' });
    const ident = await identifyDme(m, 'D_Motor');
    expect(ident.variant).toBeUndefined();
    expect(ident.hwRef).toBe('9999999');
  });

  it('propagates Ms45JobError when a job returns non-OKAY', async () => {
    const m = new MockIEdiabas();
    m.setResponse('aif_lesen', undefined, () => ({
      sets: [{ JOB_STATUS: { name: 'JOB_STATUS', type: 'text', value: 'ERROR_NO_RESPONSE' } }],
    }));
    await expect(identifyDme(m, 'D_Motor')).rejects.toMatchObject({
      job: 'aif_lesen',
      jobStatus: 'ERROR_NO_RESPONSE',
    });
  });
});
