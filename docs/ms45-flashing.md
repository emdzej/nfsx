# MS45 DME flashing

Wire-level specification for talking to the BMW MS45.0 and MS45.1 engine
control units over EDIABAS.

Unlike `directmode` (raw DS2, K-line 9600 8E1) and `bootmode` (Infineon
C167 BSL, bench-only), MS45 flashing runs *through* the EDIABAS SGBD
stack — `MS450DS0.prg` on E46 or `10MDS45.prg` on E60/E65, both selected
by the `D_Motor.grp` group file. The SGBD hides the two very different
transport realities (DS2 K-line for MS45.0, BMW-FAST KWP2000 over CAN
for MS45.1) behind a common set of named jobs; nfsx supplies the
choreography, checksums, RSA signatures, and the security-access
payload that unlock the flash-write jobs.

The document is organised as:

1. **§1 — MS45 hardware + memory model.** Two variants, two flash spaces,
   the addresses each hard-wires.
2. **§2 — SGBD job choreography.** The sequence of named jobs the reference
   flasher issues, with the exact argument shapes.
3. **§3 — Security access (level 3).** RSA-1024 MD5 authentication.
4. **§4 — Checksums (CRC-32/MPEG-2).** Where they live, what covers what.
5. **§5 — Signatures (RSA-1024 firmware).** Segment-table hashing, key
   material, storage layout.
6. **§6 — Command reference.** `nfsx ms45 probe | read | write | checksum`.
7. **§7 — Credits.**

---

# §1 — MS45 hardware and memory model

## 1.1 Variants

| Variant | HW ref  | Wire (host ↔ DME) | Default baud | Chassis |
|---------|---------|-------------------|-------------:|---------|
| MS45.0  | 0044560 | DS2 K-line        | 9600         | E46     |
| MS45.1  | 0044570 | BMW-FAST (KWP2000/CAN) | 115200  | E60, E65 |

Both variants respond to the same set of SGBD jobs; the SGBD itself
picks the correct wire encoding by reading `DIAGNOSEPROTOKOLL_LESEN`.
MS45.0 requires a baud raise to 115200 for the read/write jobs to work
in usable time; MS45.1 is at 115200 natively.

## 1.2 Two flash spaces

The DME carries two independent flash memories:

| Region      | ECU-space base | Size    | Purpose |
|-------------|---------------:|--------:|---------|
| External flash | 0xFFF00000  | 0x100000 (1 MB) | Program + parameter blobs |
| Internal MPC flash | 0x00000000 | 0x70000 (448 KB) | Program (extends into MPC) |

A firmware image on the host is a mirror of one of these regions
addressed from offset 0.

## 1.3 Two blobs inside the external flash

| Blob | Host offset in external flash | Size | Description |
|------|------------------------------:|-----:|-------------|
| Parameter (tune) | 0x40000 | 0x1D000 (116 KB) | Maps + calibration |
| Program          | 0x60000 | 0x9FF40           | Boot + application |

Full-image reads / writes hand both files: `<vin>_<hwref>_Flash.bin` for
the external flash (0x100000 bytes) and `<vin>_<hwref>_MPC.bin` for the
internal MPC flash (0x70000 bytes).

## 1.4 ECU-space vs. host-file offset

Segment headers inside the firmware always use ECU-space addresses.
Converting to a host-file offset:

```
external host offset = ecu_addr - 0xFFF00000     (when ecu_addr >= 0xFFF00000)
mpc      host offset = ecu_addr                   (when ecu_addr <  0xFFF00000)
```

Program signed / CRC segments can straddle the 0xFFF00000 boundary —
each descriptor is looked up in the space its start address lands in.

---

# §2 — SGBD job choreography

Everything below runs on `D_Motor` (or an explicit `--sgbd` override).
All jobs are invoked via `IEdiabas.job(sgbd, name, arg)` where `arg` is
either a semicolon-separated string or a byte buffer.

## 2.1 Identity (safe, no auth)

| Job                            | Arg     | Yields                             |
|--------------------------------|---------|------------------------------------|
| `aif_lesen`                    | *(none)*| `AIF_FG_NR` — VIN                  |
| `hardware_referenz_lesen`      | *(none)*| `HARDWARE_REFERENZ` — MS45.0/MS45.1 |
| `daten_referenz_lesen`         | *(none)*| `DATEN_REFERENZ` — tune part-#     |
| `flash_programmier_status_lesen` | *(none)* | `FLASH_PROGRAMMIER_STATUS_TEXT` |
| `DIAGNOSEPROTOKOLL_LESEN`      | *(none)*| `DIAG_PROT_IST` — `BMW-FAST` etc.  |

Sequence: `probe` runs these five in order. `identifyDme()` bails on the
first non-OKAY `JOB_STATUS`.

## 2.2 Security access (level 3)

See §3 for the crypto. Wire-side, this is three jobs:

| Job                                 | Arg (in)                     | Result (out)             |
|-------------------------------------|------------------------------|--------------------------|
| `seriennummer_lesen`                | *(none)*                     | `_TEL_ANTWORT` — buffer, last 4 bytes before terminator = serial |
| `authentisierung_zufallszahl_lesen` | `"3;0x<UUUU>"` (userID hex)  | `ZUFALLSZAHL` — N-byte seed |
| `authentisierung_start`             | 90-byte binary blob (§3.3)   | OKAY = access granted    |

## 2.3 Entering programming mode

**MS45.0 (DS2, needs baud raise):**

| Job                          | Arg                       |
|------------------------------|---------------------------|
| `diagnose_mode`              | `ECUPM;PC115200`          |
| `SET_PARAMETER`              | `;115200`                 |
| `ACCESS_TIMING_PARAMETER`    | `00;120;24;240;00`        |
| `SET_PARAMETER`              | `;115200;;15`             |

**MS45.1 (BMW-FAST, native 115200):**

| Job              | Arg     |
|------------------|---------|
| `diagnose_mode`  | `ECUPM` |

Before flashing, MS45.1 additionally suspends normal gateway traffic:

| Job                         | Arg               |
|-----------------------------|-------------------|
| `normaler_datenverkehr`     | `nein;nein;ja`    |
| `normaler_datenverkehr`     | `ja;nein;nein`    |

## 2.4 Read

`speicher_lesen_ascii` with args `"SEGMENT;START;LEN"` (start + len in
**decimal**). Segments are:

| Selector | Region              |
|----------|---------------------|
| `ROMX`   | External flash 0..0xFFFFF |
| `LAR`    | Internal MPC flash 0..0x6FFFF |

Maximum 254 bytes per call — `readMemory()` loops until the range is
consumed and returns `DATEN` bytes concatenated.

## 2.5 Erase

`flash_loeschen` with a 22-byte binary arg:

```
[0]        0x01
[1..3]     0x00
[4]        0xFE                      command opcode = erase
[5..12]    0x00
[13..16]   blockLength (LE u32)
[17..20]   blockStart  (LE u32)
[21]       0x00                      no trailer on erase
```

Standard targets:

| Target   | blockStart | blockLength |
|----------|-----------:|------------:|
| Tune     | 0x2040000  | 0x20000     |
| Program  | 0x2060000  | 0xA0000     |

Length is nominally ignored by the DME — the erase command wipes the
entire parameter or program space regardless. It's still passed
because the SGBD's job definition reserves the slot.

## 2.6 Write

Three-job choreography per block:

**Open cursor** — `flash_schreiben_adresse(cmd)` where `cmd` is a
22-byte binary arg identical to the erase layout except:

```
[0]        0x01
[13..16]   blockLength (LE u32)
[17..20]   blockStart  (LE u32)
[21]       0x03                      trailer (unlike erase)
```

**Stream chunks** — `flash_schreiben(frame)` per chunk, frame layout:

```
[0]        0x01
[1..12]    0x00
[13]       chunkLen (u8, ≤ 0xFD)
[14..16]   0x00
[17..20]   chunkStart (LE u32)       advances by chunkLen each frame
[21..]     chunk bytes               chunkLen of them
[21+cLen]  0x03                       trailer
```

**Close cursor** — `flash_schreiben_ende(cmd)` with the same 22-byte
layout as the open command.

Standard write targets:

| Target  | Start       | Length    | Payload                                         |
|---------|------------:|----------:|-------------------------------------------------|
| Tune    | 0x2040000   | 0x1D000   | Parameter blob after CRC+sig rewrite            |
| Program | 0x2060000   | 0x9FF40   | `external.subarray(0x60000, 0xFFF40)` post-CRC+sig |
| MPC     | 0x00000000  | 0x70000   | The raw MPC image                                |

## 2.7 Post-flash

**Leave programming mode** — reverse of §2.3:

- MS45.0: `diagnose_mode DEFAULT;PC9600` + `SET_PARAMETER ;9600`
- MS45.1: `diagnose_mode DEFAULT` + `normaler_datenverkehr ja;nein;ja`

**Verify signature** — `FLASH_SIGNATUR_PRUEFEN` with:

| Blob    | Arg          |
|---------|--------------|
| Tune    | `Daten;64`   |
| Program | `Programm;64`|

**Reset** — `STEUERGERAETE_RESET` (no args).

The reference flasher additionally calls `FLASH_PROGRAMMIER_STATUS_LESEN`
before and after the signature check; `nfsx` mirrors this to surface
whatever human-readable state the SGBD publishes.

---

# §3 — Security access (level 3)

## 3.1 Key material

RSA-512 (yes — 512 bits, not 1024; the modulus fits in 64 bytes). Both
key halves are public in the reference flasher's source; `nfsx` ships
them as `AUTH_MODULUS` / `AUTH_PRIVATE_EXPONENT` in `@emdzej/nfsx-ms45`.

## 3.2 Hash input

```
hash = MD5( userID || serialNumber || seed )
```

- `userID` — 4 random bytes chosen by the host. Must be the same value
  passed as the argument to `authentisierung_zufallszahl_lesen`, hex-
  encoded big-endian with the `3;0x` prefix (level 3).
- `serialNumber` — the 4 bytes immediately preceding the terminator of
  the `_TEL_ANTWORT` buffer returned by `seriennummer_lesen`.
- `seed` — the N-byte `ZUFALLSZAHL` result the DME returns.

## 3.3 Cipher + wire format

```
c   = MD5-as-LE-BigInt ^ d  mod  n         (RSA sign, 64-byte result)
sig = repack(c) so byte order per 4-byte word is BIG-endian
message = header (25 B) || sig (64 B) || 0x03      = 90 bytes
```

The 25-byte header is EDIABAS binary-arg metadata extracted from the
SGBD's job definition; identical on every invocation.

The RSA output block itself is a little-endian 512-bit integer split
into 16 words; the storage layout reverses byte order *within each
word* while keeping word order (LSW first) unchanged. This packing is
the same one the firmware-signing key uses (§5); it's how MS45 stores
all 64-byte cipher blocks on the wire and in flash.

---

# §4 — Checksums (CRC-32/MPEG-2)

Algorithm: polynomial `0x04C11DB7`, non-reflected, no final XOR.
Initial value taken from the blob header (not fixed).

```
crc = ((crc << 8) & 0xFFFFFF00) ^ table[((crc >> 24) & 0xFF) ^ byte]
```

## 4.1 Parameter blob — one CRC

| Field                | Offset (in blob) | Size |
|----------------------|-----------------:|------|
| Stored CRC           | 0x100            | u32 BE |
| Segment table start  | 0x104            | u32 BE (count) |
| Segment[i].start     | 0x108 + 8·i      | u32 BE ECU addr |
| Segment[i].end       | 0x10C + 8·i      | u32 BE ECU addr (inclusive) |
| Initial CRC value    | 0x110            | u32 BE |

Segment ECU addresses use base `0xFFE40000`, not `0xFFF40000` — that
base points at the *verify-time* mirror of the parameter space, not
the runtime-execution mirror.

Stock firmware always sets segment count = 1; multi-segment support
is defined in the format but not exercised.

## 4.2 Program blob — TWO CRCs

Both cover segments that can straddle MPC + external flash. Segment
starts are raw ECU addresses (no base subtraction) — a segment start
below 0xFFF00000 lives in the MPC image.

| CRC       | Stored offset | Initial offset | Segments (start/end pairs) |
|-----------|--------------:|---------------:|----------------------------|
| Primary   | 0x60000       | 0x60004        | 0x60008/0x60010, 0x6000C/0x60014 |
| Secondary | 0x60340       | 0x60358        | 0x60348/0x6034C, 0x60350/0x60354 |

In stock firmware the secondary is byte-identical to the primary
(same segment definitions, same output); older program versions may
have used it differently. `nfsx` recomputes whatever the header says.

---

# §5 — Signatures (RSA-512 firmware)

## 5.1 Key material

Different RSA-512 keypair from §3.1 (different chip role: unlock vs.
integrity). Shipped in `@emdzej/nfsx-ms45` as `FIRMWARE_MODULUS` and
`FIRMWARE_PRIVATE_EXPONENT`.

## 5.2 Signed-segment layout

**Parameter blob:**

| Field                       | Offset | Size |
|-----------------------------|-------:|------|
| Segment count               | 0x130  | u32 BE |
| Segment[i].start (ECU addr) | 0x134 + 8·i | u32 BE |
| Segment[i].length           | 0x144 + 4·i | u32 BE |
| Stored signature            | 0x174  | 64 bytes |

Segment ECU addresses use base `0xFFF40000` (the parameter-blob base).

**Program blob:**

| Field                       | Offset | Size |
|-----------------------------|-------:|------|
| Segment count               | 0x60030 | u32 BE |
| Segment[i].start (ECU addr) | 0x60034 + 8·i | u32 BE |
| Segment[i].length           | 0x6004C + 4·i | u32 BE |
| Stored signature            | 0x60074 | 64 bytes |

Program signature segments use raw ECU addresses — starts below
0xFFF00000 read from the MPC image, everything else from external.

## 5.3 Signing

```
concat = ⌜ every byte named by every signed segment ⌝
hash   = MD5(concat)
c      = hash-as-LE-BigInt ^ d  mod  n
sig    = encodeSignatureBytes(c LE)         (64 bytes, LSW-first BE-per-word)
```

`encodeSignatureBytes` is the same packing §3.3 uses.

## 5.4 Verifying

RSA signing is deterministic when both operands are known: re-run the
sign path and compare the 64-byte output to whatever's stored at
0x174 (parameter) or 0x60074 (program). `nfsx ms45 checksum` and
`writeFlash`'s `--skip-sign=false` path both use this.

---

# §6 — Command reference

## 6.1 `nfsx ms45 probe`

Identifies the DME. Runs the five §2.1 jobs; prints the result table.
Safe — no auth, no state change.

## 6.2 `nfsx ms45 read -o out.bin -m tune|full`

Read the DME.

- `--mode tune` — 116 KB parameter blob → single output file.
- `--mode full` — 1 MB external flash → `<output>` + 448 KB MPC flash → `<output>` with `_MPC` before the extension.

Runs auth + `enterProgrammingMode` + chunked `speicher_lesen_ascii` +
`leaveProgrammingMode`.

## 6.3 `nfsx ms45 write -i in.bin -m tune|full [--mpc mpc.bin]`

Write a BIN to the DME. Requires `--mpc` when `--mode full`.

Default flags — checksums + signature are **automatically recomputed**
before the payload is streamed. Individual overrides:

| Flag              | Effect |
|-------------------|--------|
| `--skip-checksum` | Do not recompute CRC-32 |
| `--skip-sign`     | Do not recompute RSA signature |
| `--skip-verify`   | Skip the post-flash `FLASH_SIGNATUR_PRUEFEN` |
| `--yes`           | Skip the "type FLASH to proceed" confirmation prompt |

Payload size gates run **before** any wire I/O — a wrong-size input
fails fast without touching the ECU.

## 6.4 `nfsx ms45 checksum -f file.bin [--mpc mpc.bin]`

Offline. Auto-detects tune (0x1D000 bytes) vs. external flash
(0x100000 bytes). `--rewrite` writes back in place (or to `--output`);
without it the command is verify-only and returns exit code 1 on any
mismatch.

`--skip-checksum` and `--skip-signature` let the caller narrow the
operation to just the CRCs or just the RSA signature.

---

# §7 — Credits

MS45 wire-level knowledge in this reconstruction traces back to:

- **[terraphantm/MS45-Flasher](https://github.com/terraphantm/MS45-Flasher)**
  — the original open-source MS45 flasher (GPL-3.0). The RSA moduli
  and private exponents in `@emdzej/nfsx-ms45` were first published
  in that project's `Checksums_Signatures.cs`.
- **hassmaschine** — DME disassembly and initial protocol reverse-
  engineering.
- **[bimmerlabs](https://bimmerlabs.com)** — ongoing MS45 tuning
  research.

`nfsx-ms45` is a clean-room reimplementation: the C# source was read
to extract wire-level facts (job names, byte layouts, CRC polynomial,
address maps, RSA key material) and re-implemented from scratch in
TypeScript. No source was copied.
