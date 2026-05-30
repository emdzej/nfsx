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
 *   DISCONNECT — caller closes the DirectModeTransport
 *
 * The interface (an `DirectModeTransport` from `@emdzej/ediabasx-interfaces`)
 * is supplied by the caller already opened and configured with DS2 comm
 * parameters via `setCommParameter([0x0006, baud, ...])`. The interface
 * handles the K-line wire layer (parity, fast-init, DTR direction
 * control, adapter echo, FTDI latency, XOR checksumming).
 */
import { Buffer } from 'node:buffer';
import type { DirectModeTransport } from "./transport.js";
import {
  decodeFrame,
  DS2_CMD_IDENT,
  DS2_CMD_HW_REF,
  DS2_CMD_MEMORY_READ,
  DS2_CMD_PROG_PREFIX,
  DS2_PROG_WRITE,
  DS2_PROG_ERASE,
  DS2_STATUS_OK,
  DS2_STATUS_PENDING,
} from './ds2.js';
import { decodeIdent, type IdentFields } from './identity.js';
import { buildRequestPayload } from './transport.js';
import {
  buildSeedRequestPayload,
  buildKeySubmitPayload,
  deriveKey,
} from './seed-key.js';
import {
  findByIdentKey,
  getProfile,
  pickRegions,
  totalBytesForMode,
  type EcuProfile,
  type FlashMode,
  type FlashRegion,
} from './ecu-tables.js';

export interface DirectModeSessionConfig {
  /**
   * The pre-opened, DS2-configured DirectModeTransport. The caller is
   * responsible for `open()` and `setCommParameter([0x0006, ...])`
   * before any session function is called, and for `close()` after.
   */
  iface: DirectModeTransport;
  /** Force a specific ECU profile instead of relying on IDENT auto-detect. */
  forceVariant?: 'MS42' | 'MS43' | 'GS20';
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
  iface: DirectModeTransport,
  addr: number,
  payload: Buffer,
): Promise<Buffer> {
  const request = buildRequestPayload(addr, payload);
  // Retry transient frame errors (timeout, echo mismatch, short tail).
  // These appear roughly every ~1000 frames on a 9600-baud K-line and
  // are not real failures — just bus noise / momentary inter-byte gaps.
  // Mirrors what ediabasx's SerialInterface.transmitDs2WithRetry does
  // for the high-level path.
  const MAX_ATTEMPTS = 8;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Let the bus quiet down between attempts. Echo-mismatch errors
      // tend to recur for a few frames after a glitch, then clear.
      await new Promise((r) => setTimeout(r, 30 * attempt));
    }
    try {
      const full = await iface.transact(request);
      if (full.length < 4) {
        throw new Error(`response too short: ${full.length} bytes`);
      }
      if (full[0] !== addr) {
        throw new Error(
          `unexpected ADDR in response: expected 0x${addr.toString(16)}, got 0x${full[0].toString(16)}`,
        );
      }
      const { frame } = decodeFrame(full);
      return frame.data;
    } catch (err) {
      lastErr = err as Error;
      // Don't retry on a clearly-fatal error pattern
      if (/non-OK status/.test(lastErr.message)) break;
    }
  }
  throw new DirectModeError(lastErr?.message ?? 'frame error', 'frame');
}

/** Read response payload, retrying on `0xA1` "pending" status until OK or timeout. */
async function sendAndAwaitOk(
  iface: DirectModeTransport,
  addr: number,
  payload: Buffer,
  options: { totalTimeoutMs?: number; pollDelayMs?: number } = {},
): Promise<Buffer> {
  const totalTimeout = options.totalTimeoutMs ?? 30_000;
  const pollDelay = options.pollDelayMs ?? 10;
  const deadline = Date.now() + totalTimeout;
  while (true) {
    const resp = await sendAndReceive(iface, addr, payload);
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
  iface: DirectModeTransport,
  addr: number,
): Promise<{ identPayload: Buffer }> {
  const resp = await sendAndAwaitOk(iface, addr, Buffer.from([DS2_CMD_IDENT]));
  const identPayload = resp.subarray(1); // strip status byte
  return { identPayload };
}

/**
 * MS4x-Flasher-style ECU identification: send cmd 0x0D (hardware-
 * reference query), extract the 3-byte memory address from bytes 57-59
 * of the response frame, then read 8 ASCII bytes from that address via
 * cmd 0x06. First 6 chars of those bytes are the protocol-class
 * dispatch key. Lookup in the per-profile `identKey` table to resolve
 * the variant.
 *
 * Verified against decompiled `B::A(F)` in MS4x Flasher 1.6.0 — same
 * sequence used by the engine factory (`O::A`, addr 0x12) and TCU
 * factory (`N::A`, addr 0x32) to pick between MS42/MS43/GS20 etc.
 */
export async function runDispatchIdent(
  iface: DirectModeTransport,
  addr: number,
): Promise<{ identKey: string; idAscii: string; profile: EcuProfile | null }> {
  // Step 1: cmd 0x0D — expect at least 60-byte response frame.
  const ext = await sendAndAwaitOk(iface, addr, Buffer.from([DS2_CMD_HW_REF]));
  // `ext` is frame.data = [STATUS, D0..Dn]. MS4x's `span2[57..59]` refers
  // to absolute frame offsets which map to ext[55..57] (frame offset N
  // = ext[N - 2] because frame.data starts at frame offset 2 / STATUS).
  if (ext.length < 58) {
    throw new DirectModeError(
      `hardware-reference response too short: ${ext.length + 2} bytes (need ≥60)`,
      'precheck',
    );
  }
  const addrHi = ext[55];
  const addrMid = ext[56];
  const addrLo = ext[57];

  // Inter-command pacing (MS4x Flasher uses 100 ms).
  await new Promise((r) => setTimeout(r, 100));

  // Step 2: memory read at the resolved address — 4-byte address with
  // leading 0x00 segment (verified against MS42 earlier), 8 bytes.
  const idResp = await sendAndAwaitOk(
    iface,
    addr,
    Buffer.from([DS2_CMD_MEMORY_READ, 0x00, addrHi, addrMid, addrLo, 8]),
  );
  // idResp = [STATUS, 8 ASCII bytes]. Expect 9 bytes total.
  if (idResp.length < 9) {
    throw new DirectModeError(
      `id-read response too short: ${idResp.length} bytes (need ≥9)`,
      'precheck',
    );
  }
  const idAscii = idResp.subarray(1, 9).toString('ascii');
  const identKey = idAscii.slice(0, 6);
  const profile = findByIdentKey(identKey);
  return { identKey, idAscii, profile };
}

/**
 * DS2 baud-switch command payloads (sent at the current baud; ECU acks
 * with 0xA0, then both ends move to the new rate).
 *
 * Per `docs/raw-ds2-flashing.md` §1.3 — verified against a real MS42.
 */
const BAUD_SWITCH_PAYLOADS: Record<number, Buffer> = {
  9600:   Buffer.from([0x91, 0x00, 0x25, 0x80, 0x01]),
  19200:  Buffer.from([0x91, 0x00, 0x4b, 0x00, 0x01]),
  38400:  Buffer.from([0x91, 0x00, 0x96, 0x00, 0x01]),
  62500:  Buffer.from([0x91, 0x00, 0xf4, 0x24, 0x01]),
  125000: Buffer.from([0x91, 0x01, 0xe8, 0x48, 0x01]),
};

/**
 * Switch the K-line to a higher baud for the rest of the session.
 * Sends the DS2 baud-switch command at the current baud, waits for the
 * ECU's `0xA0` ack, then reconfigures the local UART.
 */
export async function switchBaud(
  iface: DirectModeTransport,
  profile: EcuProfile,
  newBaud: number,
): Promise<void> {
  const payload = BAUD_SWITCH_PAYLOADS[newBaud];
  if (!payload) {
    throw new DirectModeError(
      `unsupported baud ${newBaud} (valid: ${Object.keys(BAUD_SWITCH_PAYLOADS).join(', ')})`,
      'baud-switch',
    );
  }
  await sendAndAwaitOk(iface, profile.ds2Addr, payload);
  // Give the ECU a moment to settle on the new rate before we follow.
  await new Promise((r) => setTimeout(r, 50));
  await iface.reconfigureBaud(newBaud);
}

// ── AUTH ────────────────────────────────────────────────────────────

const DEFAULT_NONCE = 7;

async function runAuth(
  iface: DirectModeTransport,
  profile: EcuProfile,
  nonce: number = DEFAULT_NONCE,
): Promise<void> {
  const seedReq = buildSeedRequestPayload(nonce);
  // SEED_KEY is a programming-mode command per docs §3.2 — frame:
  // `[ADDR] LEN 07 90 42 4D 57 NONCE [XOR]`.
  const seedRespPayload = await sendAndAwaitOk(
    iface,
    profile.ds2Addr,
    Buffer.concat([Buffer.from([DS2_CMD_PROG_PREFIX]), seedReq]),
  );
  // The seed bytes follow the status byte.
  const seed = seedRespPayload.subarray(1);
  const key = deriveKey(seed, nonce);
  const keySubmit = buildKeySubmitPayload(key);
  const ack = await sendAndAwaitOk(
    iface,
    profile.ds2Addr,
    Buffer.concat([Buffer.from([DS2_CMD_PROG_PREFIX]), keySubmit]),
  );
  if (ack[0] !== DS2_STATUS_OK) {
    throw new DirectModeError(`key rejected (status 0x${ack[0].toString(16)})`, 'auth');
  }
}

// ── ERASE / WRITE / READ ────────────────────────────────────────────

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

function buildReadRequest(addr: number, size: number): Buffer {
  // MS42 wants a 4-byte address with a leading 0x00 segment selector.
  // 3-byte addressing only reaches the low 32 KB; high flash needs the
  // explicit segment byte. Verified empirically against a real MS42 —
  // `12 09 06 00 04 80 00 10` returns flash data, `12 08 06 04 80 00 10`
  // returns status 0xB0.
  return Buffer.from([
    DS2_CMD_MEMORY_READ,
    (addr >> 24) & 0xff,
    (addr >> 16) & 0xff,
    (addr >> 8) & 0xff,
    addr & 0xff,
    size,
  ]);
}

async function eraseRegion(
  iface: DirectModeTransport,
  profile: EcuProfile,
  region: FlashRegion,
): Promise<void> {
  await sendAndAwaitOk(
    iface,
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
  iface: DirectModeTransport,
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
    await sendAndAwaitOk(iface, profile.ds2Addr, buildWriteRequest(ecuAddr, data), {
      totalTimeoutMs: 30_000,
    });
    bytesWritten += chunkSize;
    pos += chunkSize;
    onChunk?.(pos, length);
  }
  return { bytesWritten, bytesSkipped };
}

async function readRegion(
  iface: DirectModeTransport,
  profile: EcuProfile,
  region: FlashRegion,
  onChunk?: (read: number, total: number) => void,
): Promise<Buffer> {
  const length = region.end - region.start + 1;
  const out = Buffer.alloc(length);
  let pos = 0;
  while (pos < length) {
    const chunkSize = Math.min(profile.readBlockSize, length - pos);
    const resp = await sendAndAwaitOk(
      iface,
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
  iface: DirectModeTransport;
  profile: EcuProfile;
  identPayload: Buffer;
}

async function ident(
  cfg: DirectModeSessionConfig,
  onProgress?: DirectModeProgressFn,
): Promise<PreparedSession> {
  onProgress?.({ stage: 'precheck', message: 'IDENT' });
  const candidates = cfg.forceVariant
    ? [cfg.forceVariant === 'GS20' ? 0x32 : 0x12]
    : [0x12, 0x32];

  let profile: EcuProfile | null = null;
  let identPayload: Buffer | null = null;
  let detectedKey: string | null = null;
  let lastErr: Error | null = null;

  for (const addr of candidates) {
    try {
      // Standard IDENT (cmd 0x00) for the human-readable identification
      // string. Always issued — used downstream for `decodeIdent`.
      const { identPayload: ip } = await runIdent(cfg.iface, addr);
      identPayload = ip;

      if (cfg.forceVariant) {
        // User pinned the variant — accept whatever responded at this
        // address. Skip the dispatch-key probe entirely.
        profile = getProfile(cfg.forceVariant);
        break;
      }

      // MS4x-Flasher-style dispatch: cmd 0x0D → 3-byte addr at bytes
      // 57-59 → cmd 0x06 → 8-byte ASCII → first 6 chars as the key.
      onProgress?.({ stage: 'precheck', message: 'dispatch-ID' });
      const dispatch = await runDispatchIdent(cfg.iface, addr);
      detectedKey = dispatch.identKey;
      if (dispatch.profile) {
        profile = dispatch.profile;
        break;
      }
    } catch (err) {
      lastErr = err as Error;
    }
  }

  if (!profile || !identPayload) {
    const keyHint = detectedKey ? ` (got dispatch-key "${detectedKey}")` : '';
    throw new DirectModeError(
      cfg.forceVariant
        ? `IDENT against forced variant ${cfg.forceVariant} failed: ${lastErr?.message ?? 'no response'}`
        : `IDENT did not match any known ECU profile${keyHint}` +
          (lastErr ? ` (last error: ${lastErr.message})` : ''),
      'precheck',
    );
  }
  onProgress?.({
    stage: 'precheck',
    message: `identified as ${profile.variant}`,
  });
  return { iface: cfg.iface, profile, identPayload };
}

export interface DirectModeProbeResult {
  variant: string;
  ident: IdentFields;
}

export async function probe(
  cfg: DirectModeSessionConfig,
  onProgress?: DirectModeProgressFn,
): Promise<DirectModeProbeResult> {
  const { profile, identPayload } = await ident(cfg, onProgress);
  return {
    variant: profile.variant,
    ident: decodeIdent(identPayload),
  };
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
  const { iface, profile } = await ident(cfg, onProgress);

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
        `this will rewrite the same regions as --mode full.`,
    });
  }

  onProgress?.({ stage: 'auth', message: 'SEED/KEY' });
  await runAuth(iface, profile, opts.nonce);

  const regions = pickRegions(profile, opts.mode, 'write');
  const total = totalBytesForMode(profile, opts.mode, 'write');

  onProgress?.({ stage: 'erase', message: `erasing ${regions.length} region(s)` });
  for (const r of regions) {
    await eraseRegion(iface, profile, r);
  }

  onProgress?.({ stage: 'write', message: 'programming', fraction: 0 });
  let totalWritten = 0;
  let totalSkipped = 0;
  for (const r of regions) {
    const { bytesWritten, bytesSkipped } = await writeRegion(
      iface,
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
      const back = await readRegion(iface, profile, r, (read, regionLen) => {
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
}

export interface DirectModeReadOptions {
  mode: FlashMode;
  /**
   * If set, switch the K-line to this baud after IDENT to speed up the
   * dump. Must be one of: 9600, 19200, 38400, 62500, 125000.
   * Defaults to 38400 — a ~4× speedup over 9600 and rock-solid on K-line
   * with the FTDI cable. Pass `9600` to skip the switch.
   */
  readBaud?: number;
}

export async function readFlash(
  cfg: DirectModeSessionConfig,
  opts: DirectModeReadOptions,
  onProgress?: DirectModeProgressFn,
): Promise<{ variant: string; image: Buffer }> {
  const { iface, profile } = await ident(cfg, onProgress);
  const targetBaud = opts.readBaud ?? 38400;
  if (targetBaud !== 9600) {
    onProgress?.({ stage: 'precheck', message: `switching baud to ${targetBaud}` });
    await switchBaud(iface, profile, targetBaud);
  }
  const regions = pickRegions(profile, opts.mode, 'read');
  const total = totalBytesForMode(profile, opts.mode, 'read');
  // For FULL mode we lay regions out in a binSize buffer (preserves
  // 0xFF gaps between regions — matches MS4x Flasher's 512 KB layout).
  // For CALIBRATION we emit a tight buffer of just the region data
  // (matches MS4x Flasher's 32 KB output for partial dumps).
  const tight = opts.mode === 'calibration';
  const out = tight ? Buffer.alloc(total, 0xff) : Buffer.alloc(profile.binSize, 0xff);
  let done = 0;
  let tightCursor = 0;
  onProgress?.({ stage: 'read', message: 'reading', fraction: 0 });
  for (const r of regions) {
    const data = await readRegion(iface, profile, r, (read) => {
      onProgress?.({
        stage: 'read',
        message: `region 0x${r.start.toString(16)}: ${read}/${r.end - r.start + 1}`,
        fraction: (done + read) / total,
      });
    });
    if (tight) {
      data.copy(out, tightCursor);
      tightCursor += data.length;
    } else {
      data.copy(out, r.binOffset);
    }
    done += data.length;
  }
  // Restore 9600 so the ECU is in a known state for the next session.
  // Without this, the ECU stays at the elevated rate until power-cycle,
  // and a follow-up IDENT at 9600 times out.
  if (targetBaud !== 9600) {
    try {
      await switchBaud(iface, profile, 9600);
    } catch {
      /* best-effort: a power cycle resets it anyway */
    }
  }
  onProgress?.({ stage: 'done', message: 'complete' });
  return { variant: profile.variant, image: out };
}
