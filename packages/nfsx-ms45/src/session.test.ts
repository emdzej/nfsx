import { describe, it, expect } from 'vitest';
import { MockIEdiabas, buildResponse } from './mock-ediabas.js';
import { probe, readFlash, writeFlash, Ms45SessionError } from './session.js';
import type { AuthRandomSource } from './auth-flow.js';
import {
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  TUNE_BLOB_SIZE,
  PROGRAM_BLOB_HOST_OFFSET,
  PROGRAM_BLOB_SIZE,
  PARAM_CRC_STORED_OFFSET,
  PARAM_SIG_SEGMENT_COUNT_OFFSET,
  PARAM_SIG_SEGMENT_STARTS_OFFSET,
  PARAM_SIG_SEGMENT_LENGTHS_OFFSET,
  PARAM_SIG_SEGMENT_BASE,
  PARAM_SIG_STORED_OFFSET,
  PARAM_SIG_LENGTH,
  PARAM_CRC_SEGMENT_TABLE_OFFSET,
  PARAM_CRC_INITIAL_OFFSET,
  PARAM_CRC_SEGMENT_BASE,
  PROG_SIG_SEGMENT_COUNT_OFFSET,
  PROG_SIG_SEGMENT_STARTS_OFFSET,
  PROG_SIG_SEGMENT_LENGTHS_OFFSET,
  PROG_CRC_PRIMARY_INITIAL_OFFSET,
  PROG_CRC_PRIMARY_SEG1_START_OFFSET,
  PROG_CRC_PRIMARY_SEG1_END_OFFSET,
  PROG_CRC_PRIMARY_SEG2_START_OFFSET,
  PROG_CRC_PRIMARY_SEG2_END_OFFSET,
  PROG_CRC_SECONDARY_INITIAL_OFFSET,
  PROG_CRC_SECONDARY_SEG1_START_OFFSET,
  PROG_CRC_SECONDARY_SEG1_END_OFFSET,
  PROG_CRC_SECONDARY_SEG2_START_OFFSET,
  PROG_CRC_SECONDARY_SEG2_END_OFFSET,
  writeU32BE,
  HW_REF_MS45_0,
  HW_REF_MS45_1,
} from './regions.js';
import { verifyParameterChecksum, verifyProgramChecksum } from './checksum.js';
import { verifyParameterSignature, verifyProgramSignature } from './signature.js';

// ── mock construction ──────────────────────────────────────────────

const fixedRandom = (bytes: Uint8Array): AuthRandomSource => ({
  userID: () => new Uint8Array(bytes),
});

function registerIdent(m: MockIEdiabas, variant: 'MS45.0' | 'MS45.1'): void {
  const isFast = variant === 'MS45.1';
  m.setResults('aif_lesen', { AIF_FG_NR: 'WBANE710X0CZ12345' });
  m.setResults('hardware_referenz_lesen', {
    HARDWARE_REFERENZ: isFast ? HW_REF_MS45_1 : HW_REF_MS45_0,
  });
  m.setResults('daten_referenz_lesen', { DATEN_REFERENZ: '7566178' });
  m.setResults('flash_programmier_status_lesen', {
    FLASH_PROGRAMMIER_STATUS_TEXT: 'idle',
  });
  m.setResults('DIAGNOSEPROTOKOLL_LESEN', {
    DIAG_PROT_IST: isFast ? 'BMW-FAST' : 'DS2',
  });
}

function registerAuth(m: MockIEdiabas): void {
  m.setResults('seriennummer_lesen', {
    _TEL_ANTWORT: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0xff]),
  });
  m.setResults('authentisierung_zufallszahl_lesen', {
    ZUFALLSZAHL: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
  });
  m.setResults('authentisierung_start', {});
}

function registerSessionControl(m: MockIEdiabas): void {
  m.setResults('diagnose_mode', {});
  m.setResults('SET_PARAMETER', {});
  m.setResults('ACCESS_TIMING_PARAMETER', {});
  m.setResults('normaler_datenverkehr', {});
}

function registerFlashJobs(m: MockIEdiabas): void {
  m.setResults('flash_loeschen', {});
  m.setResults('flash_schreiben_adresse', {});
  m.setResults('flash_schreiben', {});
  m.setResults('flash_schreiben_ende', {});
  m.setResults('FLASH_SIGNATUR_PRUEFEN', {});
  m.setResults('FLASH_PROGRAMMIER_STATUS_LESEN', {
    FLASH_PROGRAMMIER_STATUS_TEXT: 'Programmierung erfolgreich',
  });
  m.setResults('STEUERGERAETE_RESET', {});
}

function registerReadHandler(m: MockIEdiabas): void {
  // Wildcard responder parses the "SEGMENT;START;LEN" arg and returns
  // LEN placeholder bytes.
  m.setResponse('speicher_lesen_ascii', undefined, (arg) => {
    const parts = (arg as string).split(';');
    const len = Number.parseInt(parts[2]!, 10);
    return buildResponse({ DATEN: new Uint8Array(len) });
  });
}

function happyMs451(m: MockIEdiabas): void {
  registerIdent(m, 'MS45.1');
  registerAuth(m);
  registerSessionControl(m);
  registerFlashJobs(m);
  registerReadHandler(m);
}

function happyMs450(m: MockIEdiabas): void {
  registerIdent(m, 'MS45.0');
  registerAuth(m);
  registerSessionControl(m);
  registerFlashJobs(m);
  registerReadHandler(m);
}

// ── helpers to build payloads with a signable segment header ───────
//
// The write path recomputes CRC + RSA over the parameter/program
// segments listed in the header. Give the mock inputs a valid single
// segment so the recompute has something coherent to hash.

function makeTunePayload(): Uint8Array {
  const blob = new Uint8Array(TUNE_BLOB_SIZE);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 11 + 3) & 0xff;
  // Signed-segment table: one segment, host 0x1000..0x1FFF.
  writeU32BE(blob, 1, PARAM_SIG_SEGMENT_COUNT_OFFSET);
  writeU32BE(blob, PARAM_SIG_SEGMENT_BASE + 0x1000, PARAM_SIG_SEGMENT_STARTS_OFFSET);
  writeU32BE(blob, 0x1000, PARAM_SIG_SEGMENT_LENGTHS_OFFSET);
  // CRC-segment table: one segment host 0x2000..0x20FF.
  writeU32BE(blob, 1, PARAM_CRC_SEGMENT_TABLE_OFFSET);
  writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x2000, PARAM_CRC_SEGMENT_TABLE_OFFSET + 4);
  writeU32BE(blob, PARAM_CRC_SEGMENT_BASE + 0x20ff, PARAM_CRC_SEGMENT_TABLE_OFFSET + 8);
  writeU32BE(blob, 0xffffffff, PARAM_CRC_INITIAL_OFFSET);
  return blob;
}

function makeFullPayload(): { external: Uint8Array; mpc: Uint8Array } {
  const external = new Uint8Array(EXTERNAL_FLASH_SIZE);
  for (let i = 0; i < external.length; i++) external[i] = (i * 7 + 1) & 0xff;
  const mpc = new Uint8Array(MPC_FLASH_SIZE);
  for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 13 + 5) & 0xff;

  // Program signed segments: one in MPC, one in external — well
  // clear of the header at 0x60000..0x604B0.
  writeU32BE(external, 2, PROG_SIG_SEGMENT_COUNT_OFFSET);
  writeU32BE(external, 0x00001000, PROG_SIG_SEGMENT_STARTS_OFFSET + 0);
  writeU32BE(external, 0xfff80000, PROG_SIG_SEGMENT_STARTS_OFFSET + 8);
  writeU32BE(external, 0x100, PROG_SIG_SEGMENT_LENGTHS_OFFSET + 0);
  writeU32BE(external, 0x200, PROG_SIG_SEGMENT_LENGTHS_OFFSET + 4);

  // Program CRC (primary + secondary): same two segments, but
  // as (start, end) pairs in ECU-space with no base subtraction.
  const seg1Start = 0x00001000;
  const seg1End = 0x000010ff;
  const seg2Start = 0xfff80000;
  const seg2End = 0xfff801ff;

  writeU32BE(external, 0xffffffff, PROG_CRC_PRIMARY_INITIAL_OFFSET);
  writeU32BE(external, seg1Start, PROG_CRC_PRIMARY_SEG1_START_OFFSET);
  writeU32BE(external, seg1End, PROG_CRC_PRIMARY_SEG1_END_OFFSET);
  writeU32BE(external, seg2Start, PROG_CRC_PRIMARY_SEG2_START_OFFSET);
  writeU32BE(external, seg2End, PROG_CRC_PRIMARY_SEG2_END_OFFSET);

  writeU32BE(external, 0xffffffff, PROG_CRC_SECONDARY_INITIAL_OFFSET);
  writeU32BE(external, seg1Start, PROG_CRC_SECONDARY_SEG1_START_OFFSET);
  writeU32BE(external, seg1End, PROG_CRC_SECONDARY_SEG1_END_OFFSET);
  writeU32BE(external, seg2Start, PROG_CRC_SECONDARY_SEG2_START_OFFSET);
  writeU32BE(external, seg2End, PROG_CRC_SECONDARY_SEG2_END_OFFSET);

  return { external, mpc };
}

// ── tests ──────────────────────────────────────────────────────────

describe('probe', () => {
  it('returns the identity for an MS45.1 DME', async () => {
    const m = new MockIEdiabas();
    registerIdent(m, 'MS45.1');
    const ident = await probe({ ediabas: m, sgbd: 'D_Motor' });
    expect(ident.variant).toBe('MS45.1');
    expect(ident.diagProtocol).toBe('BMW-FAST');
  });
});

describe('readFlash tune (BMW-FAST)', () => {
  it('runs ident → auth → progmode → read → leave choreography', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);

    const result = await readFlash(
      {
        ediabas: m,
        sgbd: 'D_Motor',
        random: fixedRandom(new Uint8Array([1, 2, 3, 4])),
      },
      { mode: 'tune' },
    );

    expect(result.mode).toBe('tune');
    if (result.mode !== 'tune') throw new Error('mode narrowing');
    expect(result.tune.length).toBe(TUNE_BLOB_SIZE);

    const seq = m.calls.map((c) => c.job);
    // Ident (5 jobs) then auth (3) then progmode (1) then N reads then leave (2).
    expect(seq.slice(0, 5)).toEqual([
      'aif_lesen',
      'hardware_referenz_lesen',
      'daten_referenz_lesen',
      'flash_programmier_status_lesen',
      'DIAGNOSEPROTOKOLL_LESEN',
    ]);
    expect(seq.slice(5, 8)).toEqual([
      'seriennummer_lesen',
      'authentisierung_zufallszahl_lesen',
      'authentisierung_start',
    ]);
    expect(seq[8]).toBe('diagnose_mode'); // ECUPM
    // Last two jobs: leave-progmode on BMW-FAST is diagnose_mode DEFAULT + normaler_datenverkehr.
    expect(seq.slice(-2)).toEqual(['diagnose_mode', 'normaler_datenverkehr']);
    // Every read chunk in between.
    const readCount = seq.filter((j) => j === 'speicher_lesen_ascii').length;
    expect(readCount).toBeGreaterThan(0);
    // 0x1D000 bytes / 0xFE per chunk = 466.5 → 467 chunks.
    expect(readCount).toBe(Math.ceil(TUNE_BLOB_SIZE / 254));
  });
});

describe('readFlash tune (DS2, MS45.0)', () => {
  it('runs the 4-step baud raise before reading', async () => {
    const m = new MockIEdiabas();
    happyMs450(m);
    await readFlash(
      {
        ediabas: m,
        sgbd: 'D_Motor',
        random: fixedRandom(new Uint8Array([1, 2, 3, 4])),
      },
      { mode: 'tune' },
    );
    const seq = m.calls.map((c) => `${c.job}:${describeArg(c.arg)}`);
    // After auth: 4 progmode-entry jobs, ending before the reads.
    const authIdx = seq.findIndex((s) => s.startsWith('authentisierung_start'));
    expect(seq.slice(authIdx + 1, authIdx + 5)).toEqual([
      'diagnose_mode:"ECUPM;PC115200"',
      'SET_PARAMETER:";115200"',
      'ACCESS_TIMING_PARAMETER:"00;120;24;240;00"',
      'SET_PARAMETER:";115200;;15"',
    ]);
    // Teardown at the end: baud down.
    expect(seq.slice(-2)).toEqual([
      'diagnose_mode:"DEFAULT;PC9600"',
      'SET_PARAMETER:";9600"',
    ]);
  });
});

describe('writeFlash tune (BMW-FAST)', () => {
  it('runs the full write choreography and refuses non-canonical payload sizes', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    const tune = makeTunePayload();

    const result = await writeFlash(
      {
        ediabas: m,
        sgbd: 'D_Motor',
        random: fixedRandom(new Uint8Array([1, 2, 3, 4])),
      },
      { mode: 'tune', tune },
    );

    expect(result.ident.variant).toBe('MS45.1');
    expect(result.programmingStatus).toBe('Programmierung erfolgreich');

    const seq = m.calls.map((c) => c.job);
    // Fixed sub-sequences we care about:
    //   ident (5) → auth (3) → progmode (1) → suspend-traffic (2)
    //   → erase (1) → open (1) → write × N → close (1)
    //   → leave (2) → status (1) → verify sig (1) → status (1) → reset (1)
    const eraseIdx = seq.indexOf('flash_loeschen');
    expect(eraseIdx).toBeGreaterThan(0);
    expect(seq[eraseIdx + 1]).toBe('flash_schreiben_adresse');
    const closeIdx = seq.indexOf('flash_schreiben_ende');
    expect(closeIdx).toBeGreaterThan(eraseIdx);
    expect(seq[closeIdx + 1]).toBe('diagnose_mode'); // leave progmode
    // Verify signature dispatched after leave.
    expect(seq.filter((s) => s === 'FLASH_SIGNATUR_PRUEFEN')).toHaveLength(1);
    expect(seq[seq.length - 1]).toBe('STEUERGERAETE_RESET');
    // Signature-verify arg == "Daten;64"
    const verifyCall = m.calls.find((c) => c.job === 'FLASH_SIGNATUR_PRUEFEN')!;
    expect(verifyCall.arg).toBe('Daten;64');
  });

  it('rejects tune payloads of the wrong size', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    await expect(
      writeFlash(
        { ediabas: m, sgbd: 'D_Motor', random: fixedRandom(new Uint8Array([1, 2, 3, 4])) },
        { mode: 'tune', tune: new Uint8Array(TUNE_BLOB_SIZE - 1) },
      ),
    ).rejects.toBeInstanceOf(Ms45SessionError);
    // No wire I/O should have happened.
    expect(m.calls).toHaveLength(0);
  });

  it('skipChecksum + skipSign leaves the payload bytes intact on the wire', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    const tune = makeTunePayload();

    // Snapshot the original bytes in the region the sig would touch.
    const originalSig = tune.slice(
      PARAM_SIG_STORED_OFFSET,
      PARAM_SIG_STORED_OFFSET + PARAM_SIG_LENGTH,
    );
    const originalCrc = tune.slice(PARAM_CRC_STORED_OFFSET, PARAM_CRC_STORED_OFFSET + 4);

    await writeFlash(
      { ediabas: m, sgbd: 'D_Motor', random: fixedRandom(new Uint8Array([1, 2, 3, 4])) },
      { mode: 'tune', tune, skipChecksum: true, skipSign: true, skipVerify: true },
    );

    // Reconstruct the payload the DME saw from the flash_schreiben frames.
    const reassembled = reassembleFlashPayload(m, TUNE_BLOB_SIZE);
    expect(Array.from(reassembled.slice(PARAM_SIG_STORED_OFFSET, PARAM_SIG_STORED_OFFSET + PARAM_SIG_LENGTH))).toEqual(
      Array.from(originalSig),
    );
    expect(Array.from(reassembled.slice(PARAM_CRC_STORED_OFFSET, PARAM_CRC_STORED_OFFSET + 4))).toEqual(
      Array.from(originalCrc),
    );
    // No FLASH_SIGNATUR_PRUEFEN when skipVerify is set.
    expect(m.calls.some((c) => c.job === 'FLASH_SIGNATUR_PRUEFEN')).toBe(false);
  });

  it('default flags recompute a valid CRC + signature over the payload the DME sees', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    const tune = makeTunePayload();

    await writeFlash(
      { ediabas: m, sgbd: 'D_Motor', random: fixedRandom(new Uint8Array([1, 2, 3, 4])) },
      { mode: 'tune', tune },
    );

    const reassembled = reassembleFlashPayload(m, TUNE_BLOB_SIZE);
    expect(verifyParameterChecksum(reassembled).ok).toBe(true);
    expect(verifyParameterSignature(reassembled).ok).toBe(true);
  });
});

describe('writeFlash full (BMW-FAST)', () => {
  it('writes external + MPC in order and dispatches Programm;64 verify', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    const { external, mpc } = makeFullPayload();

    await writeFlash(
      { ediabas: m, sgbd: 'D_Motor', random: fixedRandom(new Uint8Array([1, 2, 3, 4])) },
      { mode: 'full', external, mpc },
    );

    const seq = m.calls.map((c) => c.job);
    const eraseIdx = seq.indexOf('flash_loeschen');
    // Erase then TWO flash_schreiben_adresse (external + MPC).
    const openIndices = seq.reduce<number[]>((acc, job, i) => {
      if (job === 'flash_schreiben_adresse') acc.push(i);
      return acc;
    }, []);
    expect(openIndices.length).toBe(2);
    expect(openIndices[0]!).toBeGreaterThan(eraseIdx);

    const verifyCall = m.calls.find((c) => c.job === 'FLASH_SIGNATUR_PRUEFEN')!;
    expect(verifyCall.arg).toBe('Programm;64');
  });

  it('rejects full payloads of the wrong sizes', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    await expect(
      writeFlash(
        { ediabas: m, sgbd: 'D_Motor', random: fixedRandom(new Uint8Array([1, 2, 3, 4])) },
        {
          mode: 'full',
          external: new Uint8Array(EXTERNAL_FLASH_SIZE - 1),
          mpc: new Uint8Array(MPC_FLASH_SIZE),
        },
      ),
    ).rejects.toBeInstanceOf(Ms45SessionError);
  });

  it('default flags produce valid program checksum + signature on the wire', async () => {
    const m = new MockIEdiabas();
    happyMs451(m);
    const { external, mpc } = makeFullPayload();

    await writeFlash(
      { ediabas: m, sgbd: 'D_Motor', random: fixedRandom(new Uint8Array([1, 2, 3, 4])) },
      { mode: 'full', external, mpc },
    );

    // Reconstruct the external+MPC bytes the DME received.
    // External is only PARTIALLY reflashed — the flash_schreiben slice is
    // external.subarray(PROGRAM_BLOB_HOST_OFFSET, +PROGRAM_BLOB_SIZE) —
    // so patch the reassembled slice back into a copy of the source
    // external buffer to reconstruct the DME's view.
    const dmeExternal = new Uint8Array(external);
    const programWrittenBytes = reassembleFlashPayloadForBlock(
      m,
      0,
      PROGRAM_BLOB_SIZE,
    );
    dmeExternal.set(programWrittenBytes, PROGRAM_BLOB_HOST_OFFSET);
    const dmeMpc = reassembleFlashPayloadForBlock(m, 1, MPC_FLASH_SIZE);

    expect(verifyProgramChecksum(dmeExternal, dmeMpc).ok).toBe(true);
    expect(verifyProgramSignature(dmeExternal, dmeMpc).ok).toBe(true);
  });
});

// ── helpers ────────────────────────────────────────────────────────

function describeArg(arg: unknown): string {
  if (typeof arg === 'string') return JSON.stringify(arg);
  if (arg instanceof Uint8Array) return `Uint8Array(${arg.length})`;
  return '<other>';
}

/**
 * Walk the mock call log, reassemble the bytes the DME received across
 * `flash_schreiben` calls between the LAST `flash_schreiben_adresse` and
 * the NEXT `flash_schreiben_ende`. Used to verify the exact bytes we
 * put on the wire.
 */
function reassembleFlashPayload(m: MockIEdiabas, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let offset = 0;
  let inBlock = false;
  for (const c of m.calls) {
    if (c.job === 'flash_schreiben_adresse') {
      inBlock = true;
      offset = 0;
      continue;
    }
    if (c.job === 'flash_schreiben_ende') {
      inBlock = false;
      continue;
    }
    if (!inBlock || c.job !== 'flash_schreiben') continue;
    const frame = c.arg as Uint8Array;
    const len = frame[13]!;
    out.set(frame.subarray(21, 21 + len), offset);
    offset += len;
  }
  return out;
}

/**
 * Reassemble the payload for the `blockIndex`-th flashBlock() call
 * (0 = external, 1 = MPC in full-mode writes).
 */
function reassembleFlashPayloadForBlock(
  m: MockIEdiabas,
  blockIndex: number,
  expectedLength: number,
): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let offset = 0;
  let seenOpens = 0;
  let inBlock = false;
  for (const c of m.calls) {
    if (c.job === 'flash_schreiben_adresse') {
      if (seenOpens === blockIndex) {
        inBlock = true;
        offset = 0;
      }
      seenOpens++;
      continue;
    }
    if (c.job === 'flash_schreiben_ende') {
      if (inBlock) return out;
      continue;
    }
    if (!inBlock || c.job !== 'flash_schreiben') continue;
    const frame = c.arg as Uint8Array;
    const len = frame[13]!;
    out.set(frame.subarray(21, 21 + len), offset);
    offset += len;
  }
  return out;
}
