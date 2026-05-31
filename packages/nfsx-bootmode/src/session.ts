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
 *   4. flashDriver.upload() — uploads A29F400B driver into XRAM
 *   5. flashDriver.eraseSector() per sector
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
import {
  FlashDriver,
  AM29F400B_TOTAL_BYTES,
  AM29F400BB_SECTORS,
} from './flash-driver.js';
import {
  JmgClient,
  JMG_ACK,
  JMG_PAGE_SIZE,
  JMG_TOTAL_PAGES,
} from './jmg-client.js';

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
 * Build a tiny C167 stub that executes the AMD sector-erase command
 * sequence. Derived from JMGarage's secondary loader (RE'd).
 *
 * Key insight from JMG RE:
 *   - Writes use segment 0x10 (via EXTS #0x10, #1 + MOV word)
 *   - Reads/polls use segment 0x08 (via EXTS #0x08, #1)
 *   - x16 word addresses: 0xAAAA (cmd1), 0x5554 (cmd2)
 *   - MOV word writes (not MOVB) for command sequences
 *
 * Register interface (callFunction R8-R15):
 *   R9  = sector base offset within segment (e.g. 0x0000 for sector 0)
 *   R10 = flash WRITE segment (0x0010)
 *   R11 = flash READ segment (0x0008)
 *   R15 = return: 0=OK, 1=DQ5 timeout, 2=verify fail
 */
function buildEraseStub(): Buffer {
  const code: number[] = [];
  const emit16 = (lo: number, hi: number) => { code.push(lo, hi); };
  const emit32 = (b0: number, b1: number, b2: number, b3: number) => { code.push(b0, b1, b2, b3); };

  // Setup constants (x16 mode: word addresses per JMG)
  // R0 = 0xAAAA (AMD cmd addr 1 = 0x5555 * 2)
  emit32(0xe6, 0xf0, 0xaa, 0xaa);                    // offset 0
  // R1 = 0x5554 (AMD cmd addr 2 = 0x2AAA * 2)
  emit32(0xe6, 0xf1, 0x54, 0x55);                    // offset 4
  // R2 = 0x00AA (data for unlock cycle 1)
  emit32(0xe6, 0xf2, 0xaa, 0x00);                    // offset 8
  // R3 = 0x0055 (data for unlock cycle 2)
  emit32(0xe6, 0xf3, 0x55, 0x00);                    // offset 12
  // R15 = 0 (return status = OK)
  emit32(0xe6, 0xff, 0x00, 0x00);                    // offset 16

  // --- 6-cycle AMD erase command sequence (MOV word writes to seg 0x10) ---
  // Cycle 1: write 0x00AA to writeSeg:0xAAAA
  emit16(0xdc, 0x0a);                                 // EXTS R10, #1  (offset 20)
  emit16(0xb8, 0x20);                                 // MOV [R0], R2  (offset 22)

  // Cycle 2: write 0x0055 to writeSeg:0x5554
  emit16(0xdc, 0x0a);                                 // EXTS R10, #1  (offset 24)
  emit16(0xb8, 0x31);                                 // MOV [R1], R3  (offset 26)

  // Cycle 3: write 0x0080 to writeSeg:0xAAAA
  emit32(0xe6, 0xf4, 0x80, 0x00);                    // MOV R4, #0x0080 (offset 28)
  emit16(0xdc, 0x0a);                                 // EXTS R10, #1  (offset 32)
  emit16(0xb8, 0x40);                                 // MOV [R0], R4  (offset 34)

  // Cycle 4: write 0x00AA to writeSeg:0xAAAA
  emit16(0xdc, 0x0a);                                 // EXTS R10, #1  (offset 36)
  emit16(0xb8, 0x20);                                 // MOV [R0], R2  (offset 38)

  // Cycle 5: write 0x0055 to writeSeg:0x5554
  emit16(0xdc, 0x0a);                                 // EXTS R10, #1  (offset 40)
  emit16(0xb8, 0x31);                                 // MOV [R1], R3  (offset 42)

  // Cycle 6: write 0x0030 to writeSeg:sector_base (R9 = sector offset)
  emit32(0xe6, 0xf4, 0x30, 0x00);                    // MOV R4, #0x0030 (offset 44)
  emit16(0xdc, 0x0a);                                 // EXTS R10, #1  (offset 48)
  emit16(0xb8, 0x49);                                 // MOV [R9], R4  (offset 50)

  // --- Poll DQ7 (read from READ segment 0x08) ---
  const pollOffset = code.length;                     // offset 52
  // EXTS R11, #1 (read segment)
  emit16(0xdc, 0x0b);                                 // offset 52
  // MOV R4, [R9]        ; read status from sector base
  emit16(0xa8, 0x49);                                 // offset 54
  // MOV R5, R4
  emit16(0xf0, 0x54);                                 // offset 56
  // AND R5, #0x0080     ; isolate DQ7
  emit32(0x66, 0xf5, 0x80, 0x00);                    // offset 58
  // JMPR cc_NZ, erase_done  ; DQ7=1 → erase complete
  emit16(0x3d, 0x00); // placeholder                  // offset 62

  // Check DQ5 (device timeout)
  // MOV R5, R4
  emit16(0xf0, 0x54);                                 // offset 64
  // AND R5, #0x0020
  emit32(0x66, 0xf5, 0x20, 0x00);                    // offset 66
  // JMPR cc_Z, poll      ; DQ5 not set → keep polling
  emit16(0x2d, 0x00); // placeholder                  // offset 70

  // DQ5 set — re-read once more (from read segment)
  // EXTS R11, #1
  emit16(0xdc, 0x0b);                                 // offset 72
  // MOV R4, [R9]
  emit16(0xa8, 0x49);                                 // offset 74
  // AND R4, #0x0080
  emit32(0x66, 0xf4, 0x80, 0x00);                    // offset 76
  // JMPR cc_NZ, erase_done ; actually OK
  emit16(0x3d, 0x00); // placeholder                  // offset 80

  // Genuine DQ5 timeout failure
  // MOV R15, #0x0001
  emit32(0xe6, 0xff, 0x01, 0x00);                    // offset 82
  // Reset chip: write 0x00F0 to writeSeg:0x0000
  emit32(0xe6, 0xf4, 0xf0, 0x00);                    // offset 86 MOV R4, #0x00F0
  emit32(0xe6, 0xf5, 0x00, 0x00);                    // offset 90 MOV R5, #0x0000
  emit16(0xdc, 0x0a);                                 // offset 94 EXTS R10, #1
  emit16(0xb8, 0x45);                                 // offset 96 MOV [R5], R4
  // RET
  emit16(0xcb, 0x00);                                 // offset 98

  const eraseDoneOffset = code.length;                // offset 100

  // --- erase_done: verify by reading back (should be 0xFFFF) ---
  // EXTS R11, #1 (read segment)
  emit16(0xdc, 0x0b);                                 // offset 100
  // MOV R4, [R9]
  emit16(0xa8, 0x49);                                 // offset 102
  // CMP R4, #0xFFFF
  emit32(0x46, 0xf4, 0xff, 0xff);                    // offset 104
  // JMPR cc_Z, success   ; erased correctly
  emit16(0x2d, 0x00); // placeholder                  // offset 108

  // Verify failed — store read value in R8 for diagnostics
  // MOV R8, R4
  emit16(0xf0, 0x84);                                 // offset 110
  // MOV R15, #0x0002
  emit32(0xe6, 0xff, 0x02, 0x00);                    // offset 112
  // RET
  emit16(0xcb, 0x00);                                 // offset 116

  const successOffset = code.length;                  // offset 118
  // RET (R15 already 0)
  emit16(0xcb, 0x00);                                 // offset 118

  // --- Fix up relative jumps ---
  // offset 62: JMPR cc_NZ → erase_done (100)
  // rel = (100 - 64) / 2 = 18
  code[62 + 1] = 18;

  // offset 70: JMPR cc_Z → poll (52)
  // rel = (52 - 72) / 2 = -10 → 0xF6
  code[70 + 1] = 0xf6;

  // offset 80: JMPR cc_NZ → erase_done (100)
  // rel = (100 - 82) / 2 = 9
  code[80 + 1] = 9;

  // offset 108: JMPR cc_Z → success (118)
  // rel = (118 - 110) / 2 = 4
  code[108 + 1] = 4;

  return Buffer.from(code);
}

/** Address where we upload the erase stub in XRAM. */
const ERASE_STUB_ADDR = 0x00e200;

/**
 * Build a stub that issues the AMD autoselect command and reads
 * manufacturer + device IDs. Used as a diagnostic to confirm writes
 * actually reach the flash chip.
 *
 * Uses JMG-derived addressing:
 *   - Writes to segment 0x10 (R10) with MOV word, x16 addresses (0xAAAA/0x5554)
 *   - Reads from segment 0x08 (R11) 
 *
 * Input: R10 = flash WRITE segment (0x0010), R11 = flash READ segment (0x0008)
 * Output: R8 = manufacturer ID, R9 = device ID
 */
function buildAutoSelectProbeStub(): Buffer {
  const code: number[] = [];
  const emit16 = (lo: number, hi: number) => { code.push(lo, hi); };
  const emit32 = (b0: number, b1: number, b2: number, b3: number) => { code.push(b0, b1, b2, b3); };

  // R0 = 0xAAAA (AMD cmd addr 1, x16: 0x5555 * 2)
  emit32(0xe6, 0xf0, 0xaa, 0xaa);
  // R1 = 0x5554 (AMD cmd addr 2, x16: 0x2AAA * 2)
  emit32(0xe6, 0xf1, 0x54, 0x55);
  // R2 = 0x00AA (unlock data 1)
  emit32(0xe6, 0xf2, 0xaa, 0x00);
  // R3 = 0x0055 (unlock data 2)
  emit32(0xe6, 0xf3, 0x55, 0x00);

  // Cycle 1: write 0xAA to writeSeg:0xAAAA (MOV word)
  emit16(0xdc, 0x0a); // EXTS R10, #1
  emit16(0xb8, 0x20); // MOV [R0], R2

  // Cycle 2: write 0x55 to writeSeg:0x5554 (MOV word)
  emit16(0xdc, 0x0a); // EXTS R10, #1
  emit16(0xb8, 0x31); // MOV [R1], R3

  // Cycle 3: write 0x90 to writeSeg:0xAAAA (autoselect command)
  emit32(0xe6, 0xf4, 0x90, 0x00); // MOV R4, #0x0090
  emit16(0xdc, 0x0a); // EXTS R10, #1
  emit16(0xb8, 0x40); // MOV [R0], R4

  // Read manufacturer ID from readSeg:0x0000 (word read)
  emit32(0xe6, 0xf5, 0x00, 0x00); // MOV R5, #0x0000
  emit16(0xdc, 0x0b); // EXTS R11, #1 (read segment)
  emit16(0xa8, 0x85); // MOV R8, [R5] — full 16-bit manufacturer ID

  // Read device ID from readSeg:0x0002 (word addr 1 in x16 = byte offset 2)
  emit32(0xe6, 0xf5, 0x02, 0x00); // MOV R5, #0x0002
  emit16(0xdc, 0x0b); // EXTS R11, #1
  emit16(0xa8, 0x95); // MOV R9, [R5] — full 16-bit device ID

  // Reset to read mode: write 0xF0 to writeSeg:0xAAAA
  emit32(0xe6, 0xf4, 0xf0, 0x00); // MOV R4, #0x00F0
  emit16(0xdc, 0x0a); // EXTS R10, #1
  emit16(0xb8, 0x40); // MOV [R0], R4

  // RET
  emit16(0xcb, 0x00);

  return Buffer.from(code);
}

/**
 * Custom C167 programmer stub — uploaded to MCU RAM and invoked via
 * callFunction. Programs a block of words from a RAM buffer into flash
 * using the AMD word-program algorithm at full MCU speed.
 *
 * JMG-derived addressing:
 *   - AMD command writes go to segment 0x10 (FLASH_WRITE_SEG) via R0
 *   - Data writes go to segment 0x10 via EXTS R0 (flash ignores high addr bits)
 *   - DQ7 polls read from segment 0x08 (FLASH_READ_SEG) via R14
 *   - x16 word addresses: 0xAAAA (cmd1), 0x5554 (cmd2)
 *
 * Register interface (MiniMon callFunction convention, R8-R15):
 *   R8  = unused
 *   R9  = byte count (must be even)
 *   R10 = source address LOW (RAM buffer)
 *   R11 = source address HIGH (segment, typically 0x0000 for XRAM)
 *   R12 = flash WRITE segment (0x0010) — used for AMD commands + data writes
 *   R13 = destination offset within flash
 *   R14 = flash READ segment (0x0008) — used for DQ7 polling
 *   R15 = return status (0=OK, 1=DQ5 timeout error)
 */
function buildProgrammerStub(): { code: Buffer; entryOffset: number } {
  const code: number[] = [];
  const emit16 = (lo: number, hi: number) => { code.push(lo, hi); };
  const emit32 = (b0: number, b1: number, b2: number, b3: number) => { code.push(b0, b1, b2, b3); };

  // --- Setup ---
  // R0 = 0xAAAA (AMD cmd addr 1, x16: 0x5555 * 2)
  emit32(0xe6, 0xf0, 0xaa, 0xaa);                    // offset 0
  // R1 = 0x5554 (AMD cmd addr 2, x16: 0x2AAA * 2)
  emit32(0xe6, 0xf1, 0x54, 0x55);                    // offset 4
  // R2 = flash WRITE segment (copy from R12 for EXTS use)
  emit16(0xf0, 0x2c);                                 // offset 8: MOV R2, R12
  // R15 = 0 (assume success)
  emit32(0xe6, 0xff, 0x00, 0x00);                    // offset 10
  // CMP R9, #0
  emit32(0x46, 0xf9, 0x00, 0x00);                    // offset 14
  // JMPR cc_Z, done
  emit16(0x2d, 0x00); // placeholder                  // offset 18

  const loopOffset = code.length;                     // offset 20

  // --- Read source word ---
  // EXTS R11, #1
  emit16(0xdc, 0x0b);                                 // offset 20
  // MOV R4, [R10]
  emit16(0xa8, 0x4a);                                 // offset 22

  // --- AMD unlock cycle 1: write 0x00AA → writeSeg:0xAAAA ---
  emit32(0xe6, 0xf5, 0xaa, 0x00);                    // offset 24: MOV R5, #0x00AA
  emit16(0xdc, 0x02);                                 // offset 28: EXTS R2, #1
  emit16(0xb8, 0x50);                                 // offset 30: MOV [R0], R5

  // --- AMD unlock cycle 2: write 0x0055 → writeSeg:0x5554 ---
  emit32(0xe6, 0xf5, 0x55, 0x00);                    // offset 32: MOV R5, #0x0055
  emit16(0xdc, 0x02);                                 // offset 36: EXTS R2, #1
  emit16(0xb8, 0x51);                                 // offset 38: MOV [R1], R5

  // --- AMD program command: write 0x00A0 → writeSeg:0xAAAA ---
  emit32(0xe6, 0xf5, 0xa0, 0x00);                    // offset 40: MOV R5, #0x00A0
  emit16(0xdc, 0x02);                                 // offset 44: EXTS R2, #1
  emit16(0xb8, 0x50);                                 // offset 46: MOV [R0], R5

  // --- Write data word to flash destination (writeSeg:R13) ---
  emit16(0xdc, 0x02);                                 // offset 48: EXTS R2, #1
  emit16(0xb8, 0x4d);                                 // offset 50: MOV [R13], R4

  const pollOffset = code.length;                     // offset 52

  // --- Poll DQ7 (read from READ segment R14) ---
  emit16(0xdc, 0x0e);                                 // offset 52: EXTS R14, #1
  emit16(0xa8, 0x5d);                                 // offset 54: MOV R5, [R13]
  // XOR R6=R5^R4, test bit 7
  emit16(0xf0, 0x65);                                 // offset 56: MOV R6, R5
  emit16(0x50, 0x64);                                 // offset 58: XOR R6, R4
  emit32(0x66, 0xf6, 0x80, 0x00);                    // offset 60: AND R6, #0x0080
  // JMPR cc_Z, prog_ok
  emit16(0x2d, 0x00); // placeholder                  // offset 64

  // Check DQ5 (timeout indicator)
  emit16(0xf0, 0x65);                                 // offset 66: MOV R6, R5
  emit32(0x66, 0xf6, 0x20, 0x00);                    // offset 68: AND R6, #0x0020
  // JMPR cc_Z, poll
  emit16(0x2d, 0x00); // placeholder                  // offset 72

  // DQ5 set — re-read and check DQ7 one more time
  emit16(0xdc, 0x0e);                                 // offset 74: EXTS R14, #1
  emit16(0xa8, 0x5d);                                 // offset 76: MOV R5, [R13]
  emit16(0xf0, 0x65);                                 // offset 78: MOV R6, R5
  emit16(0x50, 0x64);                                 // offset 80: XOR R6, R4
  emit32(0x66, 0xf6, 0x80, 0x00);                    // offset 82: AND R6, #0x0080
  // JMPR cc_Z, prog_ok
  emit16(0x2d, 0x00); // placeholder                  // offset 86

  // --- Genuine failure ---
  emit32(0xe6, 0xff, 0x01, 0x00);                    // offset 88: MOV R15, #1
  // Reset chip: write 0x00F0 to writeSeg:0xAAAA
  emit32(0xe6, 0xf5, 0xf0, 0x00);                    // offset 92: MOV R5, #0x00F0
  emit16(0xdc, 0x02);                                 // offset 96: EXTS R2, #1
  emit16(0xb8, 0x50);                                 // offset 98: MOV [R0], R5
  emit16(0xcb, 0x00);                                 // offset 100: RET

  const progOkOffset = code.length;                   // offset 102

  // --- prog_ok: advance pointers ---
  emit32(0x06, 0xfa, 0x02, 0x00);                    // offset 102: ADD R10, #2
  emit32(0x06, 0xfd, 0x02, 0x00);                    // offset 106: ADD R13, #2
  emit32(0x26, 0xf9, 0x02, 0x00);                    // offset 110: SUB R9, #2
  // JMPR cc_NZ, loop
  emit16(0x3d, 0x00); // placeholder                  // offset 114

  const doneOffset = code.length;                     // offset 116
  emit16(0xcb, 0x00);                                 // offset 116: RET

  // --- Fix up relative jumps ---
  // offset 18: JMPR cc_Z → done (116)
  // rel = (116 - (18+2)) / 2 = 96/2 = 48
  code[18 + 1] = 48;

  // offset 64: JMPR cc_Z → prog_ok (102)
  // rel = (102 - (64+2)) / 2 = 36/2 = 18
  code[64 + 1] = 18;

  // offset 72: JMPR cc_Z → poll (52)
  // rel = (52 - (72+2)) / 2 = -22/2 = -11 → 0xF5
  code[72 + 1] = 0xf5;

  // offset 86: JMPR cc_Z → prog_ok (102)
  // rel = (102 - (86+2)) / 2 = 14/2 = 7
  code[86 + 1] = 7;

  // offset 114: JMPR cc_NZ → loop (20)
  // rel = (20 - (114+2)) / 2 = -96/2 = -48 → 0xD0
  code[114 + 1] = 0xd0;

  return { code: Buffer.from(code), entryOffset: 0 };
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
  // Match JMG loader's bus setup:
  // SYSCON: external bus enable, segment mapping
  await minimon.writeWord(SYSCON_ADDR, 0xe3ff);
  // ADDRSEL: CS1 for write window (seg 0x10), CS2 for read window (seg 0x08)
  await minimon.writeWord(ADDRSEL1_ADDR, 0x1008);
  await minimon.writeWord(ADDRSEL2_ADDR, 0x08e1);
  await minimon.writeWord(ADDRSEL3_ADDR, 0x00a0);
  await minimon.writeWord(ADDRSEL4_ADDR, 0xfff0);
  // BUSCON0: base config (mask=0xD6/0xBF applied in JMG, approximated here)
  await minimon.writeWord(BUSCON0_ADDR, 0x44ff);
  // BUSCON1: write-capable config for flash (high=0x84, low=0xFF per JMG bfldh/bfldl)
  await minimon.writeWord(BUSCON1_ADDR, 0x84ff);
  // BUSCON2-4: as per JMG
  await minimon.writeWord(BUSCON2_ADDR, 0x04ff);
  await minimon.writeWord(BUSCON3_ADDR, 0x85ff);
  await minimon.writeWord(BUSCON4_ADDR, 0x00ff);

  // ═══ CRITICAL: Assert write-enable (P3.7 = LOW, DP3.7 = output) ═══
  const dp3 = await minimon.readWord(DP3_ADDR);
  await minimon.writeWord(DP3_ADDR, dp3 | 0x0080);  // DP3.7 = 1 (output)
  const p3 = await minimon.readWord(P3_ADDR);
  await minimon.writeWord(P3_ADDR, p3 & ~0x0080);   // P3.7 = 0 (active-low enable)
  process.stderr.write(
    `[bus] write-enable asserted: P3.7=LOW, DP3.7=output\n` +
    `[bus] ADDRSEL1=0x1008 BUSCON1=0x84FF (write seg 0x10, read seg 0x08)\n`,
  );
}

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

  // Reference Python flasher always probes comms via C_TEST_COMM right
  // after the handshake completes. Mirrors that and surfaces "MiniMon
  // isn't actually responding" failures cleanly before any real work.
  await minimon.testComm();

  return { transport, minimon };
}

async function uploadFlashDriver(
  minimon: MinimonClient,
  onProgress?: BootmodeProgressFn,
): Promise<FlashDriver> {
  // MiniMon-official A29F400B driver. Despite earlier assumptions,
  // the driver is NOT relocatable — it uses absolute intra-segment
  // jumps (JMP cc,caddr). It must be uploaded to its native link
  // address (0xE000) in XRAM, not relocated to IRAM.
  const driver = flattenIntelHex(parseIntelHex(readBundledBlob('A29F400B.hex').toString('utf8')));
  onProgress?.({
    stage: 'driver-upload',
    message: `uploading MiniMon A29F400B driver (${driver.length} bytes) into RAM`,
  });
  const flash = new FlashDriver(minimon, driver);
  await flash.upload();
  return flash;
}

/**
 * Read the full 512 KB flash image. Returns the 0x80000-byte buffer.
 */
export async function readFullFlash(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<Buffer> {
  const { transport, minimon } = await prepareSession(cfg, onProgress);
  try {
    // Configure the C167 bus controller for external-flash access.
    // Reads don't need the AM29F400B flash driver — once the bus is
    // wired up, the flash is just memory at EXT_FLASH_ADDR.
    onProgress?.({ stage: 'driver-upload', message: 'configuring external bus' });
    await configureExtFlashBus(minimon);

    const out = Buffer.alloc(AM29F400B_TOTAL_BYTES, 0xff);
    const CHUNK = 256;
    onProgress?.({ stage: 'read', message: 'reading 512 KB flash', fraction: 0 });
    for (let off = 0; off < AM29F400B_TOTAL_BYTES; off += CHUNK) {
      const len = Math.min(CHUNK, AM29F400B_TOTAL_BYTES - off);
      const chunk = await minimon.readBlock(EXT_FLASH_ADDR + off, len);
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
  const { transport, minimon } = await prepareSession(cfg, onProgress);
  try {
    onProgress?.({ stage: 'driver-upload', message: 'configuring external bus for write' });
    await configureExtFlashBusForWrite(minimon);

    const sectors = AM29F400BB_SECTORS;

    // ─── DIAGNOSTIC: Bus/port pin state ─────────────────────────
    // Check if WR# (P3.12) is configured as output. If DP3 bit12=0,
    // the write strobe isn't being driven to the external bus.
    const dp3 = await minimon.readWord(0x00ffc6); // DP3 (Port 3 Direction)
    const p3  = await minimon.readWord(0x00ffc4); // P3 (Port 3 Data)
    const buscon0 = await minimon.readWord(0x00ff0c); // BUSCON0
    const syscon = await minimon.readWord(0x00ff12);  // SYSCON
    process.stderr.write(
      `[diag] DP3=0x${dp3.toString(16).padStart(4,'0')} P3=0x${p3.toString(16).padStart(4,'0')} ` +
      `BUSCON0=0x${buscon0.toString(16).padStart(4,'0')} SYSCON=0x${syscon.toString(16).padStart(4,'0')}\n`,
    );
    if (!(dp3 & 0x1000)) {
      process.stderr.write(`[diag] WR# (P3.12) is INPUT — enabling as OUTPUT for flash writes\n`);
      await minimon.writeWord(0x00ffc6, dp3 | 0x1000); // set DP3.12 = output
      const dp3After = await minimon.readWord(0x00ffc6);
      process.stderr.write(`[diag] DP3 now=0x${dp3After.toString(16).padStart(4,'0')}\n`);
    } else {
      process.stderr.write(`[diag] WR# (P3.12) already OUTPUT ✓\n`);
    }

    // ─── DIAGNOSTIC: Verify external bus writes work ─────────────
    // Minimal stub: write a test word to RAM (seg 0), read it back;
    // then write to flash address and read back. This isolates whether
    // EXTS+MOV generates bus writes at all.
    {
      const testStub: number[] = [];
      const e16 = (lo: number, hi: number) => { testStub.push(lo, hi); };
      const e32 = (b0: number, b1: number, b2: number, b3: number) => { testStub.push(b0, b1, b2, b3); };

      // Test 1: Write 0xBEEF to RAM address 0x00FD00 (seg 0) via stub
      // MOV R0, #0xFD00
      e32(0xe6, 0xf0, 0x00, 0xfd);
      // MOV R1, #0xBEEF
      e32(0xe6, 0xf1, 0xef, 0xbe);
      // MOV [R0], R1          ; write to seg0:0xFD00 (internal RAM)
      e16(0xb8, 0x10);
      // MOV R8, [R0]          ; read back
      e16(0xa8, 0x80);

      // Test 2: Write 0xAA to flash address seg80:0x5555 via EXTS + MOVB
      // (this is the first AMD unlock cycle in x8 mode)
      // MOV R2, #0x0080       ; segment
      e32(0xe6, 0xf2, 0x80, 0x00);
      // MOV R3, #0x5555       ; x8 command address
      e32(0xe6, 0xf3, 0x55, 0x55);
      // MOV R4, #0x00AA       ; data (RL4 = 0xAA, byte reg 8)
      e32(0xe6, 0xf4, 0xaa, 0x00);
      // EXTS R2, #1           ; DC 02
      e16(0xdc, 0x02);
      // MOVB [R3], RL4        ; B9 83 (byte reg 8 = RL4, word ptr R3)
      e16(0xb9, 0x83);
      // Read back from same address (MOVB)
      // EXTS R2, #1
      e16(0xdc, 0x02);
      // MOVB RL4, [R3]        ; A9 83
      e16(0xa9, 0x83);
      // MOV R9, R4 + mask
      e32(0xe6, 0xf9, 0x00, 0x00); // MOV R9, #0
      e16(0xf0, 0x94);         // MOV R9, R4
      e32(0x66, 0xf9, 0xff, 0x00); // AND R9, #0x00FF

      // Test 3: Also read what's at seg80:0x0000 (to see if flash entered any mode)
      // MOV R5, #0x0000
      e32(0xe6, 0xf5, 0x00, 0x00);
      // EXTS R2, #1
      e16(0xdc, 0x02);
      // MOV R10, [R5]         ; read flash[0]
      e16(0xa8, 0xa5);

      // RET
      e16(0xcb, 0x00);

      const testBuf = Buffer.from(testStub);
      await minimon.writeBlock(ERASE_STUB_ADDR, testBuf);
      // Clear test location first
      await minimon.writeWord(0x00fd00, 0x0000);
      const testRegs = await minimon.callFunction(
        ERASE_STUB_ADDR,
        [0, 0, 0, 0, 0, 0, 0, 0],
        5000,
      );
      const ramReadback = await minimon.readWord(0x00fd00);
      process.stderr.write(
        `[diag] write-test stub results:\n` +
        `  RAM write 0xBEEF→0xFD00: stub-readback=0x${testRegs[0].toString(16).padStart(4,'0')} ` +
        `minimon-readback=0x${ramReadback.toString(16).padStart(4,'0')} ` +
        `${ramReadback === 0xbeef ? '✓' : '✗'}\n` +
        `  Flash MOVB write 0xAA→seg80:0x5555: readback=0x${testRegs[1].toString(16).padStart(4,'0')}\n` +
        `  Flash[0x0000] after write: 0x${testRegs[2].toString(16).padStart(4,'0')}\n`,
      );
    }

    // Diagnostic: read first 8 bytes of sector 0 before erase
    const preErase = await minimon.readBlock(EXT_FLASH_ADDR, 8);
    process.stderr.write(
      `[diag] pre-erase flash[0..7]: ${[...preErase].map(b => b.toString(16).padStart(2,'0')).join(' ')}\n`,
    );

    // ─── DIAGNOSTIC: AMD Autoselect probe ─────────────────────
    // Confirm writes actually reach the flash by issuing the
    // autoselect command sequence and reading manufacturer/device ID.
    // If this fails, writes aren't reaching the chip at all.
    const probeStub = buildAutoSelectProbeStub();
    await minimon.writeBlock(ERASE_STUB_ADDR, probeStub);
    const probeRegs = await minimon.callFunction(
      ERASE_STUB_ADDR,
      [0, 0, FLASH_WRITE_SEG, FLASH_READ_SEG, 0, 0, 0, 0], // R10=write seg, R11=read seg
      5000,
    );
    // R8=manufacturer ID (expect 0x0001 for AMD), R9=device ID (expect 0x22AB for AM29F400BB)
    process.stderr.write(
      `[diag] autoselect probe: manufacturer=0x${probeRegs[0].toString(16).padStart(4,'0')} ` +
      `device=0x${probeRegs[1].toString(16).padStart(4,'0')}\n`,
    );
    if (probeRegs[0] === 0x0001 && (probeRegs[1] === 0x22ab || probeRegs[1] === 0x22ba)) {
      process.stderr.write(`[diag] flash chip confirmed: AMD AM29F400B ✓\n`);
    } else {
      process.stderr.write(
        `[diag] WARNING: unexpected chip IDs — writes may not be reaching flash\n`,
      );
      // Also try: raw MiniMon writeWord to flash (DPP-based) to compare
      // Write 0x00AA to 0x800AAA, then read back — if flash is in x16 mode
      // this should be ignored (flash doesn't accept random writes), but if
      // the bus is working, at least we know.
      const beforeWrite = await minimon.readWord(EXT_FLASH_ADDR);
      try {
        await minimon.writeWord(EXT_FLASH_ADDR, 0x1234);
      } catch (e) {
        process.stderr.write(`[diag] MiniMon writeWord to flash threw: ${e}\n`);
      }
      const afterWrite = await minimon.readWord(EXT_FLASH_ADDR);
      process.stderr.write(
        `[diag] MiniMon writeWord test: before=0x${beforeWrite.toString(16).padStart(4,'0')} ` +
        `after=0x${afterWrite.toString(16).padStart(4,'0')} ` +
        `${beforeWrite === afterWrite ? '(no change — write didnt reach flash or flash rejected it)' : '(CHANGED — write DID reach flash!)'}\n`,
      );
      throw new Error(
        'autoselect probe failed — flash writes not working. Check diag output above.',
      );
    }

    // ─── ERASE ───────────────────────────────────────────────────
    // Upload erase stub — uses EXTS-based writes (segment override)
    // which bypasses MiniMon's DPP-based writeWord that doesn't work
    // for external flash on MS42 hardware.
    const eraseStub = buildEraseStub();
    await minimon.writeBlock(ERASE_STUB_ADDR, eraseStub);
    process.stderr.write(
      `[diag] erase stub uploaded (${eraseStub.length} bytes) at 0x${ERASE_STUB_ADDR.toString(16)}\n`,
    );

    onProgress?.({ stage: 'erase', message: 'erasing sectors', fraction: 0 });
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      // Sector offset within flash — EXTS sets segment, offset is 16-bit.
      // For sectors beyond 64KB, adjust the segment number.
      const sectorPageOffset = s.start & 0xffff;
      const sectorPageDelta = s.start >>> 16; // 0-7 for 512KB flash
      const writeSeg = FLASH_WRITE_SEG + sectorPageDelta;
      const readSeg = FLASH_READ_SEG + sectorPageDelta;
      process.stderr.write(
        `[diag] erasing sector ${s.index} writeSeg=0x${writeSeg.toString(16)} readSeg=0x${readSeg.toString(16)} off=0x${sectorPageOffset.toString(16)}...\n`,
      );
      const regs = await minimon.callFunction(
        ERASE_STUB_ADDR,
        [
          0,               // R8  (unused)
          sectorPageOffset, // R9  = sector base offset within segment
          writeSeg,        // R10 = flash WRITE segment
          readSeg,         // R11 = flash READ segment
          0,               // R12
          0,               // R13
          0,               // R14
          0,               // R15 = return status
        ],
        30_000,
      );
      if (regs[7] !== 0) {
        throw new Error(
          `erase sector ${s.index} failed: R15=0x${regs[7].toString(16)} ` +
          `(1=DQ5 timeout, 2=verify fail) readback=0x${regs[0].toString(16).padStart(4,'0')}`,
        );
      }
      onProgress?.({
        stage: 'erase',
        message: `erased sector ${s.index} (0x${s.start.toString(16).padStart(5, '0')}, ${s.size} bytes)`,
        fraction: (i + 1) / sectors.length,
      });
    }

    // Verify erase: read first few bytes — should be 0xFF
    const postErase = await minimon.readBlock(EXT_FLASH_ADDR, 8);
    process.stderr.write(
      `[diag] post-erase flash[0..7]: ${[...postErase].map(b => b.toString(16).padStart(2,'0')).join(' ')}\n`,
    );

    // ─── PROGRAM ─────────────────────────────────────────────────
    // Upload a custom programmer stub that does the AMD word-program
    // sequence at MCU speed. Data is staged into a RAM buffer in chunks,
    // then the stub is invoked to program each chunk into flash.
    const stub = buildProgrammerStub();
    onProgress?.({
      stage: 'driver-upload',
      message: `uploading programmer stub (${stub.code.length} bytes)`,
    });
    await minimon.writeBlock(PROGRAMMER_STUB_ADDR, stub.code);

    // Verify stub upload
    const stubVerify = await minimon.readBlock(PROGRAMMER_STUB_ADDR, 8);
    const stubExpect = stub.code.subarray(0, 8);
    process.stderr.write(
      `[diag] stub upload verify: ${stubVerify.every((b, i) => b === stubExpect[i]) ? 'OK' : 'MISMATCH'}\n`,
    );

    const DATA_BUF = 0x00fc80; // MiniMon data exchange buffer
    const BLOCK = 64; // bytes per programming call (must be even)
    let programmedBytes = 0;
    onProgress?.({ stage: 'program', message: 'programming flash', fraction: 0 });
    let off = 0;
    while (off < image.length) {
      // Don't let a chunk cross a 64KB segment boundary
      const segEnd = ((off >>> 16) + 1) << 16; // next segment start
      const end = Math.min(off + BLOCK, image.length, segEnd);
      const slice = image.subarray(off, end);
      // Skip all-0xFF blocks (already erased)
      if (slice.every((b) => b === 0xff)) {
        programmedBytes += slice.length;
        if (off % 0x4000 === 0) {
          onProgress?.({
            stage: 'program',
            message: `skipping 0xFF @ 0x${off.toString(16).padStart(5, '0')}`,
            fraction: programmedBytes / image.length,
          });
        }
        off += slice.length;
        continue;
      }
      // Upload data chunk to RAM buffer
      await minimon.writeBlock(DATA_BUF, Buffer.from(slice));
      // Call programmer stub: programs slice.length bytes from DATA_BUF → flash
      // Flash destination: segment = FLASH_WRITE_SEG + page, offset within page
      const pageDelta = off >>> 16; // 0-7 for 512KB
      const destOff = off & 0xffff;
      const regs = await minimon.callFunction(
        PROGRAMMER_STUB_ADDR + stub.entryOffset,
        [
          0,                 // R8  (unused)
          slice.length,      // R9  = byte count
          DATA_BUF & 0xffff, // R10 = source offset (within seg 0)
          0,                 // R11 = source segment (XRAM = seg 0)
          FLASH_WRITE_SEG + pageDelta, // R12 = flash WRITE segment
          destOff,           // R13 = dest offset within flash segment
          FLASH_READ_SEG + pageDelta,  // R14 = flash READ segment (for DQ7 poll)
          0,                 // R15 = return status
        ],
        30_000,
      );
      if (regs[7] !== 0) {
        throw new Error(
          `programmer stub failed at flash offset 0x${off.toString(16)}: R15=0x${regs[7].toString(16)}`,
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
      for (let off = 0; off < image.length; off += READBACK_CHUNK) {
        const len = Math.min(READBACK_CHUNK, image.length - off);
        const got = await minimon.readBlock(EXT_FLASH_ADDR + off, len);
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
  _onProgress?: BootmodeProgressFn,
): Promise<{ ready: boolean }> {
  const { transport } = await prepareSession(cfg, _onProgress);
  try {
    // MiniMon's official driver protocol doesn't expose chip-ID
    // autoselect; FC_GETSTATE returns sector status flags. So
    // "probe" just runs the handshake + testComm and returns
    // success — actual chip identification has to come from a
    // successful read or a manual write/verify pass.
    return { ready: true };
  } finally {
    await transport.close();
  }
}

// ── Alternative (JMG) bootmode path ─────────────────────────────────
// Uses a monolithic 898-byte blob with built-in flash driver. Single-byte
// command protocol. Full chip erase (not per-sector). Page-based program
// and read (16 KB pages, 32 pages = 512 KB).

async function prepareSessionJmg(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<{ transport: BootmodeTransport; jmg: JmgClient }> {
  if (!cfg.skipIntegrityCheck) {
    onProgress?.({ stage: 'integrity', message: 'verifying bundled blobs' });
    assertBundleIntegrity();
  }

  const primary = flattenIntelHex(parseIntelHex(readBundledBlob('JMG_LOADK.hex').toString('utf8')));
  const secondary = flattenIntelHex(parseIntelHex(readBundledBlob('JMG_BLOB.hex').toString('utf8')));

  const transport = new NodeBootmodeTransport(cfg);
  await transport.open();

  await performHandshake(transport, {
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

  const jmg = new JmgClient(transport);
  await jmg.einit();

  return { transport, jmg };
}

/**
 * Read 512 KB flash via the alternative blob (page-by-page, 32 × 16 KB).
 */
export async function readFullFlashJmg(
  cfg: BootmodeSessionConfig,
  onProgress?: BootmodeProgressFn,
): Promise<Buffer> {
  const { transport, jmg } = await prepareSessionJmg(cfg, onProgress);
  try {
    const out = Buffer.alloc(AM29F400B_TOTAL_BYTES, 0xff);
    onProgress?.({ stage: 'read', message: 'reading 512 KB flash (alt)', fraction: 0 });
    for (let page = 0; page < JMG_TOTAL_PAGES; page++) {
      const pageData = await jmg.readPage(page);
      pageData.copy(out, page * JMG_PAGE_SIZE);
      onProgress?.({
        stage: 'read',
        message: `read page ${page}/${JMG_TOTAL_PAGES}`,
        fraction: (page + 1) / JMG_TOTAL_PAGES,
      });
    }
    onProgress?.({ stage: 'done', message: 'read complete', fraction: 1 });
    return out;
  } finally {
    await transport.close();
  }
}

/**
 * Write a 512 KB image via the alternative blob.
 * Flow: handshake → EINIT → ERASE (full chip) → PROGRAM per page → optional verify.
 */
export async function writeFullFlashJmg(
  image: Buffer,
  cfg: BootmodeSessionConfig,
  opts: WriteFlashOptions = {},
  onProgress?: BootmodeProgressFn,
): Promise<{ verified: boolean }> {
  if (image.length !== AM29F400B_TOTAL_BYTES) {
    throw new Error(
      `writeFullFlashJmg expects exactly ${AM29F400B_TOTAL_BYTES} bytes (got ${image.length})`,
    );
  }
  const { transport, jmg } = await prepareSessionJmg(cfg, onProgress);
  try {
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
                `wrote 0x${expected[j].toString(16).padStart(2, '0')}, ` +
                `read 0x${got[j].toString(16).padStart(2, '0')}`,
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
