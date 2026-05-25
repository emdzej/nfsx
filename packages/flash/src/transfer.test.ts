import { describe, expect, it } from 'vitest';
import { MockEdiabasProvider } from '@emdzej/inpax-mock-provider';
import { runTransfer } from './transfer.js';
import type { EcuTarget, FlashEvent } from './types.js';

const ECU: EcuTarget = { sgbd: 'C_TEST', swtIpoPath: '/dev/null' };

function recordEvents(): { sink: FlashEvent[]; emit: (e: FlashEvent) => void } {
  const sink: FlashEvent[] = [];
  return { sink, emit: (e) => sink.push(e) };
}

describe('transfer — runTransfer', () => {
  it('happy path: streams every block and exits cleanly', async () => {
    const ediabas = new MockEdiabasProvider();
    // RequestDownload returns a max block size — the SGBD's reply
    // tells the host how large each TransferData can be.
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_START', {
      JOB_STATUS: 'OKAY',
      MAX_BLOCK_SIZE: 4,
    });
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_BLOCK', { JOB_STATUS: 'OKAY' });
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_ENDE', { JOB_STATUS: 'OKAY' });

    const regions = [
      { startAddress: 0x1000, bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]) },
    ];
    const { sink, emit } = recordEvents();
    const report = await runTransfer(ECU, ediabas, regions, {}, emit);

    expect(report.ok).toBe(true);
    expect(report.bytesTransferred).toBe(6);
    expect(report.totalBytes).toBe(6);
    expect(report.blocksTransferred).toBe(2); // 6 bytes / 4 = 2 blocks (4+2)

    // We get one block:transferred event per block + one log line
    // for block-size negotiation.
    const blockEvents = sink.filter((e) => e.type === 'block:transferred');
    expect(blockEvents).toHaveLength(2);
    if (blockEvents[0]!.type === 'block:transferred') {
      expect(blockEvents[0]!.totalBlocks).toBe(2);
      expect(blockEvents[0]!.bytesSent).toBe(4);
    }
    if (blockEvents[1]!.type === 'block:transferred') {
      expect(blockEvents[1]!.bytesSent).toBe(6);
    }
  });

  it('aborts cleanly when RequestDownload fails', async () => {
    const ediabas = new MockEdiabasProvider();
    // No mock setup → JOB_STATUS empty → RequestDownload fails.
    const regions = [{ startAddress: 0, bytes: new Uint8Array([0xff]) }];
    const { sink, emit } = recordEvents();
    const report = await runTransfer(ECU, ediabas, regions, {}, emit);

    expect(report.ok).toBe(false);
    expect(report.bytesTransferred).toBe(0);
    expect(report.abortReason).toMatch(/FLASH_PROGRAMMIEREN_START/);
  });

  it('aborts mid-stream when a block fails non-transiently', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_START', {
      JOB_STATUS: 'OKAY',
      MAX_BLOCK_SIZE: 2,
    });
    // Block jobs fail outright (not a transient code).
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_BLOCK', { JOB_STATUS: 'ERROR_NO_RESPONSE' });

    const regions = [{ startAddress: 0, bytes: new Uint8Array([1, 2, 3, 4]) }];
    const { emit } = recordEvents();
    const report = await runTransfer(ECU, ediabas, regions, {}, emit);

    expect(report.ok).toBe(false);
    expect(report.blocksTransferred).toBe(0);
    expect(report.abortReason).toMatch(/ERROR_NO_RESPONSE/);
  });

  it('respects custom job-name overrides (per-ECU adaptation)', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_TEST', 'BSP_DOWNLOAD_REQUEST', {
      JOB_STATUS: 'OKAY',
      MAX_BLOCK_SIZE: 8,
    });
    ediabas.setSimpleResult('C_TEST', 'BSP_TRANSFER', { JOB_STATUS: 'OKAY' });
    ediabas.setSimpleResult('C_TEST', 'BSP_FINISH', { JOB_STATUS: 'OKAY' });

    const regions = [{ startAddress: 0, bytes: new Uint8Array([0xaa, 0xbb]) }];
    const { emit } = recordEvents();
    const report = await runTransfer(
      ECU,
      ediabas,
      regions,
      {
        requestDownloadJob: 'BSP_DOWNLOAD_REQUEST',
        transferDataJob: 'BSP_TRANSFER',
        requestTransferExitJob: 'BSP_FINISH',
      },
      emit,
    );

    expect(report.ok).toBe(true);
    // Verify the custom job names actually fired.
    const jobNames = ediabas.jobCalls.map((c) => c.job);
    expect(jobNames).toContain('BSP_DOWNLOAD_REQUEST');
    expect(jobNames).toContain('BSP_TRANSFER');
    expect(jobNames).toContain('BSP_FINISH');
  });

  it('falls back to default block size when SGBD does not publish MAX_BLOCK_SIZE', async () => {
    const ediabas = new MockEdiabasProvider();
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_START', { JOB_STATUS: 'OKAY' });
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_BLOCK', { JOB_STATUS: 'OKAY' });
    ediabas.setSimpleResult('C_TEST', 'FLASH_PROGRAMMIEREN_ENDE', { JOB_STATUS: 'OKAY' });

    // 600 bytes with default block size (256) → 3 blocks (256+256+88)
    const regions = [{ startAddress: 0, bytes: new Uint8Array(600).fill(0xaa) }];
    const { sink, emit } = recordEvents();
    const report = await runTransfer(ECU, ediabas, regions, {}, emit);

    expect(report.ok).toBe(true);
    const blocks = sink.filter((e) => e.type === 'block:transferred');
    expect(blocks).toHaveLength(3);
  });
});
