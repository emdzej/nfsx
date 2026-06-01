# Bootmode flashing (Infineon C167 BSL)

Bootmode bypasses DS2 entirely. Instead of driving the ECU's BMW
firmware through a diagnostic session, the host uses the **Infineon
C167 hardware Bootstrap Loader (BSL)** — a mask-ROM routine baked
into the MCU silicon that runs at power-on when a BOOT pin is
grounded. The host uploads a small loader into internal RAM, the
BSL jumps to it, and that loader stages a larger secondary that
exposes flash read / write / erase primitives. There is no BMW
firmware in the path, no DS2 framing, no SEED/KEY, and no region
table — the full 512 KB is addressable.

Applies to MCUs in the Infineon C16x / ST10 family:
- **MS42** (C167CR)
- **MS43** (C167CR)
- **ME 7.2** (Bosch, C167-class)
- Other C16x ECUs of that era — Bosch ME7.x, Simos 3.x,
  EDC15VM/P+ etc.

References:
- Infineon **AP16012** — *C16x Bootstrap Loader* (silicon-level spec)
- Infineon **AP16064** — *MiniMon* (V1.2, Sept 2007)
- [MiniMon project page](http://www.perschl.at/minimon/) (Christian Perschl)
- [MiniMon User Manual](http://www.perschl.at/minimon/minimon_usermanual.pdf) (PDF)
- [MiniMon on SourceForge](https://sourceforge.net/projects/minimon/) (binaries + kernels)
- [EcuProg7/C167BootTool](https://github.com/EcuProg7/C167BootTool) (Python, GPL v3)

See `raw-ds2-flashing.md` for the DS2 protocol context.

---

## When this applies — bench programming only

The ECU must be pulled from the vehicle. C167 BSL entry requires
the BOOT pin at logic 0 at power-on reset; on the BMW ECU PCB that
pin is jumpered or pulled via a dedicated bench harness, not exposed
through the OBD-II connector. Typical bench wiring for MS43:

```
+12 V → [1]-7  and  [4]-26
GND   → [1]-4
K-line→ [4]-32
```

After power-up with the BOOT pin grounded, the C167 is in BSL,
listening on ASC0 for the auto-baud calibration byte. In-vehicle
bootmode is not viable: the power-up sequence isn't controllable,
the BOOT pin isn't exposed, and surrounding bus traffic isn't quiet.

## Wire format — not DS2

| | DS2 | Bootmode |
|---|---|---|
| Framing | `[ADDR][LEN][CMD]...[XOR]` | Direct byte / `[CMD][payload]` (loader-defined) |
| Checksum | XOR over frame | None at BSL/handshake layer |
| Echo | K-line half-duplex | K-line half-duplex |
| Serial | 9600 8E1 | 8N1, host-chosen baud — BSL auto-bauds |
| Auth | SEED/KEY | None — loader runs from RAM |
| Region table | Per-variant sparse | None — full `0x00000–0x7FFFF` |

## BSL entry sequence

This is the same for every C167 bootmode tool — it's defined by
Infineon silicon, not by the secondary loader.

**Step 1 — Power on with BOOT pin grounded.** The C167 mask ROM
samples the BOOT pin at reset and enters BSL instead of jumping to
flash. BSL listens on ASC0. The host's serial port should be open
at one of the standard rates (9600 / 19200 / 28800 / 38400 / 57600
/ 115200) with **8N1, no flow control**.

**Step 2 — Host sends `0x00`.** This is the BSL auto-baud reference:
its bit pattern `0 00000000 1` (start + 8 zero bits + stop) lets
the BSL measure exactly 9 bit-periods and calibrate its UART divider
to whatever rate the host is using.

**Step 3 — ECU responds with the BSL identification byte.** This
encodes the C16x derivative. Observed values: `0xC5` on the C167CR
(MS42/MS43), `0xAA` on C167 variants (ME7 / Simos 3.x). AP16012
lists the full table. Any other value means the BOOT pin isn't
asserted, the wiring is wrong, or the ECU is the wrong family.

**Step 4 — Host uploads a 32-byte primary loader, byte-by-byte with
echo verification.** The C167 BSL hard-codes **exactly 32 bytes**: it
allocates 32 bytes at the top of internal RAM, fills them from ASC0,
then jumps to that buffer. This stage cannot be skipped and the
32-byte cap is silicon — there is no way to upload a larger image in
one step.

**Step 5 — The primary loader stages the secondary loader.** Once
running from RAM, the primary reads further bytes from ASC0 into a
larger RAM region. When complete, it jumps to the secondary's entry
point.

**Step 6 — Secondary signals ready.** The exact "ready" byte is
loader-specific: MiniMon uses `0x01` (primary) / `0x03` (secondary);
the JMG blob uses `0xC5` for both. After this point the ECU is
running the uploaded code, not BMW firmware.

## Why the full 512 KB is writable

The C167 mask-ROM BSL is silicon, not firmware. When the BOOT pin
is grounded at reset the MCU enters BSL unconditionally; the
secondary loader runs from RAM and can drive the C167's flash
controller registers directly.

The DS2 region gating is enforced by **BMW's firmware** — bypass
the firmware and the gating goes with it. This is also why bootmode
**recovers a bricked ECU**: even with flash erased, the BSL still
answers the power-on entry sequence.

## Caveats

- The BSL id byte is per-MCU-derivative, not per-tool. A host must
  know the target or branch on the id byte.
- Baud rate is host-chosen (BSL auto-bauds). Cable limits apply —
  many K-line adapters won't reach 115200 reliably.
- "Bootmode works" depends on having a correct primary + secondary
  pair for the target's RAM map.
- In-vehicle flashing is not possible. The BOOT pin isn't routed
  to OBD-II, power-up timing isn't controllable, and EWS pairing /
  K-line traffic break the BSL sync byte.
- There is no universal post-handshake protocol — the secondary is
  arbitrary code chosen by the tool author.

---

# Path A — MiniMon + flash driver (`nfsx bootmode`)

The default bootmode path. Uses the public MiniMon monitor as the
secondary loader, plus a separate per-chip flash driver uploaded
into RAM.

## Bundled files

| File | Size | Role |
|---|---|---|
| `LOADK.hex` | 32 bytes | Primary loader (K-line variant) |
| `MINIMONK.hex` | ~394 bytes | Secondary — MiniMon K-line kernel |
| `A29F400B.hex` | ~200 bytes | Flash driver for AMD AM29F400B |

## Handshake

- Primary ack: `0x01` (`I_LOADER_STARTED`)
- Secondary ack: `0x03` (`I_APPLICATION_STARTED`)
- Primary end address: `0xFBE9`

## MiniMon command set

Once the secondary is running, MiniMon exposes generic memory
primitives:

| Cmd | Name | Payload |
|---|---|---|
| `0x82` | `C_WRITE_WORD` | addr (LE) + word (LE) |
| `0xCD` | `C_READ_WORD` | addr (LE) → word |
| `0x84` | `C_WRITE_BLOCK` | addr (LE) + len (LE) + data |
| `0x85` | `C_READ_BLOCK` | addr (LE) + len (LE) → block |
| `0x9F` | `C_CALL_FUNCTION` | 8 register words (R0..R7) + function addr |
| `0x33` | `C_GETCHECKSUM` | addr (LE) + len (LE) |

Each command is acked with `A_ACK1 = 0xAA` after the CMD byte and
`A_ACK2 = 0xEA` after the payload.

## Flash operations via driver

MiniMon doesn't know about flash hardware. The host uploads the
AMD flash driver (`A29F400B.hex`) into RAM via `C_WRITE_BLOCK`,
then calls into it with `C_CALL_FUNCTION`, passing a flash
sub-command in a register:

| FC | Action |
|---|---|
| `0x00` | Program flash |
| `0x01` | Erase sector |
| `0x06` | Read manufacturer / device ID |
| `0x11` | Unlock flash bank |

## Status

**Not working.** The MiniMon path fails during sector erase on
MS42 — DQ5 timeout / verify fail after the erase command. Root
cause unknown. Hypotheses: segment addressing (MiniMon uses `0x80`
vs JMG's `0x10` write / `0x08` read), bus config differences, or
write strobe timing.

---

# Path B — JMG blob (`nfsx bootmode --alt`)

The `--alt` path uses a monolithic 898-byte secondary loader
(`JMG_BLOB.hex`, loaded at `0xFA60`) with a built-in AMD AM29F400B
flash driver. No separate driver upload needed. Captured from the
wire during a live bootmode session and incorporated as an
alternative path.

## Bundled files

| File | Size | Role |
|---|---|---|
| `JMG_LOADK.hex` | 32 bytes | Primary loader (ack `0xC5`, end addr `0xFDE1`) |
| `JMG_BLOB.hex` | 898 bytes | Secondary — monolithic with built-in flash driver |

## Handshake

- Primary ack: `0xC5`
- Secondary ack: `0xC5`
- Primary end address: `0xFDE1`

The JMG LOADK differs from MiniMon's by exactly 2 bytes: the ack
byte (`0xC5` vs `0x01`) and the end address (`0xFDE1` vs `0xFBE9`).

## Command set

Single-byte commands — no framing, no checksums, no multi-byte
headers. `0xC5` is the universal ack / ready byte.

| Cmd | Name | Protocol |
|---|---|---|
| `0x10` | EINIT | → ack `0xC5` |
| `0x99` | SRST | (no response — MCU resets) |
| `0xA7` | READ | host sends page byte (`0x00`–`0x1F`) → blob returns 16384 bytes |
| `0xA8` | SPI_READ | MS43 EEPROM — not used on MS42 |
| `0xA9` | SPI_WRITE | MS43 EEPROM — not used on MS42 |
| `0xB0` | PROGRAM | host sends page byte + 16384 data bytes; blob acks `0xC5` every 128 bytes |
| `0xB4` | ERASE | full-chip erase → ack `0xC5` when complete |

**Critical protocol detail:** Parameterized commands (READ, PROGRAM)
do **not** ack the command byte — the blob immediately waits for
the page parameter. Parameterless commands (EINIT, ERASE) ack with
`0xC5` after execution.

## Flash addressing

- Writes go to segment `0x10` (CPU address `0x100000`)
- Reads / DQ7 polling from segment `0x08` (CPU address `0x080000`)
- AMD unlock: `0xAA` → `[10:AAAA]`, `0x55` → `[10:5554]` (x16 word addresses)
- On MS42, A19–A23 are not connected — segments `0x08`, `0x10`,
  `0x80` all alias to the same physical flash chip

## Page model

512 KB = 32 pages of 16 KB each (pages `0x00`–`0x1F`). Read and
program are page-granular. Erase is full-chip only. Blank pages
(all `0xFF`) can be skipped during programming.

## PROGRAM flow control

After receiving the page byte, the blob enters a tight loop reading
2 bytes (lo, hi) per word. Every 128 bytes received, it sends a
`0xC5` flow-control ack. The host must wait for each ack before
sending the next burst. 16384 / 128 = **128 acks per page**.

The blob programs flash **one word at a time** — each word goes
through the full AMD single-word program sequence (unlock → `0xA0`
→ write). The 128-byte ack is serial flow control, not a flash
block size.

## Status

**Working.** First successful bootmode write on MS42 bench ECU
(2026-05-31). Full flow: BSL handshake → EINIT → full chip erase →
32×16KB page program → readback verify — byte-identical.

---

# JMG blob disassembly

Annotated C166 assembly (via dacigg) of the 898-byte JMG blob.

## Function map

Ghidra loaded at base `0x0000`; real addresses are `+0xFA60`.

| Ghidra | Real | Name | Purpose |
|---|---|---|---|
| `0x0000` | `0xFA60` | `RESET_VECTOR` | Init + command dispatch loop |
| `0x00AE` | `0xFB0E` | `serial_tx_byte` | TX rh0 → S0TBUF, wait complete |
| `0x00BC` | `0xFB1C` | `serial_tx_word` | TX r0 as 16-bit word |
| `0x00D6` | `0xFB36` | `serial_rx_with_delay` | RX byte + 0xFFF delay loop |
| `0x00EA` | `0xFB4A` | `cmd_dispatch` | Re-entry into command loop |
| `0x0124` | `0xFB84` | `serial_tx_hi` | TX high byte of r0 |
| `0x0144` | `0xFBA4` | `cmd_return` | Jump to top of dispatch loop |
| `0x0146` | `0xFBA6` | `serial_rx_byte` | RX byte from S0RBUF |
| `0x0152` | `0xFBB2` | `amd_unlock` | AMD unlock: `0xAA`→`[10:AAAA]`, `0x55`→`[10:5554]` |
| `0x01D0` | `0xFC30` | ERASE handler | Full-chip erase via AMD sequence |
| `0x0206` | `0xFC66` | SPI_WRITE | MS43 EEPROM write via SSC |
| `0x02FC` | `0xFD5C` | SPI_READ | MS43 EEPROM read via SSC |

## Primary loader (`JMG_LOADK.hex`, 32 bytes at `0xFA40`)

```asm
0xFA40  E658C500    MOV      S0TBUF, #0x00C5     ; send ack 0xC5 to host
0xFA44  9AB7FE70    JNB      S0RIC.7, 0xFA44      ; wait TX complete
0xFA48  E6F060FA    MOV      r0, #0xFA60          ; destination pointer

0xFA4C  7EB7        BCLR     S0RIC.7              ; clear RX flag
0xFA4E  9AB7FE70    JNB      S0RIC.7, 0xFA4E      ; wait for next byte
0xFA52  A400B2FE    MOVB     [r0], 0xFEB2         ; store S0RBUF at [r0]
0xFA56  86F0E1FD    CMPI1    r0, #0xFDE1          ; reached end?
0xFA5A  3DF8        JMPR     CC_NZ_NE, 0xFA4C     ; loop

0xFA5C  EA0060FA    JMPA     CC_UC, 0xFA60        ; jump to blob
```

## Blob initialisation (`0xFA60`–`0xFAEE`)

Sets up C167 peripherals: watchdog disable, UART baud, bus
controller (BUSCON0–4, ADDRSEL1–4, SYSCON), port pins, SSC.
Then sends `0xC5` "ready" and enters the command loop.

### Assembly

```asm
0xFA60  A55AA5A5    DISWDT                         ; disable watchdog
0xFA64  7EB7        BCLR     S0RIC.7
0xFA66  7EB6        BCLR     S0TIC.7

0xFA68  D180        EXTR     #1
0xFA6A  E65A1700    MOV      S0BG, #0x0017         ; baud generator

0xFA6E  FED9        BCLR     SSCCON.15             ; SSC disable
0xFA70  E6D97FC0    MOV      SSCCON, #0xC07F       ; SSC master config

0xFA74  1AE22323    BFLDH    P3, #0b00100011, #0x23
0xFA78  1AE32223    BFLDH    DP3, #0b00100011, #0x22
0xFA7C  E6020300    MOV      DPP2, #0x0003

; external bus controller
0xFA80  E6F612BF    MOV      r6, #0xBF12
0xFA84  E6F31406    MOV      r3, #0x0614
0xFA88  B836        MOV      [r6], r3
0xFA8A  E6F60CBF    MOV      r6, #0xBF0C
0xFA8E  E6F3BF04    MOV      r3, #0x04BF
0xFA92  B836        MOV      [r6], r3
0xFA94  E6F618BE    MOV      r6, #0xBE18
0xFA98  E6F30438    MOV      r3, #0x3804
0xFA9C  B836        MOV      [r6], r3
0xFA9E  E6F614BF    MOV      r6, #0xBF14
0xFAA2  E6F33F04    MOV      r3, #0x043F
0xFAA6  B836        MOV      [r6], r3

; SYSCON
0xFAA8  1A89E3FF    BFLDH    SYSCON, #0xFF, #0xE3
0xFAAC  0A89FF0E    BFLDL    SYSCON, #0xFF, #0x0E

; address select (memory map windows)
0xFAB0  E60C0810    MOV      ADDRSEL1, #0x1008     ; seg 0x10 (flash write)
0xFAB4  E60DE108    MOV      ADDRSEL2, #0x08E1     ; seg 0x08 (flash read/poll)
0xFAB8  E60EA000    MOV      ADDRSEL3, #0x00A0
0xFABC  E60FF0FF    MOV      ADDRSEL4, #0xFFF0

; BUSCON0–4 timing
0xFAC0  1A8644D6    BFLDH    BUSCON0, #0xD6, #0x44
0xFAC4  0A86FFBF    BFLDL    BUSCON0, #0xFF, #0xBF
0xFAC8  1A8A84D6    BFLDH    BUSCON1, #0xD6, #0x84
0xFACC  0A8AFF8E    BFLDL    BUSCON1, #0xFF, #0x8E
0xFAD0  1A8B04D6    BFLDH    BUSCON2, #0xD6, #0x04
0xFAD4  0A8BFF2F    BFLDL    BUSCON2, #0xFF, #0x2F
0xFAD8  1A8C85DF    BFLDH    BUSCON3, #0xDF, #0x85
0xFADC  0A8CFFAF    BFLDL    BUSCON3, #0xFF, #0xAF
0xFAE0  1A8D00D6    BFLDH    BUSCON4, #0xD6, #0x00
0xFAE4  0A8DFF3F    BFLDL    BUSCON4, #0xFF, #0x3F

; SPI chip-select
0xFAE8  7EE2        BCLR     P3.7
0xFAEA  7FE3        BSET     DP3.7
0xFAEC  6EBB        BCLR     SSCEIC.6

; signal ready
0xFAEE  E7F1C500    MOVB     rh0, #0xC5
0xFAF2  BB0D        CALLR    serial_tx_byte         ; send 0xC5
```

## Command dispatch (`0xFAF4`–`0xFB34`)

### Assembly

```asm
0xFAF4  7EB7        BCLR     S0RIC.7
0xFAF6  7EB6        BCLR     S0TIC.7
0xFAF8  9AB7FE70    JNB      S0RIC.7, 0xFAF8       ; spin until byte arrives
0xFAFC  7EB7        BCLR     S0RIC.7
0xFAFE  F3F0B2FE    MOVB     rl0, 0xFEB2           ; rl0 = S0RBUF

; 0x10 = EINIT
0xFB02  47F01000    CMPB     rl0, #0x10
0xFB06  3D11        JMPR     CC_NZ_NE, check_srst
0xFB08  B54AB5B5    EINIT
0xFB0C  0DF0        JMPR     CC_UC, 0xFAEE         ; ack 0xC5, loop

; 0x99 = SRST
0xFB2A  47F09900    CMPB     rl0, #0x99
0xFB2E  3D0E        JMPR     CC_NZ_NE, check_read
0xFB30  B748B7B7    SRST
0xFB34  0DDC        JMPR     CC_UC, 0xFAEE         ; unreachable

; 0xA7 = READ
0xFB4C  47F0A700    CMPB     rl0, #0xA7
0xFB50  3D3F        JMPR     CC_NZ_NE, check_program

; 0xB0 = PROGRAM
0xFBD0  47F0B000    CMPB     rl0, #0xB0
0xFBD4  3D2D        JMPR     CC_NZ_NE, check_erase

; 0xB4 = ERASE
0xFC30  47F0B400    CMPB     rl0, #0xB4
0xFC34  3D18        JMPR     CC_NZ_NE, check_spi_write

; 0xA9 = SPI_WRITE
0xFC66  47F0A900    CMPB     rl0, #0xA9
0xFC6A  3D75        JMPR     CC_NZ_NE, check_spi_read

; 0xA8 = SPI_READ
0xFD56  47F0A800    CMPB     rl0, #0xA8
0xFD5A  3D42        JMPR     CC_NZ_NE, fallthrough

; unknown → echo, loop
0xFDE0  0DF7        JMPR     CC_UC, 0xFDD0
```

## READ (`0xA7`)

### Assembly

```asm
; receive page byte (no cmd ack!)
0xFB52  BBF1        CALLR    serial_rx_with_delay

; build DPP0: page → segment for read
0xFB54  E121        MOVB     rh0, #2
0xFB56  F6F000FE    MOV      0xFE00, r0            ; DPP0 = 0x02xx

; range check
0xFB5A  46F02002    CMP      r0, #0x0220
0xFB5E  9D19        JMPR     CC_NC_UGE, sentinel

; read loop: 8192 words
0xFB60  E004        MOV      r4, #0

0xFB62  F024        MOV      r2, r4
0xFB64  06F28000    ADD      r2, #0x0080
0xFB68  46F20004    CMP      r2, #0x0400
0xFB6C  3D03        JMPR     CC_NZ_NE, no_fc

; flow control every 1024 bytes
0xFB6E  A002        CMPD1    r2, #0
0xFB70  3DFE        JMPR     CC_NZ_NE, 0xFB6E
0xFB72  E002        MOV      r2, #0

no_fc:
0xFB74  A804        MOV      r0, [r4]              ; read word from flash
0xFB76  BBD2        CALLR    serial_tx_word
0xFB78  BB05        CALLR    serial_tx_hi

0xFB7A  0842        ADD      r4, #2
0xFB7C  46F40040    CMP      r4, #0x4000
0xFB80  3DF1        JMPR     CC_NZ_NE, 0xFB62

0xFB82  0DB8        JMPR     CC_UC, 0xFAF4         ; back to loop
```

## PROGRAM (`0xB0`)

### Assembly

```asm
0xFBD6  E6FA1000    MOV      r10, #0x0010          ; write segment
0xFBDA  E000        MOV      r0, #0
0xFBDC  E002        MOV      r2, #0                ; flow control counter
0xFBDE  E6F3AAAA    MOV      r3, #0xAAAA           ; AMD cmd1 address

; receive page byte (no ack!)
0xFBE2  BBE1        CALLR    serial_rx_byte

; build write segment
0xFBE4  F6F000FE    MOV      0xFE00, r0
0xFBE8  F0B0        MOV      r11, r0
0xFBEA  5CEB        SHL      r11, #14              ; intra-seg offset
0xFBEC  F040        MOV      r4, r0
0xFBEE  7C24        SHR      r4, #2
0xFBF0  70A4        OR       r10, r4               ; seg = 0x10 | (page >> 2)
0xFBF2  E004        MOV      r4, #0

; word program loop
0xFBF4  46F20004    CMP      r2, #0x0400
0xFBF8  3D06        JMPR     CC_NZ_NE, no_ack

; ack every 128 bytes
0xFBFA  E7F1C500    MOVB     rh0, #0xC5
0xFBFE  B002        CMPD2    r2, #0                ; delay
0xFC00  3DFE        JMPR     CC_NZ_NE, 0xFBFE
0xFC02  BBC0        CALLR    serial_tx_hi           ; send 0xC5
0xFC04  E002        MOV      r2, #0

no_ack:
0xFC06  E6F5A000    MOV      r5, #0x00A0           ; AMD "program" cmd
0xFC0A  BBCD        CALLR    serial_rx_byte         ; lo byte
0xFC0C  F110        MOVB     rh0, rl0
0xFC0E  BBCB        CALLR    serial_rx_byte         ; hi byte
0xFC10  3C80        ROR      r0, #8                ; swap → (hi << 8) | lo

; AMD program: unlock → 0xA0 → write word
0xFC12  00B4        ADD      r11, r4
0xFC14  BBCE        CALLR    amd_unlock
0xFC16  D7001000    EXTS     #0x10, #1
0xFC1A  B853        MOV      [r3], r5              ; [10:AAAA] ← 0xA0
0xFC1C  DC0A        EXTS     r10, #1
0xFC1E  B80B        MOV      [r11], r0             ; write data word
0xFC20  20B4        SUB      r11, r4

0xFC22  06F21000    ADD      r2, #0x0010
0xFC26  0842        ADD      r4, #2
0xFC28  46F40040    CMP      r4, #0x4000
0xFC2C  3DE3        JMPR     CC_NZ_NE, 0xFBF4
0xFC2E  0D8D        JMPR     CC_UC, cmd_dispatch
```

Flow control counter increments `0x10` per word. Ack at `0x400` =
64 words = 128 bytes. **128 acks per page.**

## ERASE (`0xB4`)

### Assembly

```asm
; AMD unlock + erase setup
0xFC36  BBBD        CALLR    amd_unlock
0xFC38  E6F3AAAA    MOV      r3, #0xAAAA
0xFC3C  E6F58000    MOV      r5, #0x0080
0xFC40  D7001000    EXTS     #0x10, #1
0xFC44  B9A3        MOVB     [r3], rl5             ; [10:AAAA] ← 0x80

; AMD unlock + chip erase confirm
0xFC46  BBB5        CALLR    amd_unlock
0xFC48  E6F3AAAA    MOV      r3, #0xAAAA
0xFC4C  E6F51000    MOV      r5, #0x0010
0xFC50  D7001000    EXTS     #0x10, #1
0xFC54  B9A3        MOVB     [r3], rl5             ; [10:AAAA] ← 0x10

; poll DQ7 from seg 0x08
0xFC56  D7000800    EXTS     #0x08, #1
0xFC5A  A9A3        MOVB     rl5, [r3]
0xFC5C  9AF5FB70    JNB      r5.7, 0xFC56          ; loop while DQ7=0

0xFC60  0DE6        JMPR     CC_UC, cmd_dispatch   ; ack + loop
```

## AMD unlock (`0xFBB2`)

```asm
0xFBB2  E6F8AAAA    MOV      r8, #0xAAAA
0xFBB6  E6F9AA00    MOV      r9, #0x00AA
0xFBBA  D7001000    EXTS     #0x10, #1
0xFBBE  B898        MOV      [r8], r9              ; [10:AAAA] ← 0xAA

0xFBC0  E6F85455    MOV      r8, #0x5554
0xFBC4  E6F95500    MOV      r9, #0x0055
0xFBC8  D7001000    EXTS     #0x10, #1
0xFBCC  B898        MOV      [r8], r9              ; [10:5554] ← 0x55
0xFBCE  CB00        RET
```

Standard AMD/Fujitsu AM29F400B x16-mode unlock. Word addresses
`0xAAAA` / `0x5554` = byte addresses `0x15554` / `0xAAA8`.

## SPI routines (`0xA8`/`0xA9`)

For MS43 EEPROM access. Not used on MS42 (no SPI EEPROM). These
drive the C167 SSC peripheral with P3.7 as chip-select. ~300 bytes
of SSC register manipulation — dacigg assembly is authoritative,
Ghidra output is largely unreadable due to heavy BMOV/BFLDH bit
twiddling.

**SPI_WRITE (`0xA9`):** Receive 3 bytes (addr-lo, addr-hi, control).
If control bit set: SSC master config → WREN → program command →
data word → deassert CS.

**SPI_READ (`0xA8`):** Receive 2 bytes (addr-lo, addr-hi). SSC
config → read command (`0x1800 | addr`) → receive word → TX result
byte to host.

## Serial I/O helpers

**`serial_tx_byte`** (`0xFB0E`): `S0TBUF ← rh0`, wait S0RIC.7, clear flags.

**`serial_tx_word`** (`0xFB1C`): `S0TBUF ← r0` (16-bit), wait, clear flags.

**`serial_rx_with_delay`** (`0xFB36`): Wait S0RIC.7, `rl0 ← S0RBUF`, 0xFFF delay loop.

**`serial_rx_byte`** (`0xFBA6`): Wait S0RIC.7, `rl0 ← S0RBUF`. No delay.

---

# Comparison

| | MiniMon (Path A) | JMG blob (Path B, `--alt`) |
|---|---|---|
| Secondary size | ~394 bytes | 898 bytes |
| Flash driver | Separate upload (`A29F400B.hex`) | Built-in |
| LOADK ack | `0x01` | `0xC5` |
| LOADK end addr | `0xFBE9` | `0xFDE1` |
| Secondary ack | `0x03` | `0xC5` |
| Command style | `[CMD][payload] → ACK1/ACK2` | Single byte, context-dependent ack |
| Flash erase | Via `C_CALL_FUNCTION` + driver | Native `0xB4` |
| Flash program | Via `C_CALL_FUNCTION` + driver | Native `0xB0`, 128-byte flow control |
| Flash read | Via `C_READ_BLOCK` | Native `0xA7`, page-granular |
| SPI/EEPROM | Not supported | `0xA8`/`0xA9` (MS43 only) |
| Erase granularity | Per-sector (driver) | Full-chip only |
| Status | **Broken** — erase fails | **Working** — verified on MS42 |
