/**
 * TRANSFER stage — block-streaming firmware over UDS 0x34 / 0x36 / 0x37.
 *
 * BMW wraps the bare UDS in SGBD apiJobs:
 *
 *   FLASH_PROGRAMMIEREN_START  → UDS 0x34 RequestDownload
 *     in:  start_address (hex), length (hex), block_size_hint
 *     out: max_block_size (the ECU's reply)
 *
 *   FLASH_PROGRAMMIEREN_BLOCK  → UDS 0x36 TransferData
 *     in:  block_bytes (hex)
 *     out: status (per-block ack)
 *
 *   FLASH_PROGRAMMIEREN_ENDE   → UDS 0x37 RequestTransferExit
 *     in:  (none)
 *     out: status
 *
 * Some ECUs add CRC verification via UDS 0x31 RoutineControl after
 * the transfer — wrapped as `FLASH_PROGRAMMIEREN_PRUEFEN` or similar.
 * Out of scope for the base transfer; orchestrator's POSTCHECK stage
 * handles it.
 *
 * Retry semantics: a single retry per block on NRC 0x21
 * BusyRepeatRequest or 0x23 ConditionsNotCorrect. Other errors are
 * fatal — abort the transfer (which leaves the ECU in programming
 * mode; recovery requires restarting the flash from scratch).
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import { chunkRegion, type MemoryRegion } from '@emdzej/nfsx-flash-data';
import type { EcuTarget, FlashEvent, TransferOptions } from './types.js';

const DEFAULTS = {
  requestDownloadJob: 'FLASH_PROGRAMMIEREN_START',
  transferDataJob: 'FLASH_PROGRAMMIEREN_BLOCK',
  requestTransferExitJob: 'FLASH_PROGRAMMIEREN_ENDE',
  blockSize: 256,
  maxRetries: 1,
};

export interface TransferReport {
  ok: boolean;
  bytesTransferred: number;
  totalBytes: number;
  blocksTransferred: number;
  abortReason?: string;
}

export async function runTransfer(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  regions: ReadonlyArray<MemoryRegion>,
  options: TransferOptions,
  emit: (e: FlashEvent) => void,
): Promise<TransferReport> {
  const cfg = { ...DEFAULTS, ...options };
  const totalBytes = regions.reduce((n, r) => n + r.bytes.length, 0);

  // 1. RequestDownload — announce the total transfer to the ECU
  //    and find out the max block size it accepts.
  const blockSize = await negotiateBlockSize(ecu, ediabas, regions, cfg, emit);
  if (blockSize.error) {
    return { ok: false, bytesTransferred: 0, totalBytes, blocksTransferred: 0, abortReason: blockSize.error };
  }

  // 2. Slice regions into ECU-sized blocks.
  const blocks: Array<{ address: number; bytes: Uint8Array }> = [];
  for (const region of regions) {
    for (const chunk of chunkRegion(region, blockSize.size)) {
      blocks.push({ address: chunk.startAddress, bytes: chunk.bytes });
    }
  }
  const totalBlocks = blocks.length;

  // 3. TransferData per block.
  let bytesSent = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const result = await transferBlock(ecu, ediabas, block, cfg);
    if (!result.ok) {
      return {
        ok: false,
        bytesTransferred: bytesSent,
        totalBytes,
        blocksTransferred: i,
        abortReason: `block ${i} (addr 0x${block.address.toString(16)}): ${result.reason}`,
      };
    }
    bytesSent += block.bytes.length;
    emit({
      type: 'block:transferred',
      blockIndex: i,
      totalBlocks,
      bytesSent,
      bytesTotal: totalBytes,
      address: block.address,
    });
  }

  // 4. RequestTransferExit — tell the ECU we're done.
  const exitResult = await requestTransferExit(ecu, ediabas, cfg);
  if (!exitResult.ok) {
    return {
      ok: false,
      bytesTransferred: bytesSent,
      totalBytes,
      blocksTransferred: totalBlocks,
      abortReason: `RequestTransferExit: ${exitResult.reason}`,
    };
  }

  return { ok: true, bytesTransferred: bytesSent, totalBytes, blocksTransferred: totalBlocks };
}

async function negotiateBlockSize(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  regions: ReadonlyArray<MemoryRegion>,
  cfg: typeof DEFAULTS,
  emit: (e: FlashEvent) => void,
): Promise<{ size: number; error?: undefined } | { size: 0; error: string }> {
  if (regions.length === 0) return { size: 0, error: 'no regions to transfer' };
  // Use the first region's start address + total length as the
  // RequestDownload range. ECUs with non-contiguous memory regions
  // need separate RequestDownload calls per region; that's a v2
  // refinement.
  const startAddr = regions[0]!.startAddress;
  const totalLen = regions.reduce((n, r) => n + r.bytes.length, 0);
  const para = `${startAddr.toString(16).toUpperCase()};${totalLen.toString(16).toUpperCase()};${cfg.blockSize.toString(16).toUpperCase()}`;
  try {
    await ediabas.job(ecu.sgbd, cfg.requestDownloadJob, para, '');
    const status = readJobStatus(ediabas);
    if (status !== 'OKAY') {
      return { size: 0, error: `${cfg.requestDownloadJob} JOB_STATUS="${status}"` };
    }
    // ECU's max block size — but if the SGBD didn't publish it
    // (or the operator overrode), fall back to the configured size.
    let max = cfg.blockSize;
    if (ediabas.hasResult('MAX_BLOCK_SIZE', 1)) {
      max = ediabas.resultInt('MAX_BLOCK_SIZE', 1);
    } else if (ediabas.hasResult('MAX_BLOCKLAENGE', 1)) {
      max = ediabas.resultInt('MAX_BLOCKLAENGE', 1);
    }
    emit({ type: 'log', level: 'info', message: `negotiated block size: ${max} bytes` });
    return { size: max };
  } catch (err) {
    return { size: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function transferBlock(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  block: { address: number; bytes: Uint8Array },
  cfg: typeof DEFAULTS,
): Promise<{ ok: boolean; reason?: string }> {
  const hexData = bytesToHex(block.bytes);
  const para = `${block.address.toString(16).toUpperCase()};${hexData}`;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      await ediabas.job(ecu.sgbd, cfg.transferDataJob, para, '');
      const status = readJobStatus(ediabas);
      if (status === 'OKAY') return { ok: true };
      // Transient errors retry; everything else fails fast.
      if (status.includes('BUSY') || status.includes('CONDITIONS_NOT_CORRECT')) {
        if (attempt < cfg.maxRetries) continue;
      }
      return { ok: false, reason: `JOB_STATUS="${status}"` };
    } catch (err) {
      // Communication errors (cable disconnect etc) are fatal mid-flash;
      // no retry — the ECU is in an indeterminate state.
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, reason: 'retries exhausted' };
}

async function requestTransferExit(
  ecu: EcuTarget,
  ediabas: IEdiabasProvider,
  cfg: typeof DEFAULTS,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await ediabas.job(ecu.sgbd, cfg.requestTransferExitJob, '', '');
    const status = readJobStatus(ediabas);
    if (status !== 'OKAY') {
      return { ok: false, reason: `JOB_STATUS="${status}"` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function readJobStatus(ediabas: IEdiabasProvider): string {
  if (!ediabas.hasResult('JOB_STATUS', 1)) return '';
  return ediabas.resultText('JOB_STATUS', 1, '');
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0').toUpperCase();
  }
  return s;
}
