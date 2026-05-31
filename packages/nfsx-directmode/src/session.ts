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
  DS2_PROG_VERIFY,
  DS2_STATUS_OK,
  DS2_STATUS_PENDING,
} from './ds2.js';
import { decodeIdent, type IdentFields } from './identity.js';
import { buildRequestPayload } from './transport.js';
import {
  buildSeedRequestPayload,
  buildKeySubmitPayload,
  deriveKey,
  SEED_RESP_LEN_AUTHORISED,
  SEED_RESP_LEN_FULL,
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

async function sendAndReceiveRaw(
  iface: DirectModeTransport,
  addr: number,
  payload: Buffer,
): Promise<Buffer> {
  const request = buildRequestPayload(addr, payload);
  const MAX_ATTEMPTS = 8;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
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
      // Validate frame integrity (LEN + XOR) by decoding.
      decodeFrame(full);
      return full;
    } catch (err) {
      lastErr = err as Error;
      if (/non-OK status/.test(lastErr.message)) break;
    }
  }
  throw new DirectModeError(lastErr?.message ?? 'frame error', 'frame');
}

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
 * ECU identification via hardware-reference dispatch: send cmd 0x0D
 * (hardware-reference query), extract the 3-byte memory address from
 * bytes 57-59 of the response frame, then read 8 ASCII bytes from that
 * address via cmd 0x06. First 6 chars of those bytes are the
 * protocol-class dispatch key. Lookup in the per-profile `identKey`
 * table to resolve the variant.
 *
 * Same sequence is used by the engine factory (addr 0x12) and TCU
 * factory (addr 0x32) to pick between MS42/MS43/GS20 etc.
 */
export async function runDispatchIdent(
  iface: DirectModeTransport,
  addr: number,
): Promise<{ identKey: string; idAscii: string; profile: EcuProfile | null }> {
  // Step 1: cmd 0x0D — expect at least 60-byte response frame.
  const ext = await sendAndAwaitOk(iface, addr, Buffer.from([DS2_CMD_HW_REF]));
  // `ext` is frame.data = [STATUS, D0..Dn]. Absolute frame offsets
  // [57..59] map to ext[55..57] (frame offset N = ext[N - 2] because
  // frame.data starts at frame offset 2 / STATUS).
  if (ext.length < 58) {
    throw new DirectModeError(
      `hardware-reference response too short: ${ext.length + 2} bytes (need ≥60)`,
      'precheck',
    );
  }
  const addrHi = ext[55];
  const addrMid = ext[56];
  const addrLo = ext[57];

  // Inter-command pacing (upstream tooling uses 100 ms).
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
  // 1. Send seed request: payload = [0x90, 0x42, 0x4D, 0x57, NONCE].
  //    NO 0x07 programming-prefix — bench-verified against the ECU.
  //    Full DS2 frame on the wire is
  //    [ADDR] [LEN=8] [0x90, 0x42, 0x4D, 0x57, NONCE] [XOR].
  const seedReq = buildSeedRequestPayload(nonce);
  const seedFrame = await sendAndReceiveRaw(iface, profile.ds2Addr, seedReq);

  // Response shape:
  //   - STATUS (frame[2]) must be 0xA0.
  //   - If LEN (frame[1]) == 5 → ECU already authorised, no key needed.
  //   - If LEN == 46 → seed material present, derive + submit key.
  const status = seedFrame[2];
  const lenByte = seedFrame[1];
  if (status !== DS2_STATUS_OK) {
    throw new DirectModeError(
      `seed request rejected (status 0x${status.toString(16)})`,
      'auth',
    );
  }
  if (lenByte === SEED_RESP_LEN_AUTHORISED) {
    // ECU was already in programming mode (e.g. previous session left
    // it authorised). No key submission needed.
    return;
  }
  if (lenByte !== SEED_RESP_LEN_FULL) {
    throw new DirectModeError(
      `unexpected seed response LEN: 0x${lenByte.toString(16)} (expected 0x05 or 0x2E)`,
      'auth',
    );
  }

  // 2. Derive key from the FULL received frame (NOT just the data).
  //    Indices 1, 18, 41, (nonce+i) mod frame[1] are frame-absolute.
  const key = deriveKey(seedFrame, nonce);

  // 3. Submit key: payload = [0x90, k0, k1, k2, k3]. Same opcode as the
  //    seed request — the ECU disambiguates by payload shape.
  const keySubmit = buildKeySubmitPayload(key);
  const ack = await sendAndAwaitOk(iface, profile.ds2Addr, keySubmit);
  if (ack[0] !== DS2_STATUS_OK) {
    throw new DirectModeError(`key rejected (status 0x${ack[0].toString(16)})`, 'auth');
  }
}

// ── ERASE / WRITE / READ ────────────────────────────────────────────

function buildEraseRequest(sectorStart: number): Buffer {
  // Verified against upstream tooling:
  //   payload = [0x07, 0x06, A_HI, A_MID, A_LO, 0x00]
  // The ECU erases one flash SECTOR identified by its start address;
  // there is no "end" parameter (the chip itself defines sector size).
  // Earlier versions of this function sent an 8-byte address-pair which
  // the ECU rejected with status 0xB0.
  return Buffer.from([
    DS2_CMD_PROG_PREFIX,
    DS2_PROG_ERASE,
    (sectorStart >> 16) & 0xff,
    (sectorStart >> 8) & 0xff,
    sectorStart & 0xff,
    0,
  ]);
}

function buildPollRequest(addr: number): Buffer {
  // Verified against upstream tooling:
  //   payload = [0x07, 0x0F, A_HI, A_MID, A_LO, 0x00]
  // Cmd 0x07 0x0F polls the programming-state machine. Used after
  // erase + write to wait for the operation to complete and (in strict
  // mode) check the result byte at frame[8].
  return Buffer.from([
    DS2_CMD_PROG_PREFIX,
    DS2_PROG_VERIFY,
    (addr >> 16) & 0xff,
    (addr >> 8) & 0xff,
    addr & 0xff,
    0,
  ]);
}

/**
 * Operation result byte at frame offset 8 of erase/write/poll responses.
 * Values from upstream tooling, 451-477, 550-563.
 */
const OP_RESULT_OK = 1;
const OP_RESULT_ERRORS: Record<number, string> = {
  2: 'op result 0x02 (write-protect or generic erase failure)',
  9: 'op result 0x09 (address out of range)',
  10: 'op result 0x0A (alignment error)',
  11: 'op result 0x0B (flash not erased before write)',
  12: 'op result 0x0C (voltage out of spec)',
  13: 'op result 0x0D (programming timeout)',
  14: 'op result 0x0E (protection bit set)',
  15: 'op result 0x0F (verify / CRC mismatch)',
};

function checkOpResult(frame: Buffer, stage: 'erase' | 'write' | 'verify'): void {
  if (frame.length < 9) {
    throw new DirectModeError(
      `${stage} response too short for result byte: ${frame.length} bytes`,
      stage,
    );
  }
  const rb = frame[8];
  if (rb === OP_RESULT_OK) return;
  const msg = OP_RESULT_ERRORS[rb] ?? `unknown op-result byte 0x${rb.toString(16)}`;
  throw new DirectModeError(`${stage}: ${msg}`, stage);
}

/**
 * Poll the programming state machine at `addr` until it reports a
 * non-pending status (0xA1 means "still busy, retry"). When `strict`
 * is true, also enforce that the op-result byte at frame[8] is OK.
 * Mirrors upstream tooling's the loose verify path (loose) and the strict verify path (strict).
 */
async function runPoll(
  iface: DirectModeTransport,
  profile: EcuProfile,
  addr: number,
  strict: boolean,
  totalTimeoutMs: number = 30_000,
): Promise<void> {
  const req = buildPollRequest(addr);
  const deadline = Date.now() + totalTimeoutMs;
  while (true) {
    const frame = await sendAndReceiveRaw(iface, profile.ds2Addr, req);
    const status = frame[2];
    if (status === DS2_STATUS_OK) {
      if (strict) checkOpResult(frame, 'verify');
      return;
    }
    if (status === DS2_STATUS_PENDING) {
      if (Date.now() > deadline) {
        throw new DirectModeError(`poll still pending after ${totalTimeoutMs} ms`, 'verify');
      }
      await new Promise((r) => setTimeout(r, 30));
      continue;
    }
    throw new DirectModeError(
      `poll returned status 0x${status.toString(16)}`,
      'verify',
    );
  }
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
  // Single erase command per region. The ECU erases the sector that
  // contains `region.start`; the chip itself defines sector boundaries.
  // For MS42/MS43 the writeable regions in `fullRegions` align with
  // AM29F400's sector boundaries, so one erase covers the whole region.
  const frame = await sendAndReceiveRaw(
    iface,
    profile.ds2Addr,
    buildEraseRequest(region.start),
  );
  if (frame[2] !== DS2_STATUS_OK) {
    throw new DirectModeError(
      `erase rejected (status 0x${frame[2].toString(16)})`,
      'erase',
    );
  }
  checkOpResult(frame, 'erase');
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
    const frame = await sendAndReceiveRaw(
      iface,
      profile.ds2Addr,
      buildWriteRequest(ecuAddr, data),
    );
    if (frame[2] !== DS2_STATUS_OK) {
      throw new DirectModeError(
        `write rejected at 0x${ecuAddr.toString(16)} (status 0x${frame[2].toString(16)})`,
        'write',
      );
    }
    // upstream tooling always inspects the op-result byte at frame[8] — a
    // 0xA0 status with op-result != 1 means the ECU accepted the
    // command frame but the flash operation itself failed.
    checkOpResult(frame, 'write');
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

      // Hardware-reference dispatch: cmd 0x0D → 3-byte addr at bytes
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
  /**
   * If set, switch the K-line to this baud after SEED/KEY to speed up
   * the write loop. Same set of supported rates as {@link readFlash}:
   * 9600 / 19200 / 38400 / 62500 / 125000. Defaults to 38400 — a ~4×
   * speedup over 9600 and bench-verified for reads. Pass `9600` to
   * keep the wire at the IDENT baud throughout. The baud is restored
   * to 9600 on exit (success or failure) so the next session can IDENT.
   *
   * Note: upstream tooling itself does NOT baud-switch during write; our
   * read-path empirical verification (38400 works cleanly with the
   * retry-on-transient logic) is the basis for using it here too. If
   * you observe `0xB0` rejections that don't reproduce at 9600, that
   * suggests the write path is more baud-sensitive than read.
   */
  writeBaud?: number;
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

  // Calibration mode accepts EITHER a full binSize BIN (data at the
  // ECU-absolute offset) or a tight cal-only BIN (data at offset 0).
  // The tight size equals the READ-region length — i.e. what
  // `readFlash -m calibration` produces — which is slightly larger than
  // the writable subset (the last 16/17 bytes are the read-only
  // checksum trailer the write path skips).
  if (opts.mode === 'calibration') {
    const readRegions = pickRegions(profile, 'calibration', 'read');
    const tightSize = readRegions.reduce((n, r) => n + (r.end - r.start + 1), 0);
    if (image.length === tightSize) {
      // Expand into a binSize-padded buffer so the existing region
      // walkers (which index by `region.binOffset`) keep working
      // unchanged. The expansion is local — the caller's buffer is
      // never mutated.
      const expanded = Buffer.alloc(profile.binSize, 0xff);
      let cursor = 0;
      for (const r of readRegions) {
        const len = r.end - r.start + 1;
        image.copy(expanded, r.binOffset, cursor, cursor + len);
        cursor += len;
      }
      image = expanded;
    } else if (image.length !== profile.binSize) {
      throw new DirectModeError(
        `BIN size mismatch: ${image.length} bytes — expected ${tightSize} (tight cal-only) ` +
          `or ${profile.binSize} (full BIN) for ${profile.variant} calibration mode`,
        'precheck',
      );
    }
  } else if (image.length !== profile.binSize) {
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

  // Speed-up: switch the K-line to a higher baud for the bulk write.
  // Same mechanism as readFlash — sends the DS2 baud-switch command,
  // waits for 0xA0, then reconfigures our UART. Restored to 9600 in
  // the `finally` after writeFlash returns (success or failure).
  const targetBaud = opts.writeBaud ?? 38400;
  if (targetBaud !== 9600) {
    onProgress?.({
      stage: 'auth',
      message: `switching baud to ${targetBaud}`,
    });
    await switchBaud(iface, profile, targetBaud);
  }

  const regions = pickRegions(profile, opts.mode, 'write');
  const total = totalBytesForMode(profile, opts.mode, 'write');

  let totalWritten = 0;
  let totalSkipped = 0;
  let verified = false;
  try {
  // Sequence per region:
  //   pollLoose(start) → erase(start) → write region → poll (strict on last)
  //
  // After ALL regions are written, the terminating per-region poll is
  // strict on the LAST region (checks the op-result byte at frame[8])
  // and loose on intermediate regions.
  // Group regions by erase-block address. A single 0x07 0x06 erase
  // command on MS4x ECUs can wipe MULTIPLE sectors, so multiple regions
  // can share one erase point. For MS42 full mode the lower program
  // (0x11000) and upper program (0x5002C) both declare eraseAddr=0x11000
  // — ONE erase covers both. Erasing between them would wipe the data
  // we just wrote (this is what caused the earlier verify-fail at
  // 0x11000 / 0xff).
  type EraseGroup = { eraseAddr: number; regions: FlashRegion[] };
  const groups: EraseGroup[] = [];
  for (const r of regions) {
    const eraseAddr = r.eraseAddr ?? r.start;
    let g = groups.find((x) => x.eraseAddr === eraseAddr);
    if (!g) {
      g = { eraseAddr, regions: [] };
      groups.push(g);
    }
    g.regions.push(r);
  }

  onProgress?.({ stage: 'write', message: 'programming', fraction: 0 });
  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const g = groups[gIdx];
    const isLastGroup = gIdx === groups.length - 1;

    onProgress?.({
      stage: 'erase',
      message: `pre-poll @ 0x${g.eraseAddr.toString(16)}`,
    });
    await runPoll(iface, profile, g.eraseAddr, false);

    onProgress?.({
      stage: 'erase',
      message: `erase block @ 0x${g.eraseAddr.toString(16)} (covers ${g.regions.length} region(s))`,
    });
    {
      const eFrame = await sendAndReceiveRaw(
        iface,
        profile.ds2Addr,
        buildEraseRequest(g.eraseAddr),
      );
      if (eFrame[2] !== DS2_STATUS_OK) {
        throw new DirectModeError(
          `erase rejected (status 0x${eFrame[2].toString(16)})`,
          'erase',
        );
      }
      checkOpResult(eFrame, 'erase');
    }

    // NO post-erase poll. Inserting one transitions the state machine
    // such that the first 0x07 0x02 write is rejected with 0xB0
    // (verified empirically against MS42).

    for (const r of g.regions) {
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

    // Post-group poll: strict on the LAST group (checks op-result byte
    // at frame[8]), loose between groups.
    onProgress?.({
      stage: 'write',
      message: `post-write poll @ 0x${g.eraseAddr.toString(16)}`,
    });
    await runPoll(iface, profile, g.eraseAddr, isLastGroup);
  }

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
  } finally {
    // Restore baud to 9600 so the next session can IDENT. Best-effort
    // — if this fails (e.g. ECU power-cycled mid-write), a fresh
    // power-cycle on the ECU side resets it to 9600 anyway.
    if (targetBaud !== 9600) {
      try {
        await switchBaud(iface, profile, 9600);
      } catch {
        /* swallow — primary error takes precedence */
      }
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
  // 0xFF gaps between regions — matches upstream tooling's 512 KB layout).
  // For CALIBRATION we emit a tight buffer of just the region data
  // (matches upstream tooling's 32 KB output for partial dumps).
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
