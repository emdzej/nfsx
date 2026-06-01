#!/usr/bin/env npx tsx
/**
 * Build custom C167 flash stubs → .bin + .hex files.
 *
 * This script contains the canonical "source" for each stub with full
 * comments explaining the C167 assembly. The emitted .hex files are
 * bundled with the package and loaded at runtime.
 *
 * Usage:
 *   npx tsx packages/nfsx-bootmode/scripts/build-stubs.ts
 *
 * Outputs:
 *   bundled/ERASE_STUB.hex
 *   bundled/PROGRAMMER_STUB.hex
 *   bundled/PROBE_STUB.hex
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = resolve(__dirname, '..', 'bundled');

// ─── Helpers ─────────────────────────────────────────────────────

function toIntelHex(buf: Buffer, baseAddr: number): string {
  const lines: string[] = [];
  // Extended linear address record if needed
  const upperAddr = (baseAddr >>> 16) & 0xffff;
  if (upperAddr !== 0) {
    const rec = [0x02, 0x00, 0x00, 0x04, (upperAddr >> 8) & 0xff, upperAddr & 0xff];
    const cksum = (~rec.reduce((a, b) => a + b, 0) + 1) & 0xff;
    lines.push(':' + rec.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('') + cksum.toString(16).padStart(2, '0').toUpperCase());
  }
  // Data records (16 bytes per line)
  const startOff = baseAddr & 0xffff;
  for (let i = 0; i < buf.length; i += 16) {
    const len = Math.min(16, buf.length - i);
    const addr = (startOff + i) & 0xffff;
    const rec = [len, (addr >> 8) & 0xff, addr & 0xff, 0x00, ...buf.subarray(i, i + len)];
    const cksum = (~rec.reduce((a, b) => a + b, 0) + 1) & 0xff;
    lines.push(':' + rec.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('') + cksum.toString(16).padStart(2, '0').toUpperCase());
  }
  // EOF
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}

// ─── Erase Stub ──────────────────────────────────────────────────
// Erases one sector of AM29F400BB flash using 6-cycle AMD command.
// Polls DQ7/DQ5 for completion, verifies first word = 0xFFFF.
//
// Input registers (set by MiniMon callFunction):
//   R9  = sector base offset (within 64KB page)
//   R10 = flash WRITE segment (e.g. 0x10 + pageDelta)
//   R11 = flash READ segment (e.g. 0x08 + pageDelta)
// Output:
//   R15 = 0 (success), 1 (DQ5 timeout), 2 (verify fail)
//   R8  = readback value (on verify fail)

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
  // RETS (inter-segment return, matches MiniMon's RETS-based call)
  emit16(0xdb, 0x00);                                 // offset 98

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
  // RETS
  emit16(0xdb, 0x00);                                 // offset 116

  const successOffset = code.length;                  // offset 118
  // RETS (R15 already 0)
  emit16(0xdb, 0x00);                                 // offset 118

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

// ─── Programmer Stub ─────────────────────────────────────────────
// Programs a block of words from RAM to AM29F400BB flash.
// Uses fixed delay (~300μs) instead of DQ7 polling — matches JMG approach.
//
// AMD unlock/program commands ALWAYS go to base segment 0x10 (R8, set internally).
// Data writes go to R2 (copied from R12, may be 0x10+pageDelta for higher pages).
//
// Input registers:
//   R9  = byte count to program
//   R10 = source offset in XRAM
//   R11 = source segment (0 for XRAM)
//   R12 = flash WRITE segment for data (0x10 + pageDelta)
//   R13 = destination offset within flash segment
// Output:
//   R15 = 0 (success)

function buildProgrammerStub(): { code: Buffer; entryOffset: number } {
  const code: number[] = [];
  const emit16 = (lo: number, hi: number) => { code.push(lo, hi); };
  const emit32 = (b0: number, b1: number, b2: number, b3: number) => { code.push(b0, b1, b2, b3); };

  // --- Setup ---
  // R0 = 0xAAAA (AMD cmd addr 1, x16: 0x5555 * 2)
  emit32(0xe6, 0xf0, 0xaa, 0xaa);                    // offset 0
  // R1 = 0x5554 (AMD cmd addr 2, x16: 0x2AAA * 2)
  emit32(0xe6, 0xf1, 0x54, 0x55);                    // offset 4
  // R2 = flash DATA write segment (copy from R12 — may be 0x10, 0x11, etc.)
  emit16(0xf0, 0x2c);                                 // offset 8: MOV R2, R12
  // R8 = 0x0010 (CMD segment — always base segment for unlock/program commands)
  emit32(0xe6, 0xf8, 0x10, 0x00);                    // offset 10: MOV R8, #0x0010
  // R15 = 0 (success)
  emit32(0xe6, 0xff, 0x00, 0x00);                    // offset 14
  // CMP R9, #0
  emit32(0x46, 0xf9, 0x00, 0x00);                    // offset 18
  // JMPR cc_Z, done
  emit16(0x2d, 0x00); // placeholder                  // offset 22

  const loopOffset = code.length;                     // offset 24

  // --- Read source word from RAM ---
  // EXTS R11, #1 (source segment = 0 for XRAM)
  emit16(0xdc, 0x0b);                                 // offset 24
  // MOV R4, [R10]
  emit16(0xa8, 0x4a);                                 // offset 26

  // --- AMD unlock cycle 1: write 0x00AA → cmdSeg(R8):0xAAAA ---
  emit32(0xe6, 0xf5, 0xaa, 0x00);                    // offset 28: MOV R5, #0x00AA
  emit16(0xdc, 0x08);                                 // offset 32: EXTS R8, #1
  emit16(0xb8, 0x50);                                 // offset 34: MOV [R0], R5

  // --- AMD unlock cycle 2: write 0x0055 → cmdSeg(R8):0x5554 ---
  emit32(0xe6, 0xf5, 0x55, 0x00);                    // offset 36: MOV R5, #0x0055
  emit16(0xdc, 0x08);                                 // offset 40: EXTS R8, #1
  emit16(0xb8, 0x51);                                 // offset 42: MOV [R1], R5

  // --- AMD program command: write 0x00A0 → cmdSeg(R8):0xAAAA ---
  emit32(0xe6, 0xf5, 0xa0, 0x00);                    // offset 44: MOV R5, #0x00A0
  emit16(0xdc, 0x08);                                 // offset 48: EXTS R8, #1
  emit16(0xb8, 0x50);                                 // offset 50: MOV [R0], R5

  // --- Write data word to flash destination (dataSeg R2 : R13) ---
  emit16(0xdc, 0x02);                                 // offset 52: EXTS R2, #1
  emit16(0xb8, 0x4d);                                 // offset 54: MOV [R13], R4

  // --- Busy-wait delay ~300μs at 20MHz ---
  // 1500 iterations × (SUB 1 cycle + JMPR 1 cycle) × 100ns = 300μs
  // AM29F400B max word program time = 200μs, so 300μs is safe
  emit32(0xe6, 0xf6, 0xdc, 0x05);                    // offset 56: MOV R6, #1500 (0x05DC)
  // delay_loop: SUB R6, #1
  emit32(0x26, 0xf6, 0x01, 0x00);                    // offset 60: SUB R6, #1
  // JMPR cc_NZ, delay_loop (target=60, from 64: rel=(60-(64+2))/2 = -3 → 0xFD)
  emit16(0x3d, 0xfd);                                 // offset 64: JMPR cc_NZ, → offset 60

  // --- Advance pointers ---
  // ADD R10, #2 (next source word)
  emit32(0x06, 0xfa, 0x02, 0x00);                    // offset 66: ADD R10, #2
  // ADD R13, #2 (next dest word)
  emit32(0x06, 0xfd, 0x02, 0x00);                    // offset 70: ADD R13, #2
  // SUB R9, #2 (decrement byte count)
  emit32(0x26, 0xf9, 0x02, 0x00);                    // offset 74: SUB R9, #2
  // JMPR cc_NZ, loop
  emit16(0x3d, 0x00); // placeholder                  // offset 78

  const doneOffset = code.length;                     // offset 80
  emit16(0xdb, 0x00);                                 // offset 80: RETS

  // --- Fix up relative jumps ---
  // offset 22: JMPR cc_Z → done (80)
  // rel = (80 - (22+2)) / 2 = 56/2 = 28
  code[22 + 1] = 28;

  // offset 78: JMPR cc_NZ → loop (24)
  // rel = (24 - (78+2)) / 2 = -56/2 = -28 → 0xE4
  code[78 + 1] = 0xe4;

  return { code: Buffer.from(code), entryOffset: 0 };
}

// ─── Autoselect Probe Stub ───────────────────────────────────────
// Issues AMD autoselect command and reads manufacturer + device IDs.
// Used to confirm writes actually reach the flash chip.
//
// Input:
//   R10 = flash WRITE segment (0x0010)
//   R11 = flash READ segment (0x0008)
// Output:
//   R8 = manufacturer ID (expect 0x0001 for AMD)
//   R9 = device ID (expect 0x22AB for AM29F400BB)

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

  // RETS
  emit16(0xdb, 0x00);

  return Buffer.from(code);
}

// ─── Main ────────────────────────────────────────────────────────

const ERASE_LOAD_ADDR = 0xe200;
const PROGRAMMER_LOAD_ADDR = 0xe300;
const PROBE_LOAD_ADDR = 0xe200; // reuses erase area (not used simultaneously)

const eraseBin = buildEraseStub();
const { code: programmerBin } = buildProgrammerStub();
const probeBin = buildAutoSelectProbeStub();

writeFileSync(resolve(BUNDLED_DIR, 'ERASE_STUB.hex'), toIntelHex(eraseBin, ERASE_LOAD_ADDR));
writeFileSync(resolve(BUNDLED_DIR, 'PROGRAMMER_STUB.hex'), toIntelHex(programmerBin, PROGRAMMER_LOAD_ADDR));
writeFileSync(resolve(BUNDLED_DIR, 'PROBE_STUB.hex'), toIntelHex(probeBin, PROBE_LOAD_ADDR));

// Also emit raw .bin for inspection/disassembly
writeFileSync(resolve(BUNDLED_DIR, 'ERASE_STUB.bin'), eraseBin);
writeFileSync(resolve(BUNDLED_DIR, 'PROGRAMMER_STUB.bin'), programmerBin);
writeFileSync(resolve(BUNDLED_DIR, 'PROBE_STUB.bin'), probeBin);

console.log(`ERASE_STUB:      ${eraseBin.length} bytes → ERASE_STUB.{bin,hex} (load @ 0x${ERASE_LOAD_ADDR.toString(16)})`);
console.log(`PROGRAMMER_STUB: ${programmerBin.length} bytes → PROGRAMMER_STUB.{bin,hex} (load @ 0x${PROGRAMMER_LOAD_ADDR.toString(16)})`);
console.log(`PROBE_STUB:      ${probeBin.length} bytes → PROBE_STUB.{bin,hex} (load @ 0x${PROBE_LOAD_ADDR.toString(16)})`);
