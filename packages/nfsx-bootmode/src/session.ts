/**
 * High-level bootmode flash session orchestration — browser-safe.
 *
 * Brings together: caller-supplied transport → BSL handshake → MiniMon
 * command client → AMD 29F400B flash driver → full read / write /
 * verify flows.
 *
 * The expected flow for a write:
 *   1. loader.verifyIntegrity() — verify shipped blobs are intact
 *   2. transport already open at the chosen baud (BSL auto-bauds)
 *   3. performHandshake() — uploads LOADK then MINIMONK
 *   4. flashDriver.upload() — uploads A29F400B driver into XRAM
 *   5. flashDriver.eraseSector() per sector
 *   7. flashDriver.programBlock(addr, slice) — chunked over the BIN
 *   8. verify by reading back and comparing
 *
 * For a read: handshake → driver upload → readBlock loop over 0..0x7FFFF.
 *
 * The transport lifecycle (open / close) is the caller's responsibility.
 * The `BundleLoader` supplies MiniMon blobs + integrity manifests; a
 * Node default lives in `manifest.ts` (imported via the `/node`
 * subpath), and a browser implementation lives in the web app.
 */
import { assertBundleIntegrity } from './bundle-loader.js';
import type { BundleLoader } from './bundle-loader.js';
import { parseIntelHex, flattenIntelHex } from './intel-hex.js';
import type { BootmodeTransport } from './transport-interface.js';
import { performHandshake } from './handshake.js';
import { MinimonClient } from './minimon.js';
import {
  JmgClient,
  JMG_ACK,
  JMG_PAGE_SIZE,
  JMG_TOTAL_PAGES,
} from './jmg-client.js';

/** Total flash size: AMD AM29F400BB = 512 KB. */
const AM29F400B_TOTAL_BYTES = 0x80000;

/** Bottom-boot AM29F400BB sector layout (confirmed for BMW MS42). */
const AM29F400BB_SECTORS = [
  { index: 0, start: 0x00000, size: 0x04000 }, // 16 KB
  { index: 1, start: 0x04000, size: 0x02000 }, // 8 KB
  { index: 2, start: 0x06000, size: 0x02000 }, // 8 KB
  { index: 3, start: 0x08000, size: 0x08000 }, // 32 KB
  { index: 4, start: 0x10000, size: 0x10000 }, // 64 KB
  { index: 5, start: 0x20000, size: 0x10000 },
  { index: 6, start: 0x30000, size: 0x10000 },
  { index: 7, start: 0x40000, size: 0x10000 },
  { index: 8, start: 0x50000, size: 0x10000 },
  { index: 9, start: 0x60000, size: 0x10000 },
  { index: 10, start: 0x70000, size: 0x10000 },
] as const;

/** Default BSL identification byte for the C167CR (MS42/MS43). */
export const C167CR_BSL_ID = 0xc5;

/**
 * C167CR bus-controller register addresses + values for reading the
 * external 512 KB flash (mapped at chip-side `0x800000`). Lifted from
 * the reference Python flasher's `jobReadExtFlash` path.
 */
const SYSCON_ADDR = 0x00ff12;
const BUSCON0_ADDR = 0x00ff0c;
const ADDRSEL1_ADDR = 0x00fe18;
const ADDRSEL2_ADDR = 0x00fe1a;
const ADDRSEL3_ADDR = 0x00fe1c;
const ADDRSEL4_ADDR = 0x00fe1e;
const BUSCON1_ADDR = 0x00ff14;
const BUSCON2_ADDR = 0x00ff16;
const BUSCON3_ADDR = 0x00ff18;
const BUSCON4_ADDR = 0x00ff1a;

/** External flash window base in the C167's view of memory (for reads).
 * JMG RE shows reads come from segment 0x08 (physical 0x080000).
 * MiniMon readBlock uses DPP-based addressing so 0x080000 is correct.
 */
const EXT_FLASH_ADDR = 0x080000;

/**
 * JMG-derived flash addressing.
 * Reverse-engineered from JMGarage bootmode flasher's secondary loader:
 *   - Flash WRITES go to segment 0x10 (physical 0x100000)
 *   - Flash READS/polls go from segment 0x08 (physical 0x080000)
 *   - P3.7 must be LOW (active-low write-enable gate on MS42 PCB)
 *   - ADDRSEL1=0x1008 maps CS1 window for segment 0x10
 */
const FLASH_WRITE_SEG = 0x10;
const FLASH_READ_SEG = 0x08;
const P3_ADDR = 0x00ffc4;
const DP3_ADDR = 0x00ffc6;

/**
 * Load the erase stub from bundled ERASE_STUB.hex.
 * Source: scripts/build-stubs.ts (see for full annotated C167 assembly).
 *
 * Register interface (callFunction R8-R15):
 *   R9  = sector base offset within segment
 *   R10 = flash WRITE segment (0x0010 + pageDelta)
 *   R11 = flash READ segment (0x0008 + pageDelta)
 *   R15 = return: 0=OK, 1=DQ5 timeout, 2=verify fail
 */
async function loadEraseStub(loader: BundleLoader): Promise<Uint8Array> {
  const hex = new TextDecoder().decode(await loader.getBlob('ERASE_STUB.hex'));
  return flattenIntelHex(parseIntelHex(hex));
}

/** Address where we upload the erase stub in XRAM. */
const ERASE_STUB_ADDR = 0x00e200;

/**
 * Load the autoselect probe stub from bundled PROBE_STUB.hex.
 * Source: scripts/build-stubs.ts
 *
 * Input: R10 = flash WRITE segment (0x0010), R11 = flash READ segment (0x0008)
 * Output: R8 = manufacturer ID, R9 = device ID
 */
async function loadProbeStub(loader: BundleLoader): Promise<Uint8Array> {
  const hex = new TextDecoder().decode(await loader.getBlob('PROBE_STUB.hex'));
  return flattenIntelHex(parseIntelHex(hex));
}

/**
 * Load the programmer stub from bundled PROGRAMMER_STUB.hex.
 * Source: scripts/build-stubs.ts
 *
 * Register interface:
 *   R9  = byte count (must be even)
 *   R10 = source offset in XRAM
 *   R11 = source segment (0 for XRAM)
 *   R12 = flash WRITE segment for DATA (0x0010 + pageDelta)
 *   R13 = destination offset within flash segment
 *   R15 = return status (always 0=OK)
 */
async function loadProgrammerStub(
  loader: BundleLoader,
): Promise<{ code: Uint8Array; entryOffset: number }> {
  const hex = new TextDecoder().decode(await loader.getBlob('PROGRAMMER_STUB.hex'));
  const code = flattenIntelHex(parseIntelHex(hex));
  return { code, entryOffset: 0 };
}

/** Address where we upload the programmer stub in XRAM. */
const PROGRAMMER_STUB_ADDR = 0x00e300; // after the erase stub

async function configureExtFlashBus(minimon: MinimonClient): Promise<void> {
  // Use JMG-derived bus config for reads (segment 0x08 via CS2/ADDRSEL2).
  // Same as write config but without asserting P3.7 write-enable.
  await minimon.writeWord(SYSCON_ADDR, 0xe3ff);
  await minimon.writeWord(ADDRSEL1_ADDR, 0x1008);
  await minimon.writeWord(ADDRSEL2_ADDR, 0x08e1);
  await minimon.writeWord(ADDRSEL3_ADDR, 0x00a0);
  await minimon.writeWord(ADDRSEL4_ADDR, 0xfff0);
  await minimon.writeWord(BUSCON0_ADDR, 0x44ff);
  await minimon.writeWord(BUSCON1_ADDR, 0x84ff);
  await minimon.writeWord(BUSCON2_ADDR, 0x04ff);
  await minimon.writeWord(BUSCON3_ADDR, 0x85ff);
  await minimon.writeWord(BUSCON4_ADDR, 0x00ff);
}

/**
 * Bus config for WRITE / erase / program operations.
 * Derived from JMGarage bootmode flasher's secondary loader (RE'd from binary):
 *   - ADDRSEL1=0x1008 → CS1 covers segment 0x10 area (flash write window)
 *   - ADDRSEL2=0x08E1 → CS2 covers segment 0x08 area (flash read window)
 *   - BUSCON1 configured for 16-bit demux with write timing
 *   - P3.7 driven LOW = active-low write-enable gate on MS42 PCB
 *
 * The MS42 PCB has a hardware gate: P3.7 (directly or via latch) controls
 * whether the C167's WR# strobe reaches the AM29F400BB's WE# pin. Without
 * asserting P3.7=LOW, all write bus cycles are blocked at the board level.
 */
async function configureExtFlashBusForWrite(minimon: MinimonClient): Promise<void> {
  await minimon.writeWord(SYSCON_ADDR, 0xe3ff);
  await minimon.writeWord(ADDRSEL1_ADDR, 0x1008);
  await minimon.writeWord(ADDRSEL2_ADDR, 0x08e1);
  await minimon.writeWord(ADDRSEL3_ADDR, 0x00a0);
  await minimon.writeWord(ADDRSEL4_ADDR, 0xfff0);
  await minimon.writeWord(BUSCON0_ADDR, 0x44ff);
  await minimon.writeWord(BUSCON1_ADDR, 0x84ff);
  await minimon.writeWord(BUSCON2_ADDR, 0x04ff);
  await minimon.writeWord(BUSCON3_ADDR, 0x85ff);
  await minimon.writeWord(BUSCON4_ADDR, 0x00ff);

  // ═══ CRITICAL: Assert write-enable (P3.7 = LOW, DP3.7 = output) ═══
  const dp3 = await minimon.readWord(DP3_ADDR);
  await minimon.writeWord(DP3_ADDR, dp3 | 0x0080);
  const p3 = await minimon.readWord(P3_ADDR);
  await minimon.writeWord(P3_ADDR, p3 & ~0x0080);
}

/**
 * Bootmode session config. Transport must already be opened; loader
 * supplies the bundled MiniMon blobs.
 */
export interface BootmodeSessionConfig {
  transport: BootmodeTransport;
  bundle: BundleLoader;
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
  minimon: MinimonClient;
}

async function prepareSession(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<PreparedSession> {
  if (!cfg.skipIntegrityCheck) {
    onProgress?.({ stage: 'integrity', message: 'verifying bundled MiniMon blobs' });
    await assertBundleIntegrity(cfg.bundle);
  }

  const primary = flattenIntelHex(
    parseIntelHex(new TextDecoder().decode(await cfg.bundle.getBlob('LOADK.hex'))),
  );
  const secondary = flattenIntelHex(
    parseIntelHex(new TextDecoder().decode(await cfg.bundle.getBlob('MINIMONK.hex'))),
  );

  await performHandshake(cfg.transport, {
    expectedIdByte: cfg.expectedBslId ?? C167CR_BSL_ID,
    primaryLoader: primary,
    secondaryLoader: secondary,
    interByteDelayMs: cfg.loaderInterByteDelayMs,
    onProgress: (stage, byte, total) => {
      onProgress?.({
        stage: stage === 'primary' ? 'handshake-primary' : 'handshake-secondary',
        message: `loader byte ${byte}/${total}`,
        fraction: byte / total,
      });
    },
  });

  const minimon = new MinimonClient(cfg.transport);

  // Reference Python flasher always probes comms via C_TEST_COMM right
  // after the handshake completes. Mirrors that and surfaces "MiniMon
  // isn't actually responding" failures cleanly before any real work.
  await minimon.testComm();

  return { minimon };
}

/**
 * Read the full 512 KB flash image. Returns the 0x80000-byte buffer.
 * Caller retains transport ownership — this function does NOT close it.
 */
export async function readFullFlash(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<Uint8Array> {
  const { minimon } = await prepareSession(cfg, onProgress);
  // Configure the C167 bus controller for external-flash access.
  // Reads don't need the AM29F400B flash driver — once the bus is
  // wired up, the flash is just memory at EXT_FLASH_ADDR.
  onProgress?.({ stage: 'driver-upload', message: 'configuring external bus' });
  await configureExtFlashBus(minimon);

  const out = new Uint8Array(AM29F400B_TOTAL_BYTES).fill(0xff);
  const CHUNK = 256;
  onProgress?.({ stage: 'read', message: 'reading 512 KB flash', fraction: 0 });
  for (let off = 0; off < AM29F400B_TOTAL_BYTES; off += CHUNK) {
    const len = Math.min(CHUNK, AM29F400B_TOTAL_BYTES - off);
    const chunk = await minimon.readBlock(EXT_FLASH_ADDR + off, len);
    out.set(chunk, off);
    onProgress?.({
      stage: 'read',
      message: `read ${off + len}/${AM29F400B_TOTAL_BYTES}`,
      fraction: (off + len) / AM29F400B_TOTAL_BYTES,
    });
  }
  onProgress?.({ stage: 'done', message: 'read complete', fraction: 1 });
  return out;
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
 *
 * Caller retains transport ownership — this function does NOT close it.
 */
export async function writeFullFlash(
  image: Uint8Array,
  cfg: BootmodeSessionConfig,
  opts: WriteFlashOptions = {},
  onProgress?: BootmodeProgressFn,
): Promise<{ verified: boolean }> {
  if (image.length !== AM29F400B_TOTAL_BYTES) {
    throw new Error(
      `writeFullFlash expects exactly ${AM29F400B_TOTAL_BYTES} bytes (got ${image.length})`,
    );
  }
  const { minimon } = await prepareSession(cfg, onProgress);
  onProgress?.({ stage: 'driver-upload', message: 'configuring external bus for write' });
  await configureExtFlashBusForWrite(minimon);

  const sectors = AM29F400BB_SECTORS;

  // Ensure WR# (P3.12) is configured as output for flash writes
  const dp3 = await minimon.readWord(DP3_ADDR);
  if (!(dp3 & 0x1000)) {
    await minimon.writeWord(DP3_ADDR, dp3 | 0x1000); // set DP3.12 = output
  }

  // ─── AMD Autoselect probe ─────────────────────────────────────
  // Confirm writes reach the flash chip by reading manufacturer/device ID.
  const probeStub = await loadProbeStub(cfg.bundle);
  await minimon.writeBlock(ERASE_STUB_ADDR, probeStub);
  const probeRegs = await minimon.callFunction(
    ERASE_STUB_ADDR,
    [0, 0, FLASH_WRITE_SEG, FLASH_READ_SEG, 0, 0, 0, 0],
    5000,
  );
  // R8=manufacturer ID (expect 0x0001 for AMD), R9=device ID (expect 0x22AB for AM29F400BB)
  if (probeRegs[0] === 0x0001 && (probeRegs[1] === 0x22ab || probeRegs[1] === 0x22ba)) {
    onProgress?.({
      stage: 'driver-upload',
      message: `detected AMD AM29F400B (mfr=0x${probeRegs[0]!.toString(16).padStart(4, '0')} dev=0x${probeRegs[1]!.toString(16).padStart(4, '0')})`,
    });
  } else {
    throw new Error(
      `autoselect probe failed: manufacturer=0x${probeRegs[0]!.toString(16).padStart(4, '0')} ` +
        `device=0x${probeRegs[1]!.toString(16).padStart(4, '0')} — flash writes not working`,
    );
  }

  // ─── ERASE ───────────────────────────────────────────────────
  const eraseStub = await loadEraseStub(cfg.bundle);
  await minimon.writeBlock(ERASE_STUB_ADDR, eraseStub);

  onProgress?.({ stage: 'erase', message: 'erasing sectors', fraction: 0 });
  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i]!;
    const sectorPageOffset = s.start & 0xffff;
    const sectorPageDelta = s.start >>> 16;
    const writeSeg = FLASH_WRITE_SEG + sectorPageDelta;
    const readSeg = FLASH_READ_SEG + sectorPageDelta;
    const regs = await minimon.callFunction(
      ERASE_STUB_ADDR,
      [0, sectorPageOffset, writeSeg, readSeg, 0, 0, 0, 0],
      30_000,
    );
    if (regs[7] !== 0) {
      throw new Error(
        `erase sector ${s.index} failed: R15=0x${regs[7]!.toString(16)} ` +
          `(1=DQ5 timeout, 2=verify fail) readback=0x${regs[0]!.toString(16).padStart(4, '0')}`,
      );
    }
    onProgress?.({
      stage: 'erase',
      message: `erased sector ${s.index} (0x${s.start.toString(16).padStart(5, '0')}, ${s.size} bytes)`,
      fraction: (i + 1) / sectors.length,
    });
  }

  // ─── PROGRAM ─────────────────────────────────────────────────
  const stub = await loadProgrammerStub(cfg.bundle);
  onProgress?.({
    stage: 'driver-upload',
    message: `uploading programmer stub (${stub.code.length} bytes)`,
  });
  await minimon.writeBlock(PROGRAMMER_STUB_ADDR, stub.code);

  const DATA_BUF = 0x00e200; // Reuse erase stub area (known-good distinct SRAM)
  const BLOCK = 128; // bytes per programming call (must be even, max 256 before stub at 0xE300)
  let programmedBytes = 0;
  onProgress?.({ stage: 'program', message: 'programming flash', fraction: 0 });
  let off = 0;
  while (off < image.length) {
    // Don't let a chunk cross a 64KB segment boundary
    const segEnd = ((off >>> 16) + 1) << 16;
    const end = Math.min(off + BLOCK, image.length, segEnd);
    const slice = image.subarray(off, end);
    // Skip all-0xFF blocks (already erased)
    if (slice.every((b) => b === 0xff)) {
      programmedBytes += slice.length;
      off += slice.length;
      continue;
    }
    await minimon.writeBlock(DATA_BUF, slice);
    const pageDelta = off >>> 16;
    const destOff = off & 0xffff;
    const regs = await minimon.callFunction(
      PROGRAMMER_STUB_ADDR + stub.entryOffset,
      [
        0,
        slice.length,
        DATA_BUF & 0xffff,
        0,
        FLASH_WRITE_SEG + pageDelta,
        destOff,
        FLASH_READ_SEG + pageDelta,
        0,
      ],
      30_000,
    );
    if (regs[7] !== 0) {
      throw new Error(
        `programmer stub failed at flash offset 0x${off.toString(16)}: R15=0x${regs[7]!.toString(16)}`,
      );
    }
    programmedBytes += slice.length;
    if (off % 0x1000 === 0) {
      onProgress?.({
        stage: 'program',
        message: `programmed 0x${off.toString(16).padStart(5, '0')} (${programmedBytes}/${image.length})`,
        fraction: programmedBytes / image.length,
      });
    }
    off += slice.length;
  }
  onProgress?.({ stage: 'program', message: 'programming complete', fraction: 1 });

  let verified = false;
  if (!opts.skipVerify) {
    onProgress?.({
      stage: 'verify',
      message: 'reading back for byte-by-byte verify',
      fraction: 0,
    });
    const READBACK_CHUNK = 256;
    verified = true;
    let verifiedBytes = 0;
    for (let vOff = 0; vOff < image.length; vOff += READBACK_CHUNK) {
      const len = Math.min(READBACK_CHUNK, image.length - vOff);
      const slice = image.subarray(vOff, vOff + len);
      if (slice.every((b) => b === 0xff)) {
        verifiedBytes += len;
        continue;
      }
      const got = await minimon.readBlock(EXT_FLASH_ADDR + vOff, len);
      for (let j = 0; j < len; j++) {
        if (image[vOff + j] === 0xff) continue;
        if (got[j] !== image[vOff + j]) {
          verified = false;
          throw new Error(
            `verify mismatch at 0x${(vOff + j).toString(16).padStart(5, '0')}: ` +
              `wrote 0x${image[vOff + j]!.toString(16).padStart(2, '0')}, ` +
              `read 0x${got[j]!.toString(16).padStart(2, '0')}`,
          );
        }
      }
      verifiedBytes += len;
      onProgress?.({
        stage: 'verify',
        message: `verified ${verifiedBytes}/${image.length}`,
        fraction: verifiedBytes / image.length,
      });
    }
  }

  onProgress?.({ stage: 'done', message: 'write complete', fraction: 1 });
  return { verified };
}

/**
 * Quick connectivity probe — runs the handshake, then returns.
 * Caller retains transport ownership.
 */
export async function probeBootmode(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<{ ready: boolean }> {
  await prepareSession(cfg, onProgress);
  // MiniMon's official driver protocol doesn't expose chip-ID
  // autoselect; FC_GETSTATE returns sector status flags. So
  // "probe" just runs the handshake + testComm and returns
  // success — actual chip identification has to come from a
  // successful read or a manual write/verify pass.
  return { ready: true };
}

// ── Alternative (JMG) bootmode path ─────────────────────────────────
// Uses a monolithic 898-byte blob with built-in flash driver. Single-byte
// command protocol. Full chip erase (not per-sector). Page-based program
// and read (16 KB pages, 32 pages = 512 KB).

async function prepareSessionJmg(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<{ jmg: JmgClient }> {
  if (!cfg.skipIntegrityCheck) {
    onProgress?.({ stage: 'integrity', message: 'verifying bundled blobs' });
    await assertBundleIntegrity(cfg.bundle);
  }

  const primary = flattenIntelHex(
    parseIntelHex(new TextDecoder().decode(await cfg.bundle.getBlob('JMG_LOADK.hex'))),
  );
  const secondary = flattenIntelHex(
    parseIntelHex(new TextDecoder().decode(await cfg.bundle.getBlob('JMG_BLOB.hex'))),
  );

  await performHandshake(cfg.transport, {
    expectedIdByte: cfg.expectedBslId ?? C167CR_BSL_ID,
    primaryLoader: primary,
    secondaryLoader: secondary,
    primaryAck: JMG_ACK,
    secondaryAck: JMG_ACK,
    interByteDelayMs: cfg.loaderInterByteDelayMs,
    onProgress: (stage, byte, total) => {
      onProgress?.({
        stage: stage === 'primary' ? 'handshake-primary' : 'handshake-secondary',
        message: `loader byte ${byte}/${total}`,
        fraction: byte / total,
      });
    },
  });

  const jmg = new JmgClient(cfg.transport);
  await jmg.einit();

  return { jmg };
}

/**
 * Read 512 KB flash via the alternative blob (page-by-page, 32 × 16 KB).
 */
export async function readFullFlashJmg(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<Uint8Array> {
  const { jmg } = await prepareSessionJmg(cfg, onProgress);
  const out = new Uint8Array(AM29F400B_TOTAL_BYTES).fill(0xff);
  onProgress?.({ stage: 'read', message: 'reading 512 KB flash (alt)', fraction: 0 });
  for (let page = 0; page < JMG_TOTAL_PAGES; page++) {
    const pageData = await jmg.readPage(page);
    out.set(pageData, page * JMG_PAGE_SIZE);
    onProgress?.({
      stage: 'read',
      message: `read page ${page}/${JMG_TOTAL_PAGES}`,
      fraction: (page + 1) / JMG_TOTAL_PAGES,
    });
  }
  onProgress?.({ stage: 'done', message: 'read complete', fraction: 1 });
  return out;
}

/**
 * Write a 512 KB image via the alternative blob.
 * Flow: handshake → EINIT → ERASE (full chip) → PROGRAM per page → optional verify.
 */
export async function writeFullFlashJmg(
  image: Uint8Array,
  cfg: BootmodeSessionConfig,
  opts: WriteFlashOptions = {},
  onProgress?: BootmodeProgressFn,
): Promise<{ verified: boolean }> {
  if (image.length !== AM29F400B_TOTAL_BYTES) {
    throw new Error(
      `writeFullFlashJmg expects exactly ${AM29F400B_TOTAL_BYTES} bytes (got ${image.length})`,
    );
  }
  const { jmg } = await prepareSessionJmg(cfg, onProgress);
  onProgress?.({ stage: 'erase', message: 'erasing full chip (alt)', fraction: 0 });
  await jmg.erase();
  onProgress?.({ stage: 'erase', message: 'erase complete', fraction: 1 });

  onProgress?.({ stage: 'program', message: 'programming flash (alt)', fraction: 0 });
  for (let page = 0; page < JMG_TOTAL_PAGES; page++) {
    const pageData = image.subarray(page * JMG_PAGE_SIZE, (page + 1) * JMG_PAGE_SIZE);
    if (pageData.every((b) => b === 0xff)) {
      onProgress?.({
        stage: 'program',
        message: `skipping blank page ${page}`,
        fraction: (page + 1) / JMG_TOTAL_PAGES,
      });
      continue;
    }
    await jmg.programPage(page, pageData);
    onProgress?.({
      stage: 'program',
      message: `programmed page ${page}/${JMG_TOTAL_PAGES}`,
      fraction: (page + 1) / JMG_TOTAL_PAGES,
    });
  }
  onProgress?.({ stage: 'program', message: 'programming complete', fraction: 1 });

  let verified = false;
  if (!opts.skipVerify) {
    onProgress?.({ stage: 'verify', message: 'reading back for verify (alt)', fraction: 0 });
    verified = true;
    for (let page = 0; page < JMG_TOTAL_PAGES; page++) {
      const got = await jmg.readPage(page);
      const expected = image.subarray(page * JMG_PAGE_SIZE, (page + 1) * JMG_PAGE_SIZE);
      for (let j = 0; j < JMG_PAGE_SIZE; j++) {
        if (got[j] !== expected[j]) {
          verified = false;
          throw new Error(
            `verify mismatch at 0x${(page * JMG_PAGE_SIZE + j).toString(16).padStart(5, '0')}: ` +
              `wrote 0x${expected[j]!.toString(16).padStart(2, '0')}, ` +
              `read 0x${got[j]!.toString(16).padStart(2, '0')}`,
          );
        }
      }
      onProgress?.({
        stage: 'verify',
        message: `verified page ${page}/${JMG_TOTAL_PAGES}`,
        fraction: (page + 1) / JMG_TOTAL_PAGES,
      });
    }
  }

  onProgress?.({ stage: 'done', message: 'write complete', fraction: 1 });
  return { verified };
}

/** Diagnostic: list what's bundled. */
export async function describeBundle(
  loader: BundleLoader,
): Promise<{ source: string; license: string; blobs: Array<{ name: string; role: string; sha256: string }> }> {
  const m = await loader.getManifest();
  return {
    source: m.source,
    license: m.license,
    blobs: m.blobs.map((b) => ({ name: b.name, role: b.role, sha256: b.sha256 })),
  };
}
