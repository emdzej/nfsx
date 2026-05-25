import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { FlashSession } from './session.js';
import { allowAllConfirmation } from './safety.js';
import type { EcuTarget } from './types.js';

const SWT_KWP_PATH = `${process.env.HOME}/Downloads/inpa/EC-APPS/NFS/SGDAT/00swtkwp.ipo`;
const skipForRealIpo = !existsSync(SWT_KWP_PATH);

const ECU: EcuTarget = {
  sgbd: 'C_TEST',
  diagAddr: 0x6a,
  swtIpoPath: SWT_KWP_PATH,
};

/** Configure a mock with the canonical happy-path SGBD responses. */
function happyMock(): MockEdiabasProvider {
  const m = new MockEdiabasProvider();
  // Precheck — battery + ignition + ECU comms + FSC
  m.setSimpleResult('KOMBI', 'STATUS_LESEN', {
    JOB_STATUS: 'OKAY',
    STAT_UBATT_WERT: 13.5,
    STAT_KL_15_TEXT: 'on',
  });
  m.setSimpleResult('C_TEST', 'IDENT', { JOB_STATUS: 'OKAY' });
  // FSC check via 00swtkwp.ipo: dispatches FREISCHALTCODE_PRUEFEN
  m.setSimpleResult('C_TEST', 'FREISCHALTCODE_PRUEFEN', { JOB_STATUS: 'OKAY' });
  // Auth (passthrough strategy means the key is the seed)
  m.setSimpleResult('C_TEST', 'SEED_LESEN', {
    JOB_STATUS: 'OKAY',
    SEED: new Uint8Array([0x11, 0x22, 0x33, 0x44]),
  });
  m.setSimpleResult('C_TEST', 'KEY_SCHREIBEN', { JOB_STATUS: 'OKAY' });
  // Programming session
  m.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_MODUS', { JOB_STATUS: 'OKAY' });
  // Transfer
  m.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_START', {
    JOB_STATUS: 'OKAY',
    MAX_BLOCK_SIZE: 4,
  });
  m.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_BLOCK', { JOB_STATUS: 'OKAY' });
  m.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_ENDE', { JOB_STATUS: 'OKAY' });
  // AIF write via 00swtkwp.ipo's SG_AIF_SCHREIBEN — dispatches AIF_SCHREIBEN
  m.setSimpleResult('C_TEST', 'AIF_SCHREIBEN', { JOB_STATUS: 'OKAY' });
  // Postcheck reset
  m.setSimpleResult('C_TEST', 'STEUERGERAETE_RESET', { JOB_STATUS: 'OKAY' });
  return m;
}

const SAMPLE_FIRMWARE = {
  regions: [{ startAddress: 0x1000, bytes: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) }],
};

describe('FlashSession — orchestrator', () => {
  it('dry-run skips destructive stages and completes', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({ ecu: ECU, firmware: SAMPLE_FIRMWARE, ediabas });

    const result = await session.run({ dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.stagesRun).toEqual([
      'RESOLVE',
      'PRECHECK',
      'AUTHENTICATE',
      'SESSION',
      'TRANSFER',
      'AIF_WRITE',
      'POSTCHECK',
    ]);
    expect(result.bytesTransferred).toBe(0); // dry-run, nothing transferred
    expect(result.totalBytes).toBe(6);

    // Verify destructive stages were skipped, not executed.
    const skipped = result.events.filter((e) => e.type === 'stage:skipped');
    expect(skipped).toHaveLength(4); // AUTHENTICATE / SESSION / TRANSFER / AIF_WRITE
    // EDIABAS should NOT have received any destructive job calls.
    const destructiveCalls = ediabas.jobCalls.filter((c) =>
      c.job === 'SEED_LESEN' || c.job === 'KEY_SCHREIBEN' || c.job === 'FLASH_PROGRAMMIEREN_BLOCK',
    );
    expect(destructiveCalls).toHaveLength(0);
  });

  it.skipIf(skipForRealIpo)('full run with mock provider completes all 7 stages', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({ ecu: ECU, firmware: SAMPLE_FIRMWARE, ediabas });

    const result = await session.run({ dryRun: false, confirm: allowAllConfirmation });

    if (!result.ok) {
      console.error(
        `aborted at ${result.abortedAt}: ${result.abortReason}\n  stages run: ${result.stagesRun.join(' ')}`,
      );
    }
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.stagesRun).toHaveLength(7);
    expect(result.bytesTransferred).toBe(6);

    // Verify destructive jobs DID fire.
    const jobNames = ediabas.jobCalls.map((c) => c.job);
    expect(jobNames).toContain('SEED_LESEN');
    expect(jobNames).toContain('KEY_SCHREIBEN');
    expect(jobNames).toContain('FLASH_PROGRAMMIEREN_MODUS');
    expect(jobNames).toContain('FLASH_PROGRAMMIEREN_BLOCK');
    expect(jobNames).toContain('STEUERGERAETE_RESET');
  });

  it.skipIf(skipForRealIpo)('aborts at PRECHECK when ignition is off', async () => {
    const ediabas = happyMock();
    // Override KOMBI to report KL_15 off.
    ediabas.setSimpleResult('KOMBI', 'STATUS_LESEN', {
      JOB_STATUS: 'OKAY',
      STAT_UBATT_WERT: 13.5,
      STAT_KL_15_TEXT: 'off',
    });
    const session = new FlashSession({ ecu: ECU, firmware: SAMPLE_FIRMWARE, ediabas });

    const result = await session.run({ dryRun: false, confirm: allowAllConfirmation });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe('PRECHECK');
    expect(result.abortReason).toMatch(/ignition/);
  });

  it.skipIf(skipForRealIpo)('aborts at AUTHENTICATE when SGBD rejects the key', async () => {
    const ediabas = happyMock();
    ediabas.setSimpleResult('C_TEST', 'KEY_SCHREIBEN', { JOB_STATUS: 'ACCESS_DENIED' });
    const session = new FlashSession({ ecu: ECU, firmware: SAMPLE_FIRMWARE, ediabas });

    const result = await session.run({ dryRun: false, confirm: allowAllConfirmation });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe('AUTHENTICATE');
    expect(result.abortReason).toMatch(/ACCESS_DENIED/);
  });

  it.skipIf(skipForRealIpo)('default confirm rejects everything → aborts at first destructive stage', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({ ecu: ECU, firmware: SAMPLE_FIRMWARE, ediabas });

    // No confirm provided → defaults to rejectAllConfirmation.
    const result = await session.run({ dryRun: false });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe('AUTHENTICATE');
    expect(result.abortReason).toMatch(/operator declined/);
  });

  it('parses S37 input firmware and routes through the pipeline', async () => {
    // Build a tiny S37 file with a single S3 record carrying 4 bytes.
    // Reuse the computeChecksum helper indirectly via flash-data.
    const { computeChecksum } = await import('@emdzej/nfsx-flash-data');
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const cs = computeChecksum(9, 0, 4, data);
    const line = `S30900000000${[...data].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}${cs.toString(16).padStart(2, '0').toUpperCase()}`;
    const s37 = `S0030000FC\n${line}\nS70512345678E6\n`;

    const ediabas = happyMock();
    const session = new FlashSession({
      ecu: ECU,
      firmware: { s37Bytes: new TextEncoder().encode(s37) },
      ediabas,
    });

    const result = await session.run({ dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.totalBytes).toBe(4);
  });

  it('emits events in the expected order', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({ ecu: ECU, firmware: SAMPLE_FIRMWARE, ediabas });
    const seen: string[] = [];
    session.on('event', (e) => {
      if (e.type === 'stage:start') seen.push(`start:${e.stage}`);
      if (e.type === 'stage:done') seen.push(`done:${e.stage}`);
      if (e.type === 'stage:skipped') seen.push(`skip:${e.stage}`);
    });

    await session.run({ dryRun: true });

    // RESOLVE + PRECHECK ran for real; 4 destructive skipped;
    // POSTCHECK ran.
    expect(seen).toEqual([
      'start:RESOLVE',
      'done:RESOLVE',
      'start:PRECHECK',
      'done:PRECHECK',
      'skip:AUTHENTICATE',
      'skip:SESSION',
      'skip:TRANSFER',
      'skip:AIF_WRITE',
      'start:POSTCHECK',
      'done:POSTCHECK',
    ]);
  });
});
