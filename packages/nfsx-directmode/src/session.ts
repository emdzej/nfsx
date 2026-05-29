/**
 * Direct-DS2 flash session orchestration.
 *
 * High-level flow (mirrors `docs/raw-ds2-flashing.md` §4):
 *
 *   PRECHECK   — IDENT to confirm ECU type + version
 *   AUTH       — SEED/KEY exchange (§3.2)
 *   ERASE      — one §3.3 telegram per region
 *   WRITE      — chunked §3.4 telegrams, 0xFF-skip optimisation
 *   VERIFY     — readback compare, or §3.5 verify command
 *   DISCONNECT — drop the session, close serial
 */
import { Buffer } from 'node:buffer';
import {
  encodeFrame,
  decodeFrame,
  DS2_CMD_IDENT,
  DS2_CMD_MEMORY_READ,
  DS2_CMD_PROG_PREFIX,
  DS2_PROG_WRITE,
  DS2_PROG_ERASE,
  DS2_STATUS_OK,
  DS2_STATUS_PENDING,
} from './ds2.js';
import {
  NodeDirectModeTransport,
  type DirectModeTransport,
  type DirectModeTransportConfig,
} from './transport.js';
import {
  buildSeedRequestPayload,
  buildKeySubmitPayload,
  deriveKey,
} from './seed-key.js';
import {
  identifyEcu,
  pickRegions,
  totalBytesForMode,
  type EcuProfile,
  type FlashMode,
  type FlashRegion,
} from './ecu-tables.js';

export interface DirectModeSessionConfig extends DirectModeTransportConfig {
  /** Force a specific ECU profile instead of relying on IDENT auto-detect. */
  forceVariant?: 'MS42' | 'MS43' | 'GS20';
  /** Inter-byte delay during long writes (rarely needed; default 0). */
  interByteDelayMs?: number;
}

export interface DirectModeProgress {
  stage:
    | 'precheck'
    | 'auth'
    | 'erase'
    | 'write'
    | 'verify'
    | 'read'
    | 'done';
  message: string;
  fraction?: number;
}

export type DirectModeProgressFn = (p: DirectModeProgress) => void;

export class DirectModeError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(`directmode ${stage}: ${message}`);
    this.name = 'DirectModeError';
  }
}

// ── frame round-trip helper ─────────────────────────────────────────

async function sendAndReceive(
  transport: DirectModeTransport,
  addr: number,
  payload: Buffer,
  options: { responseTimeoutMs?: number; pollOnPending?: boolean } = {},
): Promise<Buffer> {
  const wire = encodeFrame(addr, payload);
  transport.flushInput();
  await transport.writeWithEcho(wire);
  // Read header: ADDR + LEN
  const header = await transport.read(2, options.responseTimeoutMs ?? 5_000);
  if (header[0] !== addr) {
    throw new DirectModeError(
      `unexpected ADDR in response: expected 0x${addr.toString(16)}, got 0x${header[0].toString(16)}`,
      'frame',
    );
  }
  const total = header[1];
  if (total < 4) {
    throw new DirectModeError(`response LEN=${total} is impossibly small`, 'frame');
  }
  const remaining = total - 2;
  const rest = await transport.read(remaining, options.responseTimeoutMs ?? 5_000);
  const full = Buffer.concat([header, rest]);
  const { frame } = decodeFrame(full);
  return frame.data;
}

/** Read response payload, retrying on the `0xA1` "pending" status until OK or timeout. */
async function sendAndAwaitOk(
  transport: DirectModeTransport,
  addr: number,
  payload: Buffer,
  options: { totalTimeoutMs?: number; pollDelayMs?: number } = {},
): Promise<Buffer> {
  const totalTimeout = options.totalTimeoutMs ?? 30_000;
  const pollDelay = options.pollDelayMs ?? 10;
  const deadline = Date.now() + totalTimeout;
  while (true) {
    const resp = await sendAndReceive(transport, addr, payload, { responseTimeoutMs: 5_000 });
    if (resp.length === 0) {
      throw new DirectModeError('empty response payload', 'frame');
    }
    const status = resp[0];
    if (status === DS2_STATUS_OK) return resp;
    if (status === DS2_STATUS_PENDING) {
      if (Date.now() > deadline) {
        throw new DirectModeError(
          `operation still pending after ${totalTimeout} ms`,
          'frame',
        );
      }
      await new Promise((r) => setTimeout(r, pollDelay));
      continue;
    }
    throw new DirectModeError(
      `non-OK status 0x${status.toString(16).padStart(2, '0')}`,
      'frame',
    );
  }
}

// ── PRECHECK ────────────────────────────────────────────────────────

export async function runIdent(
  transport: DirectModeTransport,
  addr: number,
): Promise<{ identPayload: Buffer; profile: EcuProfile | null }> {
  const resp = await sendAndAwaitOk(transport, addr, Buffer.from([DS2_CMD_IDENT]));
  const identPayload = resp.subarray(1); // strip status byte
  const profile = identifyEcu(identPayload);
  return { identPayload, profile };
}

// ── AUTH ────────────────────────────────────────────────────────────

const DEFAULT_NONCE = 7;

async function runAuth(
  transport: DirectModeTransport,
  profile: EcuProfile,
  nonce: number = DEFAULT_NONCE,
): Promise<void> {
  const seedReq = buildSeedRequestPayload(nonce);
  // Wrap in 0x07 prefix because SEED_KEY is a programming-mode command
  // per docs §3.2 — `[ADDR] 07 90 42 4D 57 NONCE`.
  const seedRespPayload = await sendAndAwaitOk(
    transport,
    profile.ds2Addr,
    Buffer.concat([Buffer.from([DS2_CMD_PROG_PREFIX]), seedReq]),
  );
  // The seed bytes follow the status byte.
  const seed = seedRespPayload.subarray(1);
  const key = deriveKey(seed, nonce);
  const keySubmit = buildKeySubmitPayload(key);
  const ack = await sendAndAwaitOk(
    transport,
    profile.ds2Addr,
    Buffer.concat([Buffer.from([DS2_CMD_PROG_PREFIX]), keySubmit]),
  );
  if (ack[0] !== DS2_STATUS_OK) {
    throw new DirectModeError(`key rejected (status 0x${ack[0].toString(16)})`, 'auth');
  }
}

// ── ERASE / WRITE ───────────────────────────────────────────────────

function buildEraseRequest(start: number, end: number): Buffer {
  // Per docs §3.3: payload = 07 06 A_HI A_MID A_LO E_HI E_MID E_LO 00
  return Buffer.from([
    DS2_CMD_PROG_PREFIX,
    DS2_PROG_ERASE,
    (start >> 16) & 0xff,
    (start >> 8) & 0xff,
    start & 0xff,
    (end >> 16) & 0xff,
    (end >> 8) & 0xff,
    end & 0xff,
    0,
  ]);
}

function buildWriteRequest(addr24: number, data: Buffer): Buffer {
  // Per docs §3.4: payload = 07 02 A_HI A_MID A_LO SIZE <DATA…>
  if (data.length > 0xff) {
    throw new Error(`write block too large: ${data.length} bytes (max 0xFF)`);
  }
  const head = Buffer.from([
    DS2_CMD_PROG_PREFIX,
    DS2_PROG_WRITE,
    (addr24 >> 16) & 0xff,
    (addr24 >> 8) & 0xff,
    addr24 & 0xff,
    data.length,
  ]);
  return Buffer.concat([head, data]);
}

function buildReadRequest(addr24: number, size: number): Buffer {
  return Buffer.from([
    DS2_CMD_MEMORY_READ,
    (addr24 >> 16) & 0xff,
    (addr24 >> 8) & 0xff,
    addr24 & 0xff,
    size,
  ]);
}

async function eraseRegion(
  transport: DirectModeTransport,
  profile: EcuProfile,
  region: FlashRegion,
): Promise<void> {
  await sendAndAwaitOk(
    transport,
    profile.ds2Addr,
    buildEraseRequest(region.start, region.end),
    { totalTimeoutMs: 60_000 },
  );
}

/**
 * Write `region` data from `image` (BIN buffer). Applies 0xFF-skip
 * optimisation per docs §3.4.1: runs of 0xFF padding in the source are
 * not transmitted (the erased flash already reads 0xFF).
 */
async function writeRegion(
  transport: DirectModeTransport,
  profile: EcuProfile,
  region: FlashRegion,
  image: Buffer,
  onChunk?: (sent: number, total: number) => void,
): Promise<{ bytesWritten: number; bytesSkipped: number }> {
  const length = region.end - region.start + 1;
  let bytesWritten = 0;
  let bytesSkipped = 0;
  let pos = 0;
  while (pos < length) {
    // Skip 0xFF/0xFF pairs.
    while (
      pos + 1 < length &&
      image[region.binOffset + pos] === 0xff &&
      image[region.binOffset + pos + 1] === 0xff
    ) {
      pos += 2;
      bytesSkipped += 2;
    }
    if (pos >= length) break;
    const remaining = length - pos;
    let chunkSize = Math.min(profile.blockSize, remaining);
    // Trim trailing 0xFF/0xFF pairs from the chunk.
    while (
      chunkSize > 2 &&
      image[region.binOffset + pos + chunkSize - 2] === 0xff &&
      image[region.binOffset + pos + chunkSize - 1] === 0xff
    ) {
      chunkSize -= 2;
    }
    const data = image.subarray(region.binOffset + pos, region.binOffset + pos + chunkSize);
    const ecuAddr = region.start + pos;
    await sendAndAwaitOk(
      transport,
      profile.ds2Addr,
      buildWriteRequest(ecuAddr, data),
      { totalTimeoutMs: 30_000 },
    );
    bytesWritten += chunkSize;
    pos += chunkSize;
    onChunk?.(pos, length);
  }
  return { bytesWritten, bytesSkipped };
}

async function readRegion(
  transport: DirectModeTransport,
  profile: EcuProfile,
  region: FlashRegion,
  onChunk?: (read: number, total: number) => void,
): Promise<Buffer> {
  const length = region.end - region.start + 1;
  const out = Buffer.alloc(length);
  let pos = 0;
  while (pos < length) {
    const chunkSize = Math.min(profile.blockSize, length - pos);
    const resp = await sendAndAwaitOk(
      transport,
      profile.ds2Addr,
      buildReadRequest(region.start + pos, chunkSize),
      { totalTimeoutMs: 10_000 },
    );
    // resp = [STATUS, <chunkSize bytes>]
    const data = resp.subarray(1);
    if (data.length !== chunkSize) {
      throw new DirectModeError(
        `read returned ${data.length} bytes, expected ${chunkSize}`,
        'read',
      );
    }
    data.copy(out, pos);
    pos += chunkSize;
    onChunk?.(pos, length);
  }
  return out;
}

// ── public API ──────────────────────────────────────────────────────

interface PreparedSession {
  transport: DirectModeTransport;
  profile: EcuProfile;
}

async function openAndIdent(
  cfg: DirectModeSessionConfig,
  onProgress?: DirectModeProgressFn,
): Promise<PreparedSession> {
  const transport = new NodeDirectModeTransport(cfg);
  await transport.open();

  onProgress?.({ stage: 'precheck', message: 'IDENT' });
  // Try both common addresses if not forced.
  const candidates = cfg.forceVariant
    ? [cfg.forceVariant === 'GS20' ? 0x32 : 0x12]
    : [0x12, 0x32];

  let profile: EcuProfile | null = null;
  let lastErr: Error | null = null;
  let identUsedAddr = 0;
  for (const addr of candidates) {
    try {
      const { profile: p } = await runIdent(transport, addr);
      identUsedAddr = addr;
      if (p) {
        profile = p;
        break;
      }
    } catch (err) {
      lastErr = err as Error;
    }
  }
  if (!profile) {
    await transport.close();
    throw new DirectModeError(
      cfg.forceVariant
        ? `IDENT against forced variant ${cfg.forceVariant} failed: ${lastErr?.message ?? 'no response'}`
        : `IDENT did not match any known ECU profile (last error: ${lastErr?.message ?? 'no response'})`,
      'precheck',
    );
  }
  if (profile.ds2Addr !== identUsedAddr) {
    onProgress?.({
      stage: 'precheck',
      message: `ECU answered on 0x${identUsedAddr.toString(16)} but profile says 0x${profile.ds2Addr.toString(16)}`,
    });
  }
  onProgress?.({
    stage: 'precheck',
    message: `identified as ${profile.variant} (table: ${profile.tableSource})`,
  });
  return { transport, profile };
}

export async function probe(
  cfg: DirectModeSessionConfig,
  onProgress?: DirectModeProgressFn,
): Promise<{ variant: string; identAscii: string }> {
  const { transport, profile } = await openAndIdent(cfg, onProgress);
  try {
    const { identPayload } = await runIdent(transport, profile.ds2Addr);
    return {
      variant: profile.variant,
      identAscii: identPayload.toString('ascii').replace(/[^\x20-\x7e]/g, '.'),
    };
  } finally {
    await transport.close();
  }
}

export interface DirectModeWriteOptions {
  mode: FlashMode;
  /** Skip verify-by-readback (faster but no safety net). */
  skipVerify?: boolean;
  /** SEED/KEY nonce (default 7; must be 1..23). */
  nonce?: number;
}

export interface DirectModeWriteResult {
  variant: string;
  mode: FlashMode;
  bytesWritten: number;
  bytesSkipped: number;
  verified: boolean;
}

export async function writeFlash(
  image: Buffer,
  cfg: DirectModeSessionConfig,
  opts: DirectModeWriteOptions,
  onProgress?: DirectModeProgressFn,
): Promise<DirectModeWriteResult> {
  const { transport, profile } = await openAndIdent(cfg, onProgress);
  try {
    if (image.length !== profile.binSize) {
      throw new DirectModeError(
        `BIN size mismatch: ${image.length} bytes, ${profile.variant} expects ${profile.binSize}`,
        'precheck',
      );
    }

    if (opts.mode === 'calibration' && !profile.calibrationVerified) {
      onProgress?.({
        stage: 'precheck',
        message:
          `WARNING: ${profile.variant} calibration-only mode is NOT separately defined — ` +
          `this will rewrite the same regions as --mode full. Source: ${profile.tableSource}`,
      });
    }

    onProgress?.({ stage: 'auth', message: 'SEED/KEY' });
    await runAuth(transport, profile, opts.nonce);

    const regions = pickRegions(profile, opts.mode);
    const total = totalBytesForMode(profile, opts.mode);

    onProgress?.({ stage: 'erase', message: `erasing ${regions.length} region(s)` });
    for (const r of regions) {
      await eraseRegion(transport, profile, r);
    }

    onProgress?.({ stage: 'write', message: 'programming', fraction: 0 });
    let totalWritten = 0;
    let totalSkipped = 0;
    for (const r of regions) {
      const { bytesWritten, bytesSkipped } = await writeRegion(
        transport,
        profile,
        r,
        image,
        (sent, regionLen) => {
          onProgress?.({
            stage: 'write',
            message: `region 0x${r.start.toString(16)}-0x${r.end.toString(16)}: ${sent}/${regionLen}`,
            fraction: (totalWritten + sent) / total,
          });
        },
      );
      totalWritten += bytesWritten;
      totalSkipped += bytesSkipped;
    }

    let verified = false;
    if (!opts.skipVerify) {
      onProgress?.({ stage: 'verify', message: 'reading back', fraction: 0 });
      verified = true;
      let readSoFar = 0;
      for (const r of regions) {
        const back = await readRegion(transport, profile, r, (read, regionLen) => {
          onProgress?.({
            stage: 'verify',
            message: `region 0x${r.start.toString(16)}: ${read}/${regionLen}`,
            fraction: (readSoFar + read) / total,
          });
        });
        const expected = image.subarray(r.binOffset, r.binOffset + (r.end - r.start + 1));
        for (let i = 0; i < back.length; i++) {
          if (back[i] !== expected[i]) {
            verified = false;
            throw new DirectModeError(
              `verify mismatch at ECU 0x${(r.start + i).toString(16)}: wrote 0x${expected[i]
                .toString(16)
                .padStart(2, '0')}, read 0x${back[i].toString(16).padStart(2, '0')}`,
              'verify',
            );
          }
        }
        readSoFar += back.length;
      }
    }

    onProgress?.({ stage: 'done', message: 'complete' });
    return {
      variant: profile.variant,
      mode: opts.mode,
      bytesWritten: totalWritten,
      bytesSkipped: totalSkipped,
      verified,
    };
  } finally {
    await transport.close();
  }
}

export interface DirectModeReadOptions {
  mode: FlashMode;
}

export async function readFlash(
  cfg: DirectModeSessionConfig,
  opts: DirectModeReadOptions,
  onProgress?: DirectModeProgressFn,
): Promise<{ variant: string; image: Buffer }> {
  const { transport, profile } = await openAndIdent(cfg, onProgress);
  try {
    const regions = pickRegions(profile, opts.mode);
    const total = totalBytesForMode(profile, opts.mode);
    // Allocate the full BIN-sized buffer pre-filled with 0xFF so untouched
    // regions look like erased flash on the resulting image.
    const out = Buffer.alloc(profile.binSize, 0xff);
    let done = 0;
    onProgress?.({ stage: 'read', message: 'reading', fraction: 0 });
    for (const r of regions) {
      const data = await readRegion(transport, profile, r, (read) => {
        onProgress?.({
          stage: 'read',
          message: `region 0x${r.start.toString(16)}: ${read}/${r.end - r.start + 1}`,
          fraction: (done + read) / total,
        });
      });
      data.copy(out, r.binOffset);
      done += data.length;
    }
    onProgress?.({ stage: 'done', message: 'complete' });
    return { variant: profile.variant, image: out };
  } finally {
    await transport.close();
  }
}
