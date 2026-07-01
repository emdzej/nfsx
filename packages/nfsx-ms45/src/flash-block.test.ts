import { describe, it, expect } from 'vitest';
import { MockIEdiabas } from './mock-ediabas.js';
import {
  buildFlashAddressCommand,
  buildFlashChunk,
  flashBlock,
  FLASH_CHUNK_SIZE,
  FLASH_TUNE,
  FLASH_PROGRAM,
  FLASH_MPC,
} from './flash-block.js';

describe('buildFlashAddressCommand', () => {
  it('lays out the tune write-address command exactly', () => {
    const cmd = buildFlashAddressCommand(FLASH_TUNE);
    expect(cmd.length).toBe(22);
    expect(cmd[0]).toBe(0x01);
    expect(cmd[21]).toBe(0x03);
    // Length 0x1D000 LE.
    expect(Array.from(cmd.subarray(13, 17))).toEqual([0x00, 0xd0, 0x01, 0x00]);
    // Start 0x2040000 LE.
    expect(Array.from(cmd.subarray(17, 21))).toEqual([0x00, 0x00, 0x04, 0x02]);
  });

  it('lays out the program write-address command exactly', () => {
    const cmd = buildFlashAddressCommand(FLASH_PROGRAM);
    // Length 0x9FF40 LE.
    expect(Array.from(cmd.subarray(13, 17))).toEqual([0x40, 0xff, 0x09, 0x00]);
    // Start 0x2060000 LE.
    expect(Array.from(cmd.subarray(17, 21))).toEqual([0x00, 0x00, 0x06, 0x02]);
  });

  it('lays out the MPC write-address command exactly', () => {
    const cmd = buildFlashAddressCommand(FLASH_MPC);
    // Length 0x70000 LE.
    expect(Array.from(cmd.subarray(13, 17))).toEqual([0x00, 0x00, 0x07, 0x00]);
    // Start 0 LE.
    expect(Array.from(cmd.subarray(17, 21))).toEqual([0x00, 0x00, 0x00, 0x00]);
  });
});

describe('buildFlashChunk', () => {
  it('produces a 21+len+1 byte frame with the correct header + trailer', () => {
    const data = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const frame = buildFlashChunk(0x2040000, data);
    expect(frame.length).toBe(21 + 4 + 1);
    expect(frame[0]).toBe(0x01);
    expect(frame[13]).toBe(4);
    expect(Array.from(frame.subarray(17, 21))).toEqual([0x00, 0x00, 0x04, 0x02]);
    expect(Array.from(frame.subarray(21, 25))).toEqual([0x11, 0x22, 0x33, 0x44]);
    expect(frame[25]).toBe(0x03);
  });

  it('rejects empty and oversized chunks', () => {
    expect(() => buildFlashChunk(0, new Uint8Array(0))).toThrow(/1..\d+ bytes/);
    expect(() => buildFlashChunk(0, new Uint8Array(FLASH_CHUNK_SIZE + 1))).toThrow(
      /1..\d+ bytes/,
    );
  });
});

describe('flashBlock', () => {
  function registerFlashHandlers(mock: MockIEdiabas): void {
    mock.setResults('flash_schreiben_adresse', {});
    mock.setResults('flash_schreiben', {});
    mock.setResults('flash_schreiben_ende', {});
  }

  it('opens, streams chunks, and closes the write cursor', async () => {
    const m = new MockIEdiabas();
    registerFlashHandlers(m);

    // 500-byte payload → two chunks: 0xFD + (500 - 0xFD) = 0xFD + 247.
    const payload = new Uint8Array(500);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 5) & 0xff;
    const target = { start: 0x2040000, length: 500 };

    await flashBlock(m, 'D_Motor', target, payload);

    const jobs = m.calls.map((c) => c.job);
    expect(jobs).toEqual([
      'flash_schreiben_adresse',
      'flash_schreiben',
      'flash_schreiben',
      'flash_schreiben_ende',
    ]);

    // Chunk 1 starts at 0x2040000 with 0xFD bytes.
    const chunk1 = m.calls[1]!.arg as Uint8Array;
    expect(chunk1[13]).toBe(0xfd);
    expect(Array.from(chunk1.subarray(17, 21))).toEqual([0x00, 0x00, 0x04, 0x02]);

    // Chunk 2 starts at 0x2040000 + 0xFD.
    const chunk2 = m.calls[2]!.arg as Uint8Array;
    expect(chunk2[13]).toBe(500 - 0xfd);
    const expected2Addr = 0x2040000 + 0xfd;
    expect(Array.from(chunk2.subarray(17, 21))).toEqual([
      expected2Addr & 0xff,
      (expected2Addr >>> 8) & 0xff,
      (expected2Addr >>> 16) & 0xff,
      (expected2Addr >>> 24) & 0xff,
    ]);
  });

  it('splits the payload byte-perfectly across chunks', async () => {
    const m = new MockIEdiabas();
    registerFlashHandlers(m);

    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    await flashBlock(m, 'D_Motor', { start: 0x1000, length: 1000 }, payload);

    // Concat data slices from each flash_schreiben frame and expect it
    // to equal the original payload.
    const dataFrames = m.calls
      .filter((c) => c.job === 'flash_schreiben')
      .map((c) => c.arg as Uint8Array);
    const reassembled = new Uint8Array(payload.length);
    let off = 0;
    for (const frame of dataFrames) {
      const len = frame[13]!;
      reassembled.set(frame.subarray(21, 21 + len), off);
      off += len;
    }
    expect(Array.from(reassembled)).toEqual(Array.from(payload));
  });

  it('emits progress after each chunk', async () => {
    const m = new MockIEdiabas();
    registerFlashHandlers(m);

    const payload = new Uint8Array(600);
    const events: [number, number][] = [];
    await flashBlock(m, 'D_Motor', { start: 0, length: 600 }, payload, {
      onProgress: (w, t) => events.push([w, t]),
    });
    // 253 (0xFD) + 253 + 94 = 600, so 3 chunks.
    expect(events).toEqual([
      [0xfd, 600],
      [0xfd * 2, 600],
      [600, 600],
    ]);
  });

  it('rejects mismatched payload length', async () => {
    const m = new MockIEdiabas();
    await expect(
      flashBlock(m, 'D_Motor', { start: 0, length: 10 }, new Uint8Array(5)),
    ).rejects.toThrow(/payload length/);
  });

  it('rejects an out-of-bounds chunkSize override', async () => {
    const m = new MockIEdiabas();
    await expect(
      flashBlock(m, 'D_Motor', { start: 0, length: 10 }, new Uint8Array(10), {
        chunkSize: FLASH_CHUNK_SIZE + 1,
      }),
    ).rejects.toThrow(/chunkSize/);
  });
});
