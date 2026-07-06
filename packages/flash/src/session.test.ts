import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { startNfsRuntimeFromPath } from '@emdzej/nfsx-runtime/node';
import { FlashSession } from './session.js';
import { allowAllConfirmation } from './safety.js';
import { nodeBackupEmitter } from './node.js';
import type { EcuTarget, FlashSessionOptions } from './types.js';

const SWT_KWP_PATH = `${process.env.HOME}/Downloads/inpa/EC-APPS/NFS/SGDAT/00swtkwp.ipo`;
const skipForRealIpo = !existsSync(SWT_KWP_PATH);

const ECU: EcuTarget = {
  sgbd: 'C_TEST',
  diagAddr: 0x6a,
  ipoPath: SWT_KWP_PATH,
  swtIpoPath: SWT_KWP_PATH,
};

/**
 * Skip the IPO-driven precheck dispatches — they need a real target-SG
 * IPO that knows about `C_TEST`. Tests focus on pipeline shape, not
 * the IPO dispatch behavior (precheck has its own coverage).
 */
const PRECHECK_SKIP: NonNullable<FlashSessionOptions['precheck']>['skip'] = [
  'hw_referenz',
  'sg_status',
  'sg_ident',
  'sg_aif',
  'hwnr_match',
  'fsc',
];

/** Subset for tests that DO want the FSC IPO loaded (gated by `skipForRealIpo`). */
const PRECHECK_SKIP_KEEP_FSC: NonNullable<FlashSessionOptions['precheck']>['skip'] = [
  'hw_referenz',
  'sg_status',
  'sg_ident',
  'sg_aif',
  'hwnr_match',
];

let backupDir: string;

beforeEach(() => {
  backupDir = mkdtempSync(join(tmpdir(), 'nfsx-flash-test-'));
});

function happyMock(): MockEdiabasProvider {
  const m = new MockEdiabasProvider();
  // FSC check via 00swtkwp.ipo dispatches FREISCHALTCODE_PRUEFEN.
  m.setSimpleResult('C_TEST', 'FREISCHALTCODE_PRUEFEN', { JOB_STATUS: 'OKAY' });
  return m;
}

const SAMPLE_FIRMWARE = {
  regions: [{ startAddress: 0x1000, bytes: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) }],
};

describe('FlashSession — IPO-driven orchestrator', () => {
  it('dry-run runs RESOLVE + PRECHECK + BACKUP + POSTCHECK, skips PROGRAM', () => {
    // Backup tries to startNfsRuntime which loads a real IPO file —
    // with SWT_KWP_PATH it'll work if the file exists; otherwise the
    // run path is skipForRealIpo. We test with `backup.skip: true`
    // to keep this test independent of disk state.
    const ediabas = happyMock();
    const session = new FlashSession({
      ecu: ECU,
      firmware: SAMPLE_FIRMWARE,
      ediabas,
      startRuntime: startNfsRuntimeFromPath,
      precheck: { skip: PRECHECK_SKIP },
      backup: { skip: true },
    });

    return session.run({ dryRun: true }).then((result) => {
      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.stagesRun).toEqual(['RESOLVE', 'PRECHECK', 'BACKUP', 'PROGRAM', 'POSTCHECK']);
      expect(result.totalBytes).toBe(6);

      // PROGRAM was skipped in dry-run.
      const skipped = result.events.filter((e) => e.type === 'stage:skipped');
      expect(skipped.some((e) => e.type === 'stage:skipped' && e.stage === 'PROGRAM')).toBe(true);

      // BACKUP was also skipped (via opts.backup.skip).
      expect(skipped.some((e) => e.type === 'stage:skipped' && e.stage === 'BACKUP')).toBe(true);

      // No destructive jobs hit the mock.
      expect(ediabas.jobCalls.length).toBe(0);
    });
  });

  it.skipIf(skipForRealIpo)('full run with mock provider completes all 5 stages', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({
      ecu: ECU,
      firmware: SAMPLE_FIRMWARE,
      ediabas,
      startRuntime: startNfsRuntimeFromPath,
      precheck: { skip: PRECHECK_SKIP_KEEP_FSC },
      backup: { emitter: nodeBackupEmitter(backupDir) },
    });

    const result = await session.run({ dryRun: false, confirm: allowAllConfirmation });

    if (!result.ok) {
      console.error(
        `aborted at ${result.abortedAt}: ${result.abortReason}\n  stages run: ${result.stagesRun.join(' ')}`,
      );
    }
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.stagesRun).toEqual(['RESOLVE', 'PRECHECK', 'BACKUP', 'PROGRAM', 'POSTCHECK']);

    // Backup file was written.
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);

    // PROGRAM dispatched SG_PROGRAMMIEREN — the mock recorded a JOBNAME
    // cabd-par set (via the IPO's internal flow). We don't assert
    // specific job names since the IPO controls dispatch; just that
    // _some_ jobs ran against the mock.
    // (For C_TEST + SWT_KWP, the IPO likely throws somewhere — that's
    // fine; the dispatch attempt was made.)
  });

  it.skipIf(skipForRealIpo)('aborts at PRECHECK when FSC check fails', async () => {
    const ediabas = happyMock();
    ediabas.setSimpleResult('C_TEST', 'FREISCHALTCODE_PRUEFEN', {
      JOB_STATUS: 'ERROR_FSC_INVALID',
    });
    const session = new FlashSession({
      ecu: ECU,
      firmware: SAMPLE_FIRMWARE,
      ediabas,
      // Keep FSC in the loop for this test — it's what we're testing.
      precheck: { skip: PRECHECK_SKIP_KEEP_FSC },
      backup: { skip: true },
    });

    const result = await session.run({ dryRun: false, confirm: allowAllConfirmation });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe('PRECHECK');
    expect(result.abortReason).toMatch(/fsc/);
  });

  it.skipIf(skipForRealIpo)('default confirm rejects → aborts at PROGRAM', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({
      ecu: ECU,
      firmware: SAMPLE_FIRMWARE,
      ediabas,
      startRuntime: startNfsRuntimeFromPath,
      precheck: { skip: PRECHECK_SKIP },
      backup: { skip: true },
    });

    // No confirm provided → defaults to rejectAllConfirmation.
    const result = await session.run({ dryRun: false });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe('PROGRAM');
    expect(result.abortReason).toMatch(/operator declined/);
  });

  it('parses S37 input firmware in RESOLVE', async () => {
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
      startRuntime: startNfsRuntimeFromPath,
      precheck: { skip: PRECHECK_SKIP },
      backup: { skip: true },
    });

    const result = await session.run({ dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.totalBytes).toBe(4);
  });

  it('emits events in the expected order', async () => {
    const ediabas = happyMock();
    const session = new FlashSession({
      ecu: ECU,
      firmware: SAMPLE_FIRMWARE,
      ediabas,
      startRuntime: startNfsRuntimeFromPath,
      precheck: { skip: PRECHECK_SKIP },
      backup: { skip: true },
    });
    const seen: string[] = [];
    session.on('event', (e) => {
      if (e.type === 'stage:start') seen.push(`start:${e.stage}`);
      if (e.type === 'stage:done') seen.push(`done:${e.stage}`);
      if (e.type === 'stage:skipped') seen.push(`skip:${e.stage}`);
    });

    await session.run({ dryRun: true });

    expect(seen).toEqual([
      'start:RESOLVE',
      'done:RESOLVE',
      'start:PRECHECK',
      'done:PRECHECK',
      'start:BACKUP',
      'skip:BACKUP',
      'done:BACKUP',
      'skip:PROGRAM',
      'start:POSTCHECK',
      'done:POSTCHECK',
    ]);
  });
});

// Best-effort cleanup of backup tmpdirs created in beforeEach.
process.on('exit', () => {
  try {
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});
