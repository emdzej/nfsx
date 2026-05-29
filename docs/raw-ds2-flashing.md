# Flashing using raw DS2 protocol

Wire-level specification for talking to BMW E36 / E39 / E46 / E53-era control
units over a K+DCAN cable.

DS2 is a framing protocol: the same `[ADDR] [LEN] [CMD] [DATA…] [XOR]` envelope
is used to address every BMW K-line ECU. What varies is *which CMD values
each ECU implements* — IDENT and memory-read work almost everywhere, while
the flash erase / program / verify commands are recognised only by
programmable engine and transmission ECUs (MS43, MS45 / MSS54, GS20, and
close relatives).

The document is organised as:

1. **§1 — DS2 framing.** The universal envelope, baud handling, half-duplex
   echo, retry semantics, status codes. Applies to every ECU on the bus.
2. **§2 — Broadly-supported DS2 commands.** Identity (`0x00`), memory read
   (`0x06`), capability/hardware-reference query (`0x0D`) — most DS2 ECUs
   respond to these.
3. **§3 — DS2 commands for programmable engine / transmission ECUs.**
   SEED/KEY auth (`0x90`), flash erase / write / verify (`0x07 0x06 / 0x02
   / 0x0F`). These are still DS2 frames — they're just commands that only
   the MS-family ECUs (and a few related programmables) implement.

A reader who only needs to list a cluster's identity needs §1 and §2.1. A
reader implementing a full flash needs all three sections.

---

# §1 — DS2 framing (universal)

## 1.1 Physical / serial layer

| Parameter | Value |
|---|---|
| Cable | USB ↔ K-line (K+DCAN family) |
| Baud rate (default) | **9 600** |
| Data bits | 8 |
| Parity | Even |
| Stop bits | 1 |
| Handshake | None |
| DTR / RTS | Not asserted |
| Read timeout | 1 000 ms |
| Write timeout | 1 000 ms |

K-line is half-duplex — every transmitted byte echoes back on the receive
side. The host MUST consume and validate this echo before accepting the
ECU response (see §1.4).

## 1.2 Frame format

Every telegram in either direction has the shape:

```
[ADDR] [LEN] [CMD] [DATA…] [XOR]
```

| Field | Width | Purpose |
|---|---|---|
| `ADDR` | 1 byte | Target ECU address (e.g. `0x12` engine, `0x32` transmission, `0x80` cluster on some chassis) |
| `LEN` | 1 byte | **Total** frame length on the wire — `ADDR` + `LEN` + `CMD` + `DATA…` + `XOR`. For an IDENT request `[ADDR][04][00][XOR]`, `LEN = 0x04` because the whole frame is 4 bytes. |
| `CMD` | 1 byte | Command byte — see §2 / §3 |
| `DATA…` | 0–N bytes | Command-specific payload |
| `XOR` | 1 byte | XOR of every byte in the frame from offset 0 (`ADDR`) through the last `DATA` byte, **inclusive of `ADDR`** and not including the XOR position itself. |

Verified against MS4x Flasher 1.6.0 (`ᄁ/A/A.cs:147-165` — its frame builder
walks `for (i = 0; i < span.Length; i++) b2 ^= span[i]`, starting at the
ADDR byte) and the EdiabasLib K+DCAN reference (`ediabasx/packages/
interface-serial/src/kdcan/ds2.ts` — `calcChecksumXor(request, 0,
request.length)` similarly XORs from offset 0 onwards).

## 1.3 Baud-rate switching

Five baud rates are switchable mid-session via a 5-byte command sent at
the current baud, after which both ends switch to the new rate:

| New baud | Telegram (hex) |
|---|---|
| 9 600 (default) | `91 00 25 80 01` |
| 19 200 | `91 00 4B 00 01` |
| 38 400 | `91 00 96 00 01` |
| 62 500 | `91 00 F4 24 01` |
| 125 000 | `91 01 E8 48 01` |

A variant table exists where the trailing byte is `0x00` instead of `0x01`
— used by an earlier ECU/protocol generation. Implementations supporting
multiple chassis families should expose both variants.

These telegrams are wrapped in DS2 frames in the normal way (with `ADDR`
of the target ECU and an `XOR` checksum); the table above shows only the
distinctive payload.

## 1.4 Half-duplex echo handling

Each transmitted frame's bytes reappear immediately on the receive line.
The canonical read flow per transaction is:

1. Write `N` bytes (the full request frame) to the K-line.
2. Read `N` bytes. These are the byte-for-byte echo of the request;
   verify equality.
3. Read 2 more bytes — `ADDR` and `LEN` of the response.
4. `LEN` is the total response frame length. We already have 2 bytes
   (`ADDR` + `LEN`), so read `LEN - 2` more bytes to complete the frame.
5. Verify the response's `XOR` checksum (XOR over offsets `0..LEN-2`
   should equal byte `LEN-1`).

If the echo does not match the transmitted bytes, the line is corrupted
or another ECU is asserting — abort the transaction.

## 1.5 Retry policy

Recommended at the transaction layer (all command classes below):

| Operation class | Attempts | Inter-attempt sleep |
|---|---|---|
| Single-shot requests (identity, memory read, …) | 5 | 10 ms |
| Long-running operations during "pending" status (see §3.5) | unbounded — driven by user-side cancel | 10 ms |

A retry should fire on any transport-layer failure (timeout, framing
error, checksum mismatch). Status byte `0xA1` ("pending", §1.6) is **not**
an error — the same request is re-sent, but doesn't count against the
attempt budget.

## 1.6 Response status byte

For any command, the response's `DATA[0]` (i.e. the byte at position 2 in
the full response frame, counting from `ADDR=0`) carries a status code:

| Value | Meaning |
|---|---|
| `0xA0` | OKAY — operation complete, response valid |
| `0xA1` | Pending — re-issue the same request after a short delay |
| `0xB0` | Generic transport error from the ECU side |
| `0xC0` | Checksum or framing error in the host's request |

Any other value indicates a protocol-level malformed response.

---

# §2 — DS2 standard diagnostic commands

These work on most BMW DS2 ECUs (cluster, body modules, IKE, ABS, engine,
transmission, …). The exact set each ECU supports — and the layout of
the response payload — varies per ECU.

## 2.1 IDENT (`CMD = 0x00`)

Returns the ECU's identity block — HWNR, software part number, coding
index, diagnostic index, build date, supplier, programming counter, etc.
Universal across DS2 ECUs.

### Request

```
[ADDR] [0x04] [0x00] [XOR]
```

### Response

```
[ADDR] [LEN] [0xA0] [identity_data…] [XOR]
```

`LEN` is variable per ECU — typical engine response is ~46 bytes; cluster
~24 bytes. The data layout is per-ECU and the response needs to be parsed
against documented identity-field offsets for that ECU.

Verified across the three target HWNRs (all use `CMD = 0x00`):
- MS42 (HWNR 1430844): TX `[0x12] [0x04] [0x00] [XOR]`
- MS43 (HWNR 7545150): TX `[0x12] [0x04] [0x00] [XOR]`
- GS20 (HWNR 7544721): TX `[0x32] [0x04] [0x00] [XOR]`

## 2.2 Memory read (`CMD = 0x06`)

Reads raw bytes from the ECU's memory. Supported by most DS2 ECUs for
diagnostic purposes; some ECUs gate certain regions behind authentication
(see §3.2). For the engine / transmission ECU families covered here,
unrestricted reads work without authentication.

### Request

```
[ADDR] [LEN] [0x06] [A_HI] [A_MID] [A_LO] [SIZE] [XOR]
```

- 24-bit big-endian start address
- `SIZE`: 1 byte, number of bytes to fetch in this transaction. Bounded
  by a per-ECU block-size limit (see §3.7 for the engine-family values).
- `LEN = SIZE + 6`

### Response

```
[ADDR] [SIZE+4] [0xA0] [DATA_0 … DATA_(SIZE-1)] [XOR]
```

- `LEN == SIZE + 4` (strict). If the ECU returns a frame whose declared
  length disagrees with the requested size, the response is malformed.
- No "pending" state — the ECU returns the requested bytes immediately or
  the transaction fails.

For a full firmware dump, the host iterates over the ECU's flash address
range in chunks of `SIZE`; see §3.7 for the typical region layout on the
MS-family ECUs.

## 2.3 Capability / hardware-reference query (`CMD = 0x0D`)

A second meta-query supported by most DS2 ECUs. The interpretation of the
response is **ECU-dependent**:

- On MS42 / MS43 engine ECUs **in programming context** (after
  authentication, see §3.2) the same command returns the maximum flash
  block size the ECU will accept on a single `0x07 0x02` write.
  Block-size byte is at response offset 3, with the convention
  `block_size = response[3] > 9 ? response[3] - 9 : response[3]`.
- On GS20 (and engine ECUs in diagnostic context) the same command
  returns a hardware-reference identity block — software-control-unit
  code, project number, status flags, programming counter.

### Request

```
[ADDR] [0x04] [0x0D] [XOR]
```

### Response

```
[ADDR] [LEN] [0xA0] [ecu-specific data…] [XOR]
```

ECUs vary in how much data they return. Real-bench observations on
HWNR 7544721 (GS20) at the time of writing showed an ECU advertising
`LEN = 0x4C` (76 bytes) but only transmitting 58 bytes on the wire — this
is the canonical "short tail" case for this command. The correct parser
either reads up to the LEN declared and tolerates short reads at the
caller, or knows the ECU-specific fixed expected length from documented
metadata. The DS2 framing layer's strict-LEN semantics will reject this
transaction.

---

# §3 — DS2 commands for programmable engine / transmission ECUs

The commands below — SEED/KEY authentication, flash erase / program /
verify — are regular DS2 frames using the §1 envelope. They differ from
§2's commands only in *which ECUs implement them*: programmable engine
ECUs in the MS42 / MS43 / MS45 (MSS54) family and close relatives respond
to these. Other DS2 ECUs (cluster, body modules, ABS, airbag, …) don't
understand them and either silently ignore the request or return an error
status — sending these CMD values to the wrong ECU class is harmless,
just useless.

> **Programmable ECUs covered by this section.** Verified on the
> following targets — all use the same DS2 command set described
> below; only addresses and memory layouts differ (see §5).
>
> | HWNR | DS2 address | ECU |
> |---|---|---|
> | 7544721 | `0x32` | GS20 transmission. Real-bench flash succeeded (~440 KB pushed, drained). |
> | 1430844 | `0x12` | MS42 engine. |
> | 7545150 | `0x12` | MS43 engine (E46 M54 family). |

## 3.1 Authentication required

All commands in §§3.3–3.5 (erase, write, verify) require a successful
SEED/KEY exchange (§3.2) earlier in the same session. Memory reads (§2.2)
do **not** require authentication on these ECUs.

A session lasts until either disconnect or the ECU's idle timeout fires
(seconds). Reconnecting requires a new SEED/KEY exchange.

## 3.2 SEED/KEY authentication

### Step 1 — Request seed (`CMD = 0x90`)

```
[ADDR] [0x07] [0x90] [0x42] [0x4D] [0x57] [NONCE] [XOR]
```

- Command byte `0x90`
- Three fixed bytes spelling `BMW` in ASCII
- `NONCE`: one random byte in the range **1..23 inclusive**. Values
  outside this range produce undefined behaviour (the ECU may derive
  a different key, causing silent auth failure).

### Step 2 — Receive seed material

```
[ADDR] [0x2E] [0xA0] [seed_0 … seed_42] [XOR]
```

- `LEN = 46` (`0x2E`)
- 43 bytes of seed material at response positions `[3..45]`
- If `LEN == 5` instead, authentication is already unlocked for this
  session — skip to Step 4.

### Step 3 — Derive the key

The 4-byte response key is computed from the seed material and the
nonce. For `i ∈ {0, 1, 2, 3}`:

```
key[i] = ( seed[(nonce + i) mod seed[1]]
         + seed[18 + i]
         + seed[41 + i] ) mod 256
```

Where `seed[k]` is the `k`-th byte of the response (so `seed[0] = ADDR`,
`seed[1] = LEN = 0x2E`, `seed[2] = 0xA0` status, `seed[3]…` is the
material). The first term uses `seed[1]` as the modulus, yielding a
cyclic index into the response bytes. Arithmetic is unsigned 8-bit
addition with implicit truncation.

### Step 4 — Submit the key

```
[ADDR] [0x06] [KEY_0] [KEY_1] [KEY_2] [KEY_3] [XOR]
```

Response on success: `[ADDR] [0x05] [0xA0] [SBYTE_3] [XOR]`. Any status
other than `0xA0` means authentication failed; the ECU may impose a
back-off before accepting another attempt.

## 3.3 Erase (`CMD = 0x07 0x06`)

Erases a memory region in preparation for writes.

### Request

```
[ADDR] [0x08] [0x07] [0x06] [A_HI] [A_MID] [A_LO] [0x00] [XOR]
```

- 24-bit big-endian start address (`0x000000` for full-image erase)
- Reserved trailing byte `0x00`

### Response

```
[ADDR] [0x09] [STATUS] [...] [RESULT] [XOR]
```

- `STATUS = 0xA0` and `RESULT (= response[8]) = 0x01` ⇒ success
- `STATUS = 0xA1` ⇒ pending — re-issue the same request after ~10 ms

Erase typically completes within a few seconds; expect multiple `0xA1`
polling rounds.

## 3.4 Flash write (`CMD = 0x07 0x02`)

Writes one block. The caller iterates over the firmware image.

### Request

```
[ADDR] [LEN] [0x07] [0x02] [A_HI] [A_MID] [A_LO] [SIZE] [DATA_0 … DATA_(SIZE-1)] [XOR]
```

- 24-bit big-endian destination address
- `SIZE`: 1 byte, ≤ per-variant block size (§3.7)
- `LEN = SIZE + 7`

### Response

```
[ADDR] [LEN] [0xA0] [...] [RESULT = 0x01] [XOR]
```

### 3.4.1 `0xFF` skip optimisation

The write loop SHOULD skip over runs of `0xFF` bytes in the source image
— freshly erased flash is already `0xFF`. The address counter still
advances over skipped bytes; the ECU assumes any address it isn't sent
keeps its erased value.

- If the next 2 source bytes are `0xFF 0xFF`, advance the address by 2
  and don't include them in this block.
- If the *trailing* bytes of an already-formed block are `0xFF 0xFF`,
  strip them and reduce `SIZE`. The ECU pads up to the declared `SIZE`
  with the erase pattern internally.

When trailing bytes are stripped, the next block's destination address
must still account for the stripped bytes (address += original block
length, not trimmed length).

## 3.5 Verify (`CMD = 0x07 0x0F`)

Triggers an ECU-internal integrity check over a region and waits for the
result. Issued after all writes are complete; can also confirm an
existing firmware image is intact.

### Request

```
[ADDR] [0x08] [0x07] [0x0F] [A_HI] [A_MID] [A_LO] [0x00] [XOR]
```

### Response

```
[ADDR] [LEN] [STATUS] [...] [RESULT] [XOR]
```

- `STATUS = 0xA1` ⇒ **pending** — re-issue after ~10 ms
- `STATUS = 0xA0` AND `RESULT = 0x01` ⇒ **passed**
- `STATUS = 0xA0` AND `RESULT ≠ 0x01` ⇒ **failed** (operation-specific
  error code)

The ECU computes its own CRC internally; the response carries only
pass/fail, not the CRC value. For byte-for-byte verification, the host
can read back the region via §2.2 and compare against the source image.

There is no hard limit on polling iterations — the host should rely on
a cancellation token or wall-clock timeout to bound the operation.


## 3.6 Disconnect

No explicit "leave programming session" telegram is required. The
recommended sequence on completion (or error) is:

1. Optionally restore the baud rate to 9 600 if it was switched higher
   during programming.
2. Close the serial port.

The ECU drops the session after its idle timeout and resumes normal
operation. If a programming session was interrupted mid-erase or
mid-write, the ECU's "valid firmware" flag is cleared and only the
bootloader will respond on the next connection — a new full flash is
required to recover.

## 3.7 Per-variant parameters

### Block size (read §2.2 and write §3.4)

| ECU class | Block size | Max-data variant |
|---|---|---|
| MS43 / MS45 engine, small-memory GS20 transmission | 123 | 118 |
| High-capacity variants (extended flash) | 251 | 246 |

The "max-data variant" applies to a small number of internal operations
that need extra header space; default to the block size unless the
implementation has reason to differ.

### Memory layout (full firmware dump)

High-capacity ECUs span three contiguous regions, with suggested
progress weights for a UI:

| Region | Start | Size | Weight |
|---|---|---|---|
| 1 | `0x00000` | 32 KB | 0.13 |
| 2 | `0x10000` | 196 KB | 0.75 |
| 3 | `0x08000` | 32 KB | 0.12 |
| Total | | ~260 KB | 1.00 |

Smaller MS43-class ECUs span ~520 KB across a different offset layout —
the exact regions are per-variant.

### Operation result byte (response position 8, where applicable)

For erase / write / verify the operation outcome is carried in a separate
byte at offset 8. Convention is `0x01` = success; values `0x02` and
`0x09..0x0F` are operation-specific error codes (address out of range,
flash not erased before write, voltage out of spec, protection bit set,
CRC mismatch, etc.). Treat any non-`0x01` as a fatal error and abort.

---

# §4 — Wire-level flash flow (stage-by-stage)

A complete flash goes through five stages. Each stage below shows the
DS2 telegrams exchanged on the wire — the order they appear, the bytes
sent, the response shape expected. `ADDR` is `0x32` for GS20, `0x12`
for MS42 / MS43; `XOR` is the checksum per §1.2.

## 4.1 PRECHECK — confirm the ECU is on the bus

Read-only. No authentication. Runs in the default diagnostic session.

```
# Identity (§2.1)
TX  [ADDR] 04 00 [XOR]
RX  [ADDR] LEN A0 <identity bytes> [XOR]      ; LEN ≥ 45 on engine ECUs

# Status + hardware reference (§2.3)
TX  [ADDR] 04 0D [XOR]
RX  [ADDR] LEN A0 <status/hwref bytes> [XOR]
```

If either request times out or returns status ≠ `0xA0`, the bus is
quiet or the wrong ECU is connected — abort before doing anything
destructive.

## 4.2 BACKUP — snapshot current flash contents

Memory reads (§2.2) over the regions defined in §5 for the target
HWNR. Loops chunk-by-chunk; `SIZE` per chunk is bounded by the ECU's
reported block-size limit (§4.3.2 — same chunk-size table used in the
write loop).

```
# For each chunk in the regions:
TX  [ADDR] LEN 06 A_HI A_MID A_LO SIZE [XOR]      ; LEN = SIZE + 6
RX  [ADDR] (SIZE+4) A0 <SIZE bytes of flash> [XOR]
```

No authentication required. The whole region is read out and saved to
a backup file so a botched flash can be reasoned about post-mortem.

## 4.3 PROGRAM — the flash itself

The single block-of-work stage. Internally it runs sub-steps in this
order:

### 4.3.1 Authenticate (§3.2)

```
# Seed request
TX  [ADDR] 07 90 42 4D 57 NONCE [XOR]          ; NONCE ∈ 1..23
RX  [ADDR] 2E A0 <seed[0..42]> [XOR]            ; LEN = 0x2E (46 bytes)

# Derive key — see §3.2 step 3 for the algorithm.

# Submit key
TX  [ADDR] 06 K0 K1 K2 K3 [XOR]
RX  [ADDR] 05 A0 . [XOR]                        ; LEN = 0x05
```

Until this succeeds, every subsequent `0x07 0x*` command is rejected.

### 4.3.2 Negotiate block size

```
TX  [ADDR] 04 0D [XOR]                          ; same CMD as PRECHECK
                                                ; §4.1, but in programming
                                                ; context returns block-size
                                                ; instead of hardware-ref
RX  [ADDR] LEN A0 <block size bytes> [XOR]
```

The ECU reports the max payload per `0x07 0x02` write — typically
**256** for MS-family and GS20. Subtract 5 for the DS2 wrapper
(`CMD_HI CMD_LO ADDR_HI ADDR_MID ADDR_LO XOR`) to get the usable data
size — typically **246 bytes** per chunk.

### 4.3.3 Erase (§3.3) — one telegram per region

```
# For each region in §5 for this HWNR:
TX  [ADDR] 08 07 06 A_HI A_MID A_LO 00 [XOR]
RX  [ADDR] 09 A0 <...> 01 [XOR]                 ; final result = 0x01

# Erase is slow; the ECU may return A1 (pending) instead of A0.
# Poll by re-issuing the same request every ~10 ms until A0 / 01.
```

### 4.3.4 Write loop (§3.4) — one telegram per chunk

```
# Repeat until all regions are covered. SIZE ≤ block-size limit from §4.3.2.
TX  [ADDR] LEN 07 02 A_HI A_MID A_LO SIZE <SIZE bytes of firmware> [XOR]
                                                ; LEN = SIZE + 7
RX  [ADDR] LEN A0 <...> 01 [XOR]                ; result = 0x01

# Address advances by SIZE per iteration. Runs of 0xFF in the source may
# be skipped (advancing the address without sending the telegram) — see
# §3.4.1.
```

Transient `0xA1` ("pending") responses can appear mid-loop on slower
flash banks. Re-issue the *same* telegram (not a new one with the next
chunk) after ~10 ms until the ECU accepts. Transient
`ERROR_SG_UNBEKANNTES_STATUSBYTE` / framing errors (the ECU was still
committing the previous chunk to NVRAM when our request arrived) get
a 200 ms backoff plus a re-send of the same telegram; otherwise the
chunk's bytes silently fail to land.

### 4.3.5 Finalise / verify (§3.5)

```
TX  [ADDR] 08 07 0F A_HI A_MID A_LO 00 [XOR]    ; start = first region's base
RX  [ADDR] LEN A0 <...> 01 [XOR]

# Verify is slow on big regions; the ECU may return A1 (pending) for
# many polling rounds before A0 / 01.
```

After A0/01 the flash is committed and the ECU's "valid firmware" flag
is asserted.

## 4.4 POSTCHECK — confirm the ECU rebooted correctly

Same wire activity as PRECHECK (§4.1). The ECU should now return the
*new* identity bytes (different software part number, incremented
programming counter, etc.). If the wire still returns the pre-flash
identity, the new image wasn't activated.

## 4.5 DISCONNECT

No telegram. Close the port; the ECU drops the programming session
on idle timeout (seconds). If the flash was interrupted between
§4.3.3 (first erase) and §4.3.5 (verify), the ECU stays in bootloader
mode — only `0x07 0x*` commands respond, the §2 diagnostic commands
return error status. Recovery is a fresh full flash.

---

# §5 — Per-target memory layout

The tables below describe the **sparse address ranges BMW updates
through WinKFP** — that is, the regions present as records in the
`.0PA` archive for each HWNR.

These are not necessarily the only writable regions on the ECU, and
they are not the only way to slice a 512 KB MS-family image: a
third-party flasher reverse-engineered from real binaries (MS4x
Flasher 1.6.0) accepts a 512 KB BIN but on the wire writes only its
own hard-coded per-variant region tables, which are *similar* to but
not identical to BMW's `.0PA` slices. The shared pattern across both
tools is:

- A 24-bit absolute address goes on the wire per write telegram
  (§3.4); the protocol places no limit on what range that may cover.
- In practice the host (BMW or third-party) carves out specific
  ranges and never sends telegrams outside them. Whether the ECU
  itself would reject an out-of-range write is **not established**
  by either implementation — neither tool tries it.
- The trailing `0xFF` skip optimisation in §3.4.1 makes the wire
  cost proportional to the *non-erased* content of those regions,
  not their nominal byte count.

When writing only the BMW-supplied calibration / program slices, the
write loop walks the regions below sequentially. Going outside them
isn't a protocol violation per se; it's just an address space neither
known flasher exercises.

## 5.1 GS20 transmission (HWNR 7544721)

| # | Start | End | Size | Notes |
|---|---|---|---|---|
| 1 | `0xA0000` | `0xAFFFF` | 64 KB | |
| 2 | `0xB0000` | `0xBFFFF` | 64 KB | |
| 3 | `0xC0000` | `0xCFFFF` | 64 KB | |
| 4 | `0xD0000` | `0xDFFFF` | 64 KB | |
| | | | **256 KB** | total addressable |

Four contiguous 64 KB blocks. Approximately 32 bytes between sectors
in the `.0PA` record stream that look like checksums / terminators
(not user-flashable data). Bootloader and read-only regions sit
outside `0xA0000–0xDFFFF` and are never touched by the flash loop.

Real-bench evidence: ~440 KB pushed over ~1,900 iterator calls (≈ 246
bytes per call), iterator drained, ECU returned to normal operation
post-flash.

**Update — MS4x Flasher does support TCU.** Its UI dropdown switches
between ECU and TCU modes; `nfsx-directmode` now uses MS4x Flasher's
`r` protocol class (`ᄁ/A/R.cs:813`) for GS20 with a different region
table than the WinKFP `.0PA` slices above. Effective layout:

- BIN format is **512 KB** (same as MS-class engine BIN; padded)
- BIN `0x10000-0x1FFFF` → ECU `0x90000-0x9FFFF` (64 KB program)
- BIN `0x20000-0x5FFFF` → ECU `0xA0000-0xDFFFF` (256 KB data)
- BIN `0x00000-0x0FFFF` and `0x60000-0x7FFFF` are header / padding

A real calibration-only mode exists (MS4x Flasher's `r::a` at
`R.cs:884`): rewrites only the 64 KB program block at `0x90000`.
`nfsx directmode write --mode calibration` uses this. The WinKFP
`.0PA` table (above) covers an overlapping but not identical set of
bytes; if you have a BIN authored from a WinKFP dump rather than a
MS4x Flasher dump, you'll need to translate or stick with the
WinKFP `.0PA` path through `nfsx flash`.

## 5.2 MS42 engine (HWNR 1430844)

HWNR not present in the E46_v74 SP-Daten drop — couldn't enumerate
the regions directly. From family conventions in the MS-class engine ECUs
the layout is expected to mirror GS20's pattern at a different base
(typically `0xE0000–0xEFFFF` for MS42-class memory maps), but this is
unverified for this specific HWNR. Real-bench confirmation needed.

## 5.3 MS43 engine (HWNR 7545150)

| # | Start | End | Size | Notes |
|---|---|---|---|---|
| 1 | `0x90000` | … | 64 KB | program region 1 |
| 2 | … | … | 64 KB | program region 2 |
| 3 | … | … | 64 KB | program region 3 |
| 4 | … | … | 64 KB | program region 4 (after a ~22.5 KB gap from region 5) |
| 5 | … | … | data region | calibration |
| 6 | … | … | data region | calibration |
| 7 | `0xEFDAE` | `0xEFFED` | 576 B | metadata footer (not 4 KB-aligned) |
| | | | **~357 KB** | total addressable |

Seven non-contiguous regions, ~39 % larger than GS20. The trailing
576-byte unaligned footer at `0xEFDAE` is likely CVN / build-info
metadata that the bootloader expects at a fixed offset.

The flash loop respects this layout: one erase telegram (§3.3) per
64 KB block in the program regions; data regions may be erased at a
different granularity; then writes (§3.4) go sequentially through the
firmware archive.

## 5.4 MS-family firmware checksums

A modified MS42 / MS43 firmware image must have its internal
checksums recomputed before it goes on the wire, or the bootloader's
post-write integrity check rejects the image and the ECU will not
boot the new firmware. (BMW's own `.0PA` archives already carry valid
checksums; this only matters when authoring a modified image or
flashing a tuner-supplied BIN.)

### Algorithm

**CRC-16/CCITT**, polynomial `0x1021` (stored in code as the
bit-reversed constant `0xA001`). Standard byte-wise table CRC; no
final XOR.

The flasher does not embed any fixed seed — for each checksum, the
*seed value* is itself stored in the BIN at a fixed offset, along
with the input range (start / end addresses, also stored in the BIN).
This is what lets a single algorithm cover several non-contiguous
regions parameterised by the firmware header itself.

### MS42 (HWNR 1430844) — three checksums

| # | Result @ | Input range @ | Seed @ | Covers |
|---|---|---|---|---|
| 1 | `0x3C24` (u16) | `0x3C28` (u32 start), `0x3C2C` (u32 end) | `0x3FF6` (u16) | main calibration block |
| 2 | header-driven  | header-driven | header-driven | calibration index table (looped) |
| 3 | header-driven  | header-driven | header-driven | per-table data blocks (looped) |

Checksum #1 has fully fixed metadata offsets and is fully specified
above. Checksums #2 and #3 read their parameters from offsets that
themselves vary by variant — they walk a table of `(start, end,
result_offset)` triples elsewhere in the header.

For checksum #1 the dword reads are stored as two little-endian
u16s side by side:

```
start = (read_u16_le(0x3C2A) << 16) | read_u16_le(0x3C28)
end   = (read_u16_le(0x3C2E) << 16) | read_u16_le(0x3C2C)
seed  =  read_u16_le(0x3FF6)
crc   = crc16_ccitt(image[start..=end], seed)
write_u16_le(0x3C24, crc)
```

### MS43 (HWNR 7545150) — single checksum

Same algorithm. Single CRC-16/CCITT pass; ranges are read from the
firmware header (variant-specific offsets, not hard-coded like MS42's
`0x3C24` block).

### GS20 (HWNR 7544721)

Not covered by the MS4x Flasher decomp — checksum scheme for the
GS20 transmission firmware is unverified. The ~32 bytes of
non-program data between region boundaries in the `.0PA` record
stream may carry a similar CRC.

### Source

Implementation reverse-engineered from MS4x Flasher 1.6.0,
`A.a : h` in `ᄆ/A/A.cs:101–320`. CRC primitive at
`ᄆ/A/A.cs:10–73` (`A.A.A` bit-by-bit, `A.A.a` table-based; both take
the polynomial as a parameter).

---

# §6 — Implementation notes & gotchas

1. **Checksum scope: ADDR is INCLUDED.** XOR runs over every byte from
   offset 0 (`ADDR`) through the last data byte, not just `LEN` onwards.
   Both MS4x Flasher (`ᄁ/A/A.cs:157-165`) and EdiabasLib's K+DCAN
   transport (`ediabasx/packages/interface-serial/src/kdcan/ds2.ts`'s
   `calcChecksumXor(request, 0, request.length)`) start at offset 0;
   implementations that skip `ADDR` get every transaction rejected.

2. **LEN counts the whole frame, including ADDR.** A 4-byte IDENT
   request `[ADDR][04][00][XOR]` has `LEN = 0x04` — i.e. `LEN` equals
   the total number of bytes on the wire, not "LEN onwards". A memory
   read response carrying `N` data bytes has `LEN = N + 4` (ADDR +
   LEN + STATUS + data + XOR = N + 4).

3. **Two-stage receive.** Each response involves two distinct serial
   reads: first `N` bytes for the echo of our transmitted request,
   then the response's `ADDR` + `LEN` (2 bytes), then `LEN - 2` more
   bytes for the rest of the frame. Trying to read one large chunk
   doesn't work — the response `LEN` isn't known until ADDR+LEN have
   been read.

4. **Strict response length.** For memory reads, `LEN == SIZE + 4` is
   enforced (SIZE data bytes + ADDR + LEN + STATUS + XOR = SIZE + 4);
   for writes / erase / verify, `LEN` matches a fixed value per
   command. Frames whose declared `LEN` byte disagrees with the
   payload that follows are rejected as malformed.

5. **Nonce range 1..23.** The SEED/KEY nonce must be in this inclusive
   range. Zero and values ≥ 24 produce undefined behaviour.

6. **`0xA1` is "pending", not an error.** Status `0xA1` means the
   operation is still in progress. The host re-issues the same request
   after a short delay; this is the *normal* polling pattern for erase
   and verify.

7. **Reads are unauthenticated on MS-family ECUs.** A complete firmware
   backup can be made from a stock ECU without ever performing a
   SEED/KEY exchange. The auth gate only fires on operations that
   *modify* flash. Other ECU families may differ — verify per-target.

8. **`0xFF` skip is a write-side optimisation only.** Memory reads pull
   every byte unconditionally. A read-then-write differ comparing
   source images must include all `0xFF` padding bytes in the source
   representation.

9. **Baud-rate switches are pre-programmed, not negotiated.** The 5-byte
   switch commands in §1.3 are sent at the *current* baud and both ends
   switch on success (`0xA0` response). Mid-programming baud changes
   are uncommon — once an erase / write session is underway, both ends
   typically stay at the chosen rate until disconnect.

10. **No keep-alive during long operations.** The ECU doesn't expect a
    "tester present" heartbeat during erase / write / verify. The host
    just retries the same operation on `0xA1`.

11. **Don't conflate framing with command set.** DS2 (§1) is universal
    BMW K-line framing — every DS2 ECU implements it. Within those
    frames, some CMD values are widely supported (§2 — IDENT, memory
    read), others are only recognised by programmable engine /
    transmission ECUs (§3 — SEED/KEY, erase / write / verify). Same
    framing layer, different per-ECU support for the command bytes.
    Sending `0x90 "BMW" …` to a cluster or body module won't do anything
    useful.

12. **Echo-verify the TX, don't just consume it.** The K-line echoes
    every TX byte back to the host (§1.4). A robust implementation
    reads the echo into a buffer the same length as the TX and
    `memcmp`s it against the TX bytes — a mismatch indicates bus
    contention, wiring fault, or another bus master interfering, all
    of which should abort the transaction rather than be swallowed
    silently. The MS4x Flasher does exactly this (TX → read-back
    same length → compare → throw on mismatch) and treats any echo
    discrepancy as a fatal serial-port error.

13. **Modified firmware images need their checksums recomputed.**
    See §5.4. The ECU's bootloader verifies internal CRCs after a
    write and rejects images that don't match. A flasher that
    accepts a raw BIN must recompute the CRC-16/CCITT(s) over the
    ranges declared in the BIN header and rewrite the result bytes
    before transmitting — there is no negotiation with the ECU
    about this; it's a property of the image itself. Pushing a BIN
    that's been edited without re-CRCing leaves the ECU bricked
    until a known-good image is reflashed.

14. **`.0PA` regions describe BMW's update slices via the DS2 path,
    not the ECU's writable space.** The ranges in §5 mirror what
    WinKFP chooses to write through DS2 (§3.4). Through DS2,
    neither known DS2 flasher writes outside its per-variant
    region table — BMW's host doesn't, and the MS4x Flasher uses
    its own (different but still sparse) hard-coded ranges in the
    protocol class (`/tmp/ms4x-decompiled/ᄁ/A/T.cs:360, 873`,
    `/tmp/ms4x-decompiled/ᄁ/A/p.cs:352`). Through bootmode (§7)
    the entire 512 KB *is* writable — see that section for why.

15. **Bootmode flashing is a different protocol entirely (§7).**
    DS2 (§1–§4) is what runs against the ECU's BMW firmware via
    the diagnostic session; "bootmode flashing" is the parallel
    universe where the host injects a custom RAM loader at
    power-on through the MCU's silicon BSL, after which the ECU
    no longer speaks DS2 at all. Don't conflate the two — they
    share neither the framing, nor the auth, nor the address
    table.

---

# §7 — Bootmode flashing (Infineon C167 BSL)

A second class of MS-family flashers exists that bypasses DS2
entirely. Instead of driving the ECU's BMW firmware through the
diagnostic session, these tools use the **Infineon C167 hardware
Bootstrap Loader (BSL)** — a mask-ROM routine baked into the MCU
silicon that runs at power-on instead of flash firmware when a BOOT
pin is grounded. The host uploads a small loader into internal RAM
via the C167's ASC0 serial port, the BSL jumps to it, and that
loader stages a larger monitor (a "MiniMon-style" overlay) that
exposes raw read / write / call-function primitives. Once the
overlay is running, the host calls into it to drive the flash
controller directly. There is no BMW firmware in the path, no DS2
framing, no SEED/KEY, and no region table — the full 512 KB is
addressable.

Applies to MCUs in the Infineon C16x / ST10 family:

- **MS42** (C167-class)
- **MS43** (C167-class)
- **ME 7.2** (Bosch, C167-class)
- Also other C16x ECUs of that era — Bosch ME7.x, Simos 3.x,
  EDC15VM/P+ etc.

This isn't a per-tool invention. The protocol is documented by
Infineon (BSL: AP16012; MiniMon overlay: AP16064) and the loaders
themselves are available as part of the public **MiniMon**
distribution (Christian Perschl, 1998-2004, distributed by Infineon
as freeware). At least one public open-source host implementation
exists — [EcuProg7/C167BootTool](https://github.com/EcuProg7/C167BootTool)
(`ME7BootTool.py`) — which is a useful reference for the host side.

References:

- Infineon **AP16012** — *C16x Bootstrap Loader* (silicon-level
  protocol spec)
- Infineon **AP16064** — *MiniMon* (V1.2, Sept 2007 — describes the
  MiniMon overlay)
- [MiniMon project page][minimon-home] (Christian Perschl — author's
  site, hosts the distribution and changelog)
- [MiniMon User Manual][minimon-manual] (PDF)
- [MiniMon project on SourceForge][minimon-sf] (binaries + kernels;
  ships four C16x kernels including the K-line variant)
- [EcuProg7/C167BootTool][c167boottool] (working open-source host
  implementation in Python — GPL v3)

[minimon-home]: http://www.perschl.at/minimon/
[minimon-manual]: http://www.perschl.at/minimon/minimon_usermanual.pdf
[minimon-sf]: https://sourceforge.net/projects/minimon/
[c167boottool]: https://github.com/EcuProg7/C167BootTool

## 7.1 When this applies — bench programming only

The ECU must be pulled from the vehicle. C167 BSL entry requires a
specific BOOT pin to be at logic level 0 at power-on reset; on the
BMW ECU PCB that pin is jumpered or pulled via a dedicated bench
harness, not exposed through the OBD-II connector. Typical bench
wiring for MS43 (other ECUs differ — consult the per-ECU pinout):

```
+12 V → [1]-7  and  [4]-26
GND   → [1]-4
K-line→ [4]-32
```

After power-up with the BOOT pin grounded, the C167 is in BSL,
listening on ASC0 (the same UART that K-line is wired to on these
ECUs) for the auto-baud calibration byte.

In-vehicle bootmode is not viable: the power-up sequence isn't
controllable, the BOOT pin isn't exposed, and the surrounding bus
traffic isn't quiet.

## 7.2 Wire format — not DS2

| | DS2 (§1–§4) | Bootmode (§7) |
|---|---|---|
| Framing | `[ADDR][LEN][CMD]...[XOR]` | Direct byte / `[CMD][payload]` (defined by the secondary loader) |
| Checksum | XOR over `[LEN]..last data` | None at the BSL/handshake layer |
| Echo | K-line natural half-duplex | K-line natural half-duplex |
| Echo verify | Implicit (§1.4) | Explicit byte-by-byte during the loader upload |
| Serial | 9 600 8E1 | 8N1, host-chosen baud — BSL auto-bauds |
| Address bytes | 24-bit big-endian per write | Loader-defined; no addressing in the handshake |
| Auth | SEED/KEY (§3.2) | None — loader runs from RAM, no firmware to gate |
| Region table | Per-variant sparse (§5) | None — full `0x00000–0x7FFFF` available |

## 7.3 Entry sequence

1. **Power on the bench-wired ECU with BOOT pin grounded.** The
   C167 mask ROM samples the BOOT pin at reset and enters BSL
   instead of jumping to flash. BSL listens on ASC0 for an
   auto-baud calibration byte. The host's serial port should be
   open at one of the standard rates BSL accepts (the MiniMon
   distribution covers 9 600 / 19 200 / 28 800 / 38 400 / 57 600
   / 115 200) with **8N1, no flow control**.

2. **Host sends `0x00`** and waits for the response.

   The `0x00` byte is the BSL's auto-baud reference: its bit
   pattern `0 00000000 1` (start bit + 8 zero bits + stop bit)
   lets the BSL measure the falling-edge-to-rising-edge time of
   exactly 9 bit-periods, calibrating its UART divider to
   whatever rate the host happens to be using.

3. **ECU responds with the BSL identification byte.**

   This byte encodes the C16x derivative on the wire (so the host
   can pick the right primary loader for the chip's RAM layout
   and SFR map). Observed values include `0xC5` on the C167CR
   variant used in MS42/MS43, and `0xAA` on the C167 variants used
   in ME7 / Simos 3.x. AP16012 / the C167 user manual lists the
   full table per derivative.

   Any other value means the BOOT pin isn't asserted at reset, the
   K-line wiring is wrong, or the ECU is the wrong family.

4. **Host uploads a 32-byte primary loader, byte-by-byte with echo
   verification.**

   The C167 BSL hard-codes **exactly 32 bytes**: it allocates 32
   bytes at the top of internal RAM, fills them from ASC0, then
   jumps to that buffer. Anything past 32 bytes is the primary
   loader's responsibility, not the BSL's.

   This stage cannot be skipped, and the 32-byte cap is silicon —
   there is no way to upload a larger image in one step. The
   primary loader's only job is to receive the secondary loader and
   transfer control to it.

5. **The primary loader stages the secondary loader.**

   Once running from RAM, the primary loader reads further bytes
   from ASC0 and writes them into a larger RAM region. When it
   has the complete secondary image, it jumps to the secondary's
   entry point.

   The secondary is the actual monitor — a small RAM-resident
   program that implements the command protocol the host will use
   for read / write / call-function operations. The MiniMon
   distribution provides ready-made primary and secondary binaries
   under the names `LOADK.bin` (32 bytes, primary, K-line variant)
   and `MINIMONK.bin` (~394 bytes, secondary, K-line variant — the
   "K" suffix is the K-line variant of the kernel).

6. **Secondary signals ready, ECU is now under loader control.**

   The exact "ready" byte and the staging acknowledge bytes between
   primary and secondary are loader-specific. MiniMon's
   convention: `I_LOADER_STARTED = 0x01` after the primary jumps,
   `I_APPLICATION_STARTED = 0x03` after the secondary takes over.
   A different secondary loader can use any byte.

   After this point the ECU is **running the uploaded code**, not
   BMW firmware. Subsequent host traffic uses whatever protocol the
   secondary loader implements.

## 7.4 Post-handshake — secondary loader command set

Once the secondary loader is running, the wire format is whatever
the loader implements. There is no shared standard here — the
secondary is arbitrary code chosen by the tool author. Two
different bootmode flashers can both correctly bring an ECU into
loader-controlled state and then speak completely incompatible
protocols after that, because they uploaded different secondaries.

The **MiniMon** monitor is the public reference. Its primitive
command set (as used by C167BootTool):

| Cmd | Name | Payload after CMD |
|---|---|---|
| `0x82` | `C_WRITE_WORD` | addr (LE) + word (LE) |
| `0xCD` | `C_READ_WORD` | addr (LE) → ECU returns word |
| `0x84` | `C_WRITE_BLOCK` | addr (LE) + len (LE) + data |
| `0x85` | `C_READ_BLOCK` | addr (LE) + len (LE) → ECU returns block |
| `0x9F` | `C_CALL_FUNCTION` | 8 register words (R0..R7) + function address |
| `0x33` | `C_GETCHECKSUM` | addr (LE) + len (LE) |

Each command is acknowledged with `A_ACK1 = 0xAA` after the CMD
byte and `A_ACK2 = 0xEA` after the payload.

Flash erase / program is **not** a MiniMon primitive — MiniMon
doesn't know the layout of any specific flash controller. Instead
the host uploads a small **flash driver** into RAM via
`C_WRITE_BLOCK`, then calls into it with `C_CALL_FUNCTION`,
passing a flash sub-command in a register:

| FC | Action |
|---|---|
| `0x00` | program flash |
| `0x01` | erase sector |
| `0x06` | read manufacturer / device ID |
| `0x11` | unlock flash bank |

The flash driver is per-flash-chip (AMD 29F800, ST M29F400, etc.).
MiniMon's distribution and forks ship a small library of
pre-built drivers; the `.ini` file in C167BootTool references
`A29F800b.hex` as the driver for that particular ECU's external
flash.

A tool not based on MiniMon ships its own secondary loader binary
and its own command vocabulary. The architectural pattern
(thin RAM monitor exposing read / write / call-function, with
chip-specific flash logic uploaded separately or baked into the
secondary) is what's universal.

## 7.5 Why the full 512 KB is writable here

The C167 mask-ROM BSL is independent of flash contents — it's
silicon, not firmware. When the BOOT pin is grounded at reset the
MCU enters BSL unconditionally; the secondary loader the host
uploads runs from RAM and can drive the C167's flash controller
registers directly, with no protection bit checks except those
imposed by the flash controller itself (and on the C167 those are
trivially writable from the same RAM execution context).

The DS2 region gating in §5 / §6 (gotcha #13) is enforced by
**BMW's firmware** running on the C167 — bypass the firmware (by
booting into BSL instead of into flash) and the gating goes with
it. The flash controller has always been able to write the whole
512 KB; the DS2 path just doesn't expose that capability.

This is also why this approach **recovers a bricked ECU**: even
with flash erased or integrity flags clear, the BSL still answers
the power-on entry sequence. DS2 is unreachable from that state
because there's no firmware to host it; bootmode is the only path.

## 7.6 What it does NOT give you

- **In-vehicle flashing**: not possible. The BOOT pin isn't routed
  to the OBD-II connector, power-up timing isn't controllable, and
  EWS pairing / surrounding K-line traffic break the BSL sync byte.
- **A universal post-handshake protocol.** The 32-byte primary
  loader is constrained by the C167 silicon and is essentially
  identical across tools (the BSL hard-codes the 32-byte cap). The
  secondary loader and its command set, however, are picked by the
  host author — MiniMon is one well-documented choice; other tools
  ship their own. There's no expectation that two bootmode tools
  speak the same post-handshake protocol — you have to know which
  loader is in use.
- **Bootmode for non-C16x ECUs.** Other BMW ECU MCUs (M3/M5 in IKE
  clusters, MAC7242 in CAS, the Tricore-based later ECUs like
  MSV80 / MEV17 / N-series, etc.) have their own BSLs with
  different entry sequences, different ASC0 equivalents, and
  different primary-loader sizes. The C167 32-byte / BOOT-pin
  pattern documented here applies specifically to MS42, MS43,
  ME 7.2, and other C16x / ST10 ECUs of that era.

## 7.7 Caveats

- The BSL identification byte (step 3) is per-MCU-derivative, not
  per-tool. The C167CR used in MS42/MS43 returns `0xC5`; the C167
  variants in ME7 return `0xAA`; other C16x parts return other
  values per AP16012. A host must either know the target up front
  or branch on the id byte.
- Baud rate is host-chosen (BSL auto-bauds from the `0x00`
  calibration byte). Cable / interface limits apply — many K-line
  adapters won't reach 115 200 reliably.
- "Bootmode flashing works" depends on having a correct primary +
  secondary loader pair for the target's RAM map. The MiniMon
  K-line kernel works for the MS42 / MS43 / ME 7.2-class C167CR;
  earlier or later C16x derivatives may need a different MiniMon
  kernel (the distribution ships four for C16x and four for
  XC16x).

---

# Appendix — minimal sequences

## A.1 Read identity from any DS2 ECU

```
1. Open serial port @ 9 600 8E1, no handshake
2. TX  [ADDR] 04 00 [XOR]                              ; IDENT
   RX  [ADDR] LEN A0 ... [XOR]
3. Close serial port.
```

## A.2 Dump firmware from an MS-family ECU

```
1. Open serial port @ 9 600 8E1, no handshake
2. TX  [ADDR] 04 00 [XOR]                              ; IDENT (optional)
   RX  [ADDR] LEN A0 ... [XOR]

3. For each block of the region to dump:
     TX  [ADDR] LEN 06 AH AM AL SIZE [XOR]
     RX  [ADDR] (SIZE+4) A0 DATA[0..SIZE-1] [XOR]
     Append DATA to output buffer; advance address by SIZE.

4. Close serial port.
```

(No authentication required.)

## A.3 Full flash of an MS-family ECU

```
1. Open serial port @ 9 600 8E1, no handshake
2. TX  [ADDR] 04 00 [XOR]                              ; IDENT
   RX  [ADDR] LEN A0 ... [XOR]                         ; LEN ≥ 45

3. TX  [ADDR] 07 90 42 4D 57 NONCE [XOR]               ; seed request
   RX  [ADDR] 2E A0 seed[0..42] [XOR]                  ; NONCE ∈ 1..23

4. Derive KEY[0..3] from seed + NONCE (see §3.2 step 3)

5. TX  [ADDR] 06 K0 K1 K2 K3 [XOR]                     ; submit key
   RX  [ADDR] 05 A0 . [XOR]

6. TX  [ADDR] 08 07 06 00 00 00 00 [XOR]               ; erase @ 0x000000
   RX  poll until [ADDR] 09 A0 ... 01 [XOR]

7. For each block in firmware image:
     TX  [ADDR] LEN 07 02 AH AM AL SIZE DATA[0..SIZE-1] [XOR]
     RX  [ADDR] LEN A0 ... 01 [XOR]

8. TX  [ADDR] 08 07 0F 00 00 00 00 [XOR]               ; verify @ 0x000000
   RX  poll until [ADDR] LEN A0 ... 01 [XOR]

9. Close serial port.
```
