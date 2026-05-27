# First real-bench flash — operator runbook

Read this end-to-end **before** running `nfsx flash --write`. The
flash is destructive; a failure mid-transfer bricks the ECU. We
have no host-side firmware backup (BMW's design — see
`architecture.md` §11.6).

> **Status (2026-05-27):** first real bench flash attempted on GS20.
> Pipeline runs end-to-end; bytes go over the wire (~36 s of binary-
> path traffic), but the SGBD rejects most `FLASH_SCHREIBEN` calls
> with `ERROR_INVALID_BIN_BUFFER` because our firmware-source emits
> raw payload bytes instead of framed records. ECU survived unchanged
> (erase failed → old firmware intact). See `architecture.md` §11.11
> for the full post-mortem; the framing fix is tracked as task #246.
> **Do not expect a successful flash until that's resolved.**

---

## Pre-flight checklist

Every box must be ✓ before `--write`.

- [ ] **Bench ECU power.** Use a regulated 12-13.8 V bench supply
      capable of sustained 5 A. Falling below 12 V mid-flash will
      brick the ECU. K+DCAN adapter draws from the ECU side; budget
      for that on the supply.
- [ ] **K+DCAN cable connected** to the bench harness.
      `/dev/cu.usbserial-A50285BI` per the user's config — confirm
      with `ls /dev/cu.usbserial-*`.
- [ ] **`~/.config/ediabasx/config.json` set to `kdcan` interface**
      with the right serial port + baud 9600.
- [ ] **SP-Daten on disk** at the configured `--sp-daten` path.
      Default: `~/Downloads/E46_v74`.
- [ ] **Target firmware files on disk** at
      `<sp-daten>/data/<SG_TYP>/`. See "Firmware decision" below.
- [ ] **`nfsx plan --hwnr <HWNR>`** resolves cleanly — SG_TYP,
      KFCONF row, and at least one ZB row visible in the output.
- [ ] **`nfsx verify --hwnr <HWNR>`** against the bench reports a
      sane kennung + projekt (matches the firmware's `$REFERENZ`
      header).
- [ ] **`nfsx flash --hwnr <HWNR> --zb <ZB>`** (dry-run, the
      default) completes through all 5 stages. RESOLVE parses
      the firmware without skipped lines or bad checksums.
      PRECHECK passes. BACKUP writes a non-empty JSON.
- [ ] **No other CAN traffic** on the bus while the flash runs.
      WinKFP requires this; we mirror.
- [ ] **Bricking budget accepted.** This is a spare ECU. Worst-case
      recovery is replacement.

---

## What `nfsx flash --write` actually does

1. **RESOLVE** — parses the `.0PA` (Intel-HEX dialect with BMW
   wrapper). Splits into memory regions. Fast, fail-loud on bad
   checksums. No bus traffic.
2. **PRECHECK** — dispatches `HW_REFERENZ` + `SG_STATUS_LESEN` +
   `SG_IDENT_LESEN` + `SG_AIF_LESEN` + `ZIF_BACKUP` via the target
   SG's IPO + runs the `FscManager.checkFsc` flow via the SWT IPO.
   Read-only. ~3-5 seconds against a real K+DCAN GS20.
3. **BACKUP** — captures the precheck cabd-pars to
   `<output-dir>/<HWNR>-<ZB>-<timestamp>.json`. **NOT** a firmware
   dump.
4. **PROGRAM** *(destructive — gated by `confirm`)* — dispatches
   `SG_PROGRAMMIEREN`. The IPO's flash loop:
   - reads `BLOCKLAENGE_MAX_WERT` from the SGBD
   - runs `SEED_KEY` (security access)
   - dispatches `FLASH_LOESCHEN` (erase)
   - in a `while (NrOfData > 0)` loop, dispatches
     `FLASH_SCHREIBEN` per chunk popped from the host's firmware
     source (one record per call)
   - dispatches `FLASH_SCHREIBEN_ENDE` (verify)
   - optional `STATUS_CODIER_CHECKSUMME` check (if
     `TEST_CHECKSUMME=ON`)
5. **POSTCHECK** — re-runs `HW_REFERENZ` to verify the ECU still
   answers. Fail-soft (logs warning, doesn't abort the result).

Estimated wall time at K+DCAN 9600 baud:
- 262 KB firmware @ 256-byte blocks → 1024 × FLASH_SCHREIBEN
- Each block: ~3-5 ms protocol overhead + bytes
- Total: ~5-10 minutes for PROGRAM stage alone (excludes
  PRECHECK / BACKUP)

---

## Firmware decision

The bench ECU (HWNR 7544721) currently has burned:
- `ID_BMW_NR = 7544721` (matches HWNR)
- `AIF_ZB_NR = 7543058` *(NOT in current SP-Daten — superseded)*
- `AIF_SW_NR = 7543059` *(NOT in current SP-Daten)*
- `$REFERENZ = G2210_0089D0`

SP-Daten `GD20.DAT` has two ZB candidates for HWNR 7544721:

| ZB        | Program file          | Data file        | CS |
|-----------|-----------------------|------------------|----|
| `7552752` | `7544721A.0PA`        | `A7552753.0DA`   | G  |
| `7552754` | `7544721A.0PA`        | `A7552755.0DA`   | S  |

Both program files are identical (same `7544721A.0PA`). Only the
data (calibration) differs. Both ZBs are **newer** than the
bench's current `7543058`.

### Recommended first-flash target

**`7544721A.0PA` only — no `.0DA`.** Rationale:

- The `.0PA` reference (`G2210_0089D0`) matches what's already
  burned. Re-flashing the same program area is the **lowest-risk
  destructive test** — on success, the ECU's state is unchanged.
- Skipping the `.0DA` flash preserves the existing calibration
  data on the ECU (the irreversible part — we don't have the
  current `7543058` `.0DA` in SP-Daten so we couldn't restore it).
- Validates the entire wire-level path end-to-end without
  committing to a state change.

Risk: a failure mid-program-erase means we wiped the program area
and didn't rewrite it cleanly. The ECU's bootloader would survive
(separate flash region not touched by `FLASH_LOESCHEN`), so
recovery via WinKFP from a Windows machine + the same `.0PA`
should be possible. Not via our toolchain (yet).

### Command

```bash
nfsx flash --hwnr 7544721 --zb 7552752 --write
```

`--hwnr` resolves the target IPO, SGBD, SWT IPO, working dir, and
the firmware `.0PA` from SP-Daten. `--zb 7552752` disambiguates
between the two ZB candidates for this HWNR (use `nfsx plan
--hwnr 7544721` to list them); 7552752 has the CS=G "Gelb"
(standard) flag — for a first re-flash this is the safer pick
since its program file (`7544721A.0PA`) is identical to ZB
7552754's, and the calibration `.0DA` is not part of the
recommended re-flash payload.

Note: omit `--yes`. The confirm prompt requires typing literally
`FLASH` (case-sensitive) to proceed — deliberate friction. The
prompt shows the full pre-flash summary.

If you want to skip BACKUP or POSTCHECK, pass `--no-backup` or
`--no-verify` respectively. Both are enabled by default.

---

## During the flash

- **Do not touch the bench**. No power-cycling, no unplugging the
  cable, no resetting the workstation.
- **Watch the terminal**. Per-stage progress + per-block trace
  appears on stderr. A long pause is normal (each block ~3-5 ms).
- **Power supply current draw** spikes during `FLASH_SCHREIBEN`
  bursts. If your supply current-limits, the ECU resets mid-write
  → brick.

---

## Failure modes

| Symptom                                | Likely cause | Action |
|----------------------------------------|--------------|--------|
| PRECHECK fails at `hw_referenz`        | bus down / wrong baud / cable issue | re-check K+DCAN + power; do NOT proceed |
| PRECHECK fails at `hwnr_match`         | wrong ECU connected | abort; verify physically |
| PRECHECK fails at `fsc`                | FSC table mismatch / wrong SWT IPO | re-check SP-Daten freshness |
| PROGRAM aborts during `FLASH_LOESCHEN` | security access (seed/key) rejected | seed/key strategy may need updating; ECU likely still bootable |
| PROGRAM aborts during `FLASH_SCHREIBEN` (early blocks) | power dropout, bus error | brick risk HIGH — ECU's program area partially erased |
| PROGRAM aborts during `FLASH_SCHREIBEN_ENDE` | final-block verify failed | ECU may be flashed but checksum-invalid; reboot behavior unknown |
| POSTCHECK warns "HW_REFERENZ failed"   | ECU didn't come back after reset | wait 30s + retry HW_REFERENZ manually; if no answer, brick |

---

## Recovery options (limited)

1. **Re-flash via this same tool, same firmware**. If the ECU's
   bootloader survives, repeating the flash should write a clean
   program area on the second pass. The bootloader is in a
   separate flash region from the application program and is not
   touched by `FLASH_LOESCHEN` (per BMW's flash partitioning).
2. **WinKFP from a Windows VM**. Same firmware file + dealer
   workflow. Confirmed working tool, mature recovery path.
3. **Replace the ECU.** Sourced as a salvage part; the bench was
   built knowing this might happen.

The current `nfsx backup` JSON snapshot helps re-stamp identity
(VIN, dealer codes, dates) via `SG_AIF_SCHREIBEN` after recovery
— but does NOT restore firmware.

---

## Post-flash verification

After a successful PROGRAM + POSTCHECK, diff against the pre-flash
backup the BACKUP stage just wrote:

```bash
nfsx verify --hwnr 7544721 --against ./backups/<latest>.json
```

Expected: `HW_REF_SG_KENNUNG = G22`, `HW_REF_PROJEKT = 10_00`,
`ID_BMW_NR = 7544721`. AIF block should match pre-flash (we did
NOT flash a new AIF). If `AIF_ZB_NR` changed unexpectedly, the
flash may have stamped a new AIF inadvertently — investigate.

---

## Decision: pull the trigger?

This is the user's call. The runbook documents what we know; the
risks are real but bounded by the bench bricking budget.
