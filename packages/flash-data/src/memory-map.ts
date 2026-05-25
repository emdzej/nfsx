/**
 * Coalesce S-record data lines into contiguous memory regions.
 *
 * The wire format scatters data across many short records (typically
 * 16 / 32 / 256 bytes each). For flashing we want larger contiguous
 * chunks — the UDS RequestDownload + TransferData sequence asks the
 * ECU which block size it can accept, then streams blocks of that
 * size. Coalescing first lets us slice into ECU-friendly sizes
 * cleanly.
 *
 * The coalescer:
 *   1. Filters to data records (S1/S2/S3).
 *   2. Sorts by address.
 *   3. Merges adjacent records (record[i].address + len == record[i+1].address).
 *   4. Detects overlaps — these are usually corruption or bad
 *      authoring; we surface them rather than silently last-write-wins.
 */

import type { S37Record } from './s37.js';
import { dataRecords } from './s37.js';

export interface MemoryRegion {
  /** Start address (inclusive). */
  startAddress: number;
  /** Contiguous bytes for this region. */
  bytes: Uint8Array;
}

export interface BuildMemoryMapResult {
  regions: MemoryRegion[];
  /**
   * Address ranges that two records BOTH claimed. Empty in a clean
   * file; non-empty usually indicates corruption or a bad merge of
   * source files.
   */
  overlaps: Array<{ first: S37Record; second: S37Record; range: [number, number] }>;
  /** Aggregate metrics, useful for progress + UI display. */
  totalBytes: number;
  recordCount: number;
}

/**
 * Build a coalesced memory map. Adjacent runs of data records are
 * merged into single contiguous regions. Gaps between regions are
 * preserved (the resulting array can have multiple entries if the
 * firmware is split across non-contiguous address ranges).
 */
export function buildMemoryMap(records: readonly S37Record[]): BuildMemoryMapResult {
  const data = dataRecords(records);
  // Sort by start address (stable so equal-address records keep
  // their original order — relevant for overlap detection).
  const sorted = [...data].sort((a, b) => a.address - b.address);

  const regions: MemoryRegion[] = [];
  const overlaps: BuildMemoryMapResult['overlaps'] = [];
  let totalBytes = 0;

  for (const rec of sorted) {
    totalBytes += rec.data.length;
    if (regions.length === 0) {
      regions.push({ startAddress: rec.address, bytes: copy(rec.data) });
      continue;
    }
    const last = regions[regions.length - 1]!;
    const lastEnd = last.startAddress + last.bytes.length;
    if (rec.address === lastEnd) {
      // Exactly adjacent — extend the current region.
      last.bytes = concat(last.bytes, rec.data);
    } else if (rec.address < lastEnd) {
      // Overlap. Record it; for the data we keep first-write-wins
      // (don't clobber bytes we already have, only fill in extension).
      overlaps.push({
        first: findRecordAt(sorted, last.startAddress)!,
        second: rec,
        range: [rec.address, Math.min(lastEnd, rec.address + rec.data.length)],
      });
      const tail = rec.address + rec.data.length - lastEnd;
      if (tail > 0) {
        const extension = rec.data.subarray(rec.data.length - tail);
        last.bytes = concat(last.bytes, extension);
      }
    } else {
      // Gap — start a new region.
      regions.push({ startAddress: rec.address, bytes: copy(rec.data) });
    }
  }

  return { regions, overlaps, totalBytes, recordCount: data.length };
}

function copy(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function findRecordAt(recs: readonly S37Record[], addr: number): S37Record | undefined {
  return recs.find((r) => r.address === addr);
}

/**
 * Slice a memory region into chunks of at most `blockSize` bytes.
 * The last chunk may be smaller. Each chunk carries its own
 * start address — useful for the UDS TransferData sequence where
 * each block needs explicit addressing.
 */
export function chunkRegion(region: MemoryRegion, blockSize: number): MemoryRegion[] {
  if (blockSize <= 0) throw new Error('blockSize must be > 0');
  if (region.bytes.length <= blockSize) return [region];
  const chunks: MemoryRegion[] = [];
  let offset = 0;
  while (offset < region.bytes.length) {
    const slice = region.bytes.subarray(offset, Math.min(offset + blockSize, region.bytes.length));
    chunks.push({ startAddress: region.startAddress + offset, bytes: copy(slice) });
    offset += blockSize;
  }
  return chunks;
}
