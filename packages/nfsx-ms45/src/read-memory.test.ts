import { describe, it, expect } from 'vitest';
import { MockIEdiabas, buildResponse } from './mock-ediabas.js';
import { readMemory, READ_CHUNK_SIZE } from './read-memory.js';

/**
 * Register `speicher_lesen_ascii` such that it returns a slice of
 * the given source buffer for each requested (segment, addr, len).
 * The mock keys off the exact arg string, so we register one entry
 * per expected chunk.
 */
function registerSlices(
  mock: MockIEdiabas,
  segment: string,
  start: number,
  end: number,
  chunk: number,
  source: Uint8Array,
): void {
  let addr = start;
  const total = end - start + 1;
  let done = 0;
  while (done < total) {
    const len = Math.min(chunk, total - done);
    const arg = `${segment};${addr};${len}`;
    // Capture into a local copy so response bytes match the current window.
    const window = source.slice(done, done + len);
    mock.setResponse(
      'speicher_lesen_ascii',
      arg,
      buildResponse({ DATEN: window }),
    );
    done += len;
    addr += len;
  }
}

describe('readMemory', () => {
  it('assembles a contiguous buffer from 254-byte chunks', async () => {
    // 300 total bytes: two chunks (254 + 46).
    const source = new Uint8Array(300);
    for (let i = 0; i < source.length; i++) source[i] = (i * 3 + 1) & 0xff;

    const m = new MockIEdiabas();
    registerSlices(m, 'ROMX', 0x40000, 0x40000 + 299, 254, source);

    const out = await readMemory(m, 'D_Motor', {
      segment: 'ROMX',
      start: 0x40000,
      end: 0x40000 + 299,
    });
    expect(out.length).toBe(300);
    expect(Array.from(out)).toEqual(Array.from(source));

    // Two chunk requests.
    const argStrings = m.calls.map((c) => c.arg);
    expect(argStrings).toEqual([
      `ROMX;${0x40000};254`,
      `ROMX;${0x40000 + 254};46`,
    ]);
  });

  it('honours a smaller custom chunk size', async () => {
    const source = new Uint8Array(100);
    for (let i = 0; i < source.length; i++) source[i] = i;

    const m = new MockIEdiabas();
    registerSlices(m, 'LAR', 0, 99, 32, source);

    const out = await readMemory(m, 'D_Motor', {
      segment: 'LAR',
      start: 0,
      end: 99,
      chunkSize: 32,
    });
    expect(Array.from(out)).toEqual(Array.from(source));
    // Expect chunks 32 + 32 + 32 + 4.
    expect(m.calls.map((c) => c.arg)).toEqual([
      'LAR;0;32',
      'LAR;32;32',
      'LAR;64;32',
      'LAR;96;4',
    ]);
  });

  it('emits progress after every chunk', async () => {
    const source = new Uint8Array(500);
    const m = new MockIEdiabas();
    registerSlices(m, 'ROMX', 0, 499, 254, source);

    const events: [number, number][] = [];
    await readMemory(m, 'D_Motor', {
      segment: 'ROMX',
      start: 0,
      end: 499,
      onProgress: (n, t) => events.push([n, t]),
    });
    expect(events).toEqual([
      [254, 500],
      [500, 500],
    ]);
  });

  it('throws if the DATEN result length disagrees with the request', async () => {
    const m = new MockIEdiabas();
    m.setResponse(
      'speicher_lesen_ascii',
      'ROMX;0;254',
      buildResponse({ DATEN: new Uint8Array(200) }), // short read
    );
    await expect(
      readMemory(m, 'D_Motor', { segment: 'ROMX', start: 0, end: 253 }),
    ).rejects.toThrow(/expected 254 bytes/);
  });

  it('rejects an inverted range', async () => {
    const m = new MockIEdiabas();
    await expect(
      readMemory(m, 'D_Motor', { segment: 'ROMX', start: 100, end: 50 }),
    ).rejects.toThrow(/end .* < start/);
  });

  it('rejects an out-of-bounds chunkSize', async () => {
    const m = new MockIEdiabas();
    await expect(
      readMemory(m, 'D_Motor', {
        segment: 'ROMX',
        start: 0,
        end: 100,
        chunkSize: READ_CHUNK_SIZE + 1,
      }),
    ).rejects.toThrow(/chunkSize/);
  });
});
