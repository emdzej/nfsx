import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { MockBootmodeTransport } from './transport.js';
import { MinimonClient, A_ACK1, A_ACK2, C_READ_WORD, C_WRITE_BLOCK } from './minimon.js';

describe('MinimonClient framing (mock transport)', () => {
  let mock: MockBootmodeTransport;
  let client: MinimonClient;

  beforeEach(async () => {
    mock = new MockBootmodeTransport();
    await mock.open();
    client = new MinimonClient(mock, { ackTimeoutMs: 1000, readTimeoutMs: 1000 });
  });

  it('readWord sends CMD + addr-LE and reads 2 bytes + ACK2', async () => {
    mock.enqueueResponse([A_ACK1, 0xcd, 0xab, A_ACK2]);
    const w = await client.readWord(0x12345678);
    expect(w).toBe(0xabcd);
    // Sent bytes: C_READ_WORD then 4-byte LE address.
    expect(mock.writtenBytes).toEqual([C_READ_WORD, 0x78, 0x56, 0x34, 0x12]);
  });

  it('writeWord sends CMD + addr-LE + word-LE and waits for both ACKs', async () => {
    mock.enqueueResponse([A_ACK1, A_ACK2]);
    await client.writeWord(0x00001000, 0xbeef);
    expect(mock.writtenBytes).toEqual([
      0x82, // C_WRITE_WORD
      0x00, 0x10, 0x00, 0x00,
      0xef, 0xbe,
    ]);
  });

  it('writeBlock streams the data after the header', async () => {
    mock.enqueueResponse([A_ACK1, A_ACK2]);
    const data = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    await client.writeBlock(0x20000000, data);
    expect(mock.writtenBytes).toEqual([
      C_WRITE_BLOCK,
      0x00, 0x00, 0x00, 0x20,
      0x04, 0x00,
      0x11, 0x22, 0x33, 0x44,
    ]);
  });

  it('readBlock requests N bytes and verifies ACK2 trailing', async () => {
    const payload = [0xaa, 0xbb, 0xcc];
    mock.enqueueResponse([A_ACK1, ...payload, A_ACK2]);
    const got = await client.readBlock(0x40, 3);
    expect([...got]).toEqual(payload);
  });

  it('callFunction sends 8 register words and parses 8 returned words', async () => {
    const responseWords = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888];
    const responseBytes: number[] = [];
    for (const w of responseWords) {
      responseBytes.push(w & 0xff, (w >> 8) & 0xff);
    }
    mock.enqueueResponse([A_ACK1, ...responseBytes, A_ACK2]);
    const result = await client.callFunction(0x00012000, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result).toEqual(responseWords);
  });

  it('throws MinimonError if ACK1 is missing', async () => {
    mock.enqueueResponse([0xff]);
    await expect(client.readWord(0)).rejects.toThrow(/A_ACK1/);
  });
});
