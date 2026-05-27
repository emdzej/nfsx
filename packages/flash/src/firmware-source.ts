/**
 * `FirmwareSource` implementations for `nfsx-runtime`'s slot 0x55
 * iterator. See nfsx-runtime/system-functions.ts for the contract.
 *
 * The IPO's flash loop pops one chunk per call. Chunks must fit the
 * SGBD's `BLOCKLAENGE_MAX` cap; the iterator does its own splitting.
 */

import type { FirmwareSource } from '@emdzej/nfsx-runtime';
import type { MemoryRegion, PaDaRecord } from '@emdzej/nfsx-flash-data';

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

export interface InstrumentOptions {
  /**
   * Optional callback invoked after every `nextChunk` that returned
   * data. Use it to surface periodic progress to the operator (the
   * IPO is silent during a multi-minute flash loop, so this is the
   * cleanest hook we have — entirely host-side, no VM changes).
   */
  onProgress?: (stats: FirmwareSourceStats) => void;
}

export function buildInstrumentedFirmwareSource(
  inner: FirmwareSource,
  options: InstrumentOptions = {},
): InstrumentedFirmwareSource {
  const stats: FirmwareSourceStats = { calls: 0, bytesDelivered: 0, drained: false };
  return {
    stats,
    nextChunk(maxBytes: number) {
      stats.calls++;
      const chunk = inner.nextChunk(maxBytes);
      stats.bytesDelivered += chunk.bytes.length;
      if (chunk.eof) stats.drained = true;
      if (options.onProgress && chunk.bytes.length > 0) options.onProgress(stats);
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

/**
 * Frame the IPO's BinBuf payload exactly the way WinKFP does.
 *
 * Verified against `winkfpt.exe`'s slot 0x55 dispatcher
 * (`FUN_00459f80` → `MakeHeader` `FUN_00459b00` →
 * `coapiKfGetProgData` `FUN_00442630` → `datGetNextData`
 * `FUN_004662a0`). See `docs/architecture.md` §11.13.
 *
 * Each call returns the binary frame for **one** Intel-HEX type-00
 * (data) record from the `.0PA`. Type-04 / type-02 records adjust the
 * running absolute address (the parser already collapses that into
 * `record.address`, so we just read it). Type-10 records (BMW
 * `$REFERENZ` host metadata) and type-01 (EOF marker) are skipped.
 *
 * Frame layout (L = record data length):
 * ```
 *   +0x00  1   EBX mode byte (host-side flag; default 0x00)
 *   +0x01  1   word-size = 0x01    ┐ from CDHSetDataOrg(1, 0, 0)
 *   +0x02  1   flag = 0x00         │  which slot 0x55 calls
 *   +0x03  1   flag = 0x00         ┘  internally before MakeHeader
 *   +0x04  9   zero padding
 *   +0x0D  2   length L (uint16 LE)
 *   +0x0F  2   length L (uint16 LE, duplicate)
 *   +0x11  4   absolute address (uint32 LE)
 *   +0x15  L   record data
 *   +0x15+L 1  terminator = 0x03
 * ```
 *
 * Total bytes = L + 22.
 *
 * The optional `mode` parameter overrides byte 0 of the header. If
 * the bench rejects EBX=0 frames with a clean error code, retry with
 * EBX=1 — that's the only value MakeHeader inspects (it triggers a
 * `memset(byte 9, 0xff, 1)` which then makes byte 9 = 0xff instead
 * of 0).
 */
export function buildPaDaRecordSource(
  records: ReadonlyArray<PaDaRecord>,
  options: { mode?: number } = {},
): FirmwareSource {
  const mode = (options.mode ?? 0x00) & 0xff;
  // Pre-build the immutable 13-byte header that prefixes every frame.
  const header13 = new Uint8Array(13);
  header13[0] = mode;
  header13[1] = 0x01;
  // [2..0x0C] stay zero.

  // Skip non-flashable records up front so `nextChunk` doesn't have
  // to filter on every call. Order preserved.
  const dataRecords = records.filter((r) => r.type === 0x00 && r.data.length > 0);

  let i = 0;
  return {
    nextChunk(maxBytes: number) {
      if (i >= dataRecords.length) return { bytes: new Uint8Array(0), eof: true };
      const rec = dataRecords[i]!;
      const L = rec.data.length;
      const total = L + 22;
      if (total > maxBytes) {
        // The SGBD's BLOCKLAENGE_MAX_WERT should always exceed
        // L+22 for a typical 32-byte record (54 total < 246). If
        // the IPO ever passes a smaller maxBytes, surface that
        // rather than silently truncating.
        throw new Error(
          `firmware record at index ${i} needs ${total} bytes but IPO offered only ${maxBytes}`,
        );
      }
      i++;
      const buf = new Uint8Array(total);
      // [0..0x0C] header
      buf.set(header13, 0);
      // [0x0D..0x0E] length LE
      buf[0x0d] = L & 0xff;
      buf[0x0e] = (L >> 8) & 0xff;
      // [0x0F..0x10] length LE (duplicate — record-count field in
      // CDHGetApiJobData's batched cousin; here it mirrors length)
      buf[0x0f] = L & 0xff;
      buf[0x10] = (L >> 8) & 0xff;
      // [0x11..0x14] absolute address LE
      const addr = rec.address >>> 0;
      buf[0x11] = addr & 0xff;
      buf[0x12] = (addr >> 8) & 0xff;
      buf[0x13] = (addr >> 16) & 0xff;
      buf[0x14] = (addr >> 24) & 0xff;
      // [0x15..0x14+L] data
      buf.set(rec.data, 0x15);
      // [0x15+L] terminator
      buf[0x15 + L] = 0x03;
      return { bytes: buf, eof: false };
    },
  };
}
