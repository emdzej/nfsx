/**
 * `FirmwareSource` implementations for `nfsx-runtime`'s slot 0x55
 * iterator. See nfsx-runtime/system-functions.ts for the contract.
 *
 * The IPO's flash loop pops one chunk per call. Chunks must fit the
 * SGBD's `BLOCKLAENGE_MAX` cap; the iterator does its own splitting.
 */

import type { FirmwareSource } from '@emdzej/nfsx-runtime';
import type { MemoryRegion } from '@emdzej/nfsx-flash-data';

/**
 * Diagnostic counters — what the firmware source actually delivered.
 * The orchestrator surfaces this so the operator can tell whether the
 * IPO drained the iterator (real flash) or asked once and exited (no
 * bytes wrote / silent failure).
 */
export interface FirmwareSourceStats {
  /** Number of `nextChunk` calls (including the EOF call). */
  calls: number;
  /** Total bytes returned across all calls (excludes EOF zero-byte). */
  bytesDelivered: number;
  /** Whether the iterator reached EOF before being abandoned. */
  drained: boolean;
}

export interface InstrumentedFirmwareSource extends FirmwareSource {
  readonly stats: FirmwareSourceStats;
}

export function buildInstrumentedFirmwareSource(
  inner: FirmwareSource,
): InstrumentedFirmwareSource {
  const stats: FirmwareSourceStats = { calls: 0, bytesDelivered: 0, drained: false };
  return {
    stats,
    nextChunk(maxBytes: number) {
      stats.calls++;
      const chunk = inner.nextChunk(maxBytes);
      stats.bytesDelivered += chunk.bytes.length;
      if (chunk.eof) stats.drained = true;
      return chunk;
    },
  };
}

/**
 * Build a `FirmwareSource` from parsed-firmware memory regions.
 *
 * Behaviour:
 * - Regions are walked in given order. Each region splits into chunks
 *   of at most `chunkSize` bytes (or the slot's per-call `maxBytes`,
 *   whichever is smaller). Region boundaries break a chunk — the IPO
 *   sees one record per `nextChunk` call.
 * - `chunkSize` defaults to the slot's `maxBytes` (no extra cap).
 * - When all regions are drained, returns `{ bytes: Uint8Array(0),
 *   eof: true }` on every subsequent call.
 *
 * Region addressing is NOT preserved across chunks — that's the SGBD's
 * job via per-record framing (the IPO supplies start-addr / length
 * via `CDHBinBufWriteWord` calls before the `FLASH_SCHREIBEN`).
 */
export function buildRegionsFirmwareSource(
  regions: ReadonlyArray<MemoryRegion>,
  chunkSize?: number,
): FirmwareSource {
  // Flatten into a (regionIndex, byteOffsetInRegion) cursor. Avoids
  // copying — slices are O(view-creation).
  let regionIdx = 0;
  let offsetInRegion = 0;

  return {
    nextChunk(maxBytes: number): { bytes: Uint8Array; eof: boolean } {
      while (regionIdx < regions.length) {
        const region = regions[regionIdx]!;
        if (offsetInRegion >= region.bytes.length) {
          regionIdx++;
          offsetInRegion = 0;
          continue;
        }
        const cap = chunkSize ? Math.min(chunkSize, maxBytes) : maxBytes;
        if (cap <= 0) {
          // Pathological — caller's MaxData is 0 or negative.
          // Treat as "nothing this call" without advancing.
          return { bytes: new Uint8Array(0), eof: false };
        }
        const remaining = region.bytes.length - offsetInRegion;
        const len = Math.min(cap, remaining);
        const slice = region.bytes.subarray(offsetInRegion, offsetInRegion + len);
        offsetInRegion += len;
        // Copy so the caller can stash + reuse the array independently
        // of the underlying region buffer.
        return { bytes: new Uint8Array(slice), eof: false };
      }
      return { bytes: new Uint8Array(0), eof: true };
    },
  };
}
