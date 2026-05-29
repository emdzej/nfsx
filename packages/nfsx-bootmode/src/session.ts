/**
 * High-level bootmode flash session orchestration.
 *
 * Brings together: serial transport → BSL handshake → MiniMon command
 * client → AMD 29F400B flash driver → full read / write / verify flows.
 *
 * The expected flow for a write:
 *   1. assertBundleIntegrity() — verify shipped blobs are intact
 *   2. transport.open() at the chosen baud (BSL auto-bauds)
 *   3. performHandshake() — uploads LOADK then MINIMONK
 *   4. flashDriver.upload() — uploads A29F400B driver into RAM
 *   5. flashDriver.unlock()
 *   6. flashDriver.eraseRange(0, 0x7FFFF)
 *   7. flashDriver.programBlock(addr, slice) — chunked over the BIN
 *   8. verify by reading back and comparing
 *
 * For a read: handshake → driver upload → readBlock loop over 0..0x7FFFF.
 *
 * The C167 BSL identification byte for the C167CR used in MS42/MS43 is
 * `0xC5`. Different MCU derivatives report different bytes per AP16012.
 */
import { Buffer } from 'node:buffer';
import { assertBundleIntegrity, loadBundleManifest, readBundledBlob } from './manifest.js';
import { parseIntelHex, flattenIntelHex } from './intel-hex.js';
import {
  NodeBootmodeTransport,
  type BootmodeTransport,
  type BootmodeTransportConfig,
} from './transport.js';
import { performHandshake } from './handshake.js';
import { MinimonClient } from './minimon.js';
import { FlashDriver, AM29F400B_TOTAL_BYTES } from './flash-driver.js';

/** Default BSL identification byte for the C167CR (MS42/MS43). */
export const C167CR_BSL_ID = 0xc5;

export interface BootmodeSessionConfig extends BootmodeTransportConfig {
  /** BSL identification byte (default: C167CR / 0xC5). */
  expectedBslId?: number;
  /** Skip integrity check (NOT recommended; only for offline tests). */
  skipIntegrityCheck?: boolean;
  /** Inter-byte delay during loader upload (ms). 0 = none. */
  loaderInterByteDelayMs?: number;
}

export interface BootmodeProgress {
  stage:
    | 'integrity'
    | 'handshake-primary'
    | 'handshake-secondary'
    | 'driver-upload'
    | 'unlock'
    | 'erase'
    | 'read'
    | 'program'
    | 'verify'
    | 'done';
  message: string;
  /** Optional 0..1 fraction within the current stage. */
  fraction?: number;
}

export type BootmodeProgressFn = (p: BootmodeProgress) => void;

interface PreparedSession {
  transport: BootmodeTransport;
  minimon: MinimonClient;
  flash: FlashDriver;
}

async function prepareSession(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<PreparedSession> {
  if (!cfg.skipIntegrityCheck) {
    onProgress?.({ stage: 'integrity', message: 'verifying bundled MiniMon blobs' });
    assertBundleIntegrity();
  }

  const primary = flattenIntelHex(parseIntelHex(readBundledBlob('LOADK.hex').toString('utf8')));
  const secondary = flattenIntelHex(
    parseIntelHex(readBundledBlob('MINIMONK.hex').toString('utf8')),
  );
  const driver = flattenIntelHex(parseIntelHex(readBundledBlob('A29F400B.hex').toString('utf8')));

  const transport = new NodeBootmodeTransport(cfg);
  await transport.open();

  await performHandshake(transport, {
    expectedIdByte: cfg.expectedBslId ?? C167CR_BSL_ID,
    primaryLoader: primary,
    secondaryLoader: secondary,
    interByteDelayMs: cfg.loaderInterByteDelayMs,
    onProgress: (stage, byte, total) => {
      const fraction = byte / total;
      onProgress?.({
        stage: stage === 'primary' ? 'handshake-primary' : 'handshake-secondary',
        message: `loader byte ${byte}/${total}`,
        fraction,
      });
    },
  });

  const minimon = new MinimonClient(transport);

  onProgress?.({ stage: 'driver-upload', message: 'uploading AM29F400B driver into RAM' });
  const flash = new FlashDriver(minimon, driver);
  await flash.upload();
  return { transport, minimon, flash };
}

/**
 * Read the full 512 KB flash image. Returns the 0x80000-byte buffer.
 */
export async function readFullFlash(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<Buffer> {
  const { transport, minimon, flash } = await prepareSession(cfg, onProgress);
  try {
    const out = Buffer.alloc(AM29F400B_TOTAL_BYTES, 0xff);
    const CHUNK = 256;
    onProgress?.({ stage: 'read', message: 'reading 512 KB flash', fraction: 0 });
    for (let off = 0; off < AM29F400B_TOTAL_BYTES; off += CHUNK) {
      const len = Math.min(CHUNK, AM29F400B_TOTAL_BYTES - off);
      const chunk = await minimon.readBlock(off, len);
      chunk.copy(out, off);
      onProgress?.({
        stage: 'read',
        message: `read ${off + len}/${AM29F400B_TOTAL_BYTES}`,
        fraction: (off + len) / AM29F400B_TOTAL_BYTES,
      });
    }
    onProgress?.({ stage: 'done', message: 'read complete', fraction: 1 });
    return out;
  } finally {
    await transport.close();
  }
}

export interface WriteFlashOptions {
  /** Skip verify-by-readback after programming (faster but no safety net). */
  skipVerify?: boolean;
}

/**
 * Write the supplied 512 KB image to flash. Mandatory: full-size BIN
 * (0x80000 bytes). Optional: verify by readback after.
 *
 * The flow follows AM29F400B requirements: unlock → erase per sector
 * → program word-aligned chunks → optional verify.
 */
export async function writeFullFlash(
  image: Buffer,
  cfg: BootmodeSessionConfig,
  opts: WriteFlashOptions = {},
  onProgress?: BootmodeProgressFn,
): Promise<{ verified: boolean }> {
  if (image.length !== AM29F400B_TOTAL_BYTES) {
    throw new Error(
      `writeFullFlash expects exactly ${AM29F400B_TOTAL_BYTES} bytes (got ${image.length})`,
    );
  }
  const { transport, minimon, flash } = await prepareSession(cfg, onProgress);
  try {
    onProgress?.({ stage: 'unlock', message: 'unlocking flash bank' });
    await flash.unlock();

    onProgress?.({ stage: 'erase', message: 'erasing all sectors' });
    const erased = await flash.eraseRange(0, AM29F400B_TOTAL_BYTES - 1);
    onProgress?.({
      stage: 'erase',
      message: `erased ${erased.length} sectors`,
      fraction: 1,
    });

    // Program in chunks; skip runs of 0xFF (already-erased flash).
    const CHUNK = 256;
    let programmedBytes = 0;
    onProgress?.({ stage: 'program', message: 'programming flash', fraction: 0 });
    for (let off = 0; off < image.length; off += CHUNK) {
      const slice = image.subarray(off, off + CHUNK);
      if (slice.every((b) => b === 0xff)) {
        programmedBytes += slice.length;
        continue;
      }
      await flash.programBlock(off, slice);
      programmedBytes += slice.length;
      onProgress?.({
        stage: 'program',
        message: `programmed ${programmedBytes}/${image.length}`,
        fraction: programmedBytes / image.length,
      });
    }

    let verified = false;
    if (!opts.skipVerify) {
      onProgress?.({ stage: 'verify', message: 'reading back for byte-by-byte verify', fraction: 0 });
      const READBACK_CHUNK = 256;
      verified = true;
      for (let off = 0; off < image.length; off += READBACK_CHUNK) {
        const len = Math.min(READBACK_CHUNK, image.length - off);
        const got = await minimon.readBlock(off, len);
        for (let j = 0; j < len; j++) {
          if (got[j] !== image[off + j]) {
            verified = false;
            throw new Error(
              `verify mismatch at 0x${(off + j).toString(16).padStart(5, '0')}: ` +
                `wrote 0x${image[off + j].toString(16).padStart(2, '0')}, ` +
                `read 0x${got[j].toString(16).padStart(2, '0')}`,
            );
          }
        }
        onProgress?.({
          stage: 'verify',
          message: `verified ${off + len}/${image.length}`,
          fraction: (off + len) / image.length,
        });
      }
    }

    onProgress?.({ stage: 'done', message: 'write complete', fraction: 1 });
    return { verified };
  } finally {
    await transport.close();
  }
}

/**
 * Quick connectivity probe — runs the handshake and reads the flash
 * manufacturer/device ID, then disconnects. Useful before committing to
 * a full read/write.
 */
export async function probeBootmode(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<{ manufacturer: number; device: number }> {
  const { transport, flash } = await prepareSession(cfg, onProgress);
  try {
    const id = await flash.getState();
    onProgress?.({
      stage: 'done',
      message: `flash ID: manufacturer=0x${id.manufacturer
        .toString(16)
        .padStart(2, '0')}, device=0x${id.device.toString(16).padStart(2, '0')}`,
    });
    return id;
  } finally {
    await transport.close();
  }
}

/** Diagnostic: list what's bundled. */
export function describeBundle(): { source: string; license: string; blobs: Array<{ name: string; role: string; sha256: string }> } {
  const m = loadBundleManifest();
  return {
    source: m.source,
    license: m.license,
    blobs: m.blobs.map((b) => ({ name: b.name, role: b.role, sha256: b.sha256 })),
  };
}
