import { describe, it, expect } from 'vitest';
import { MockIEdiabas } from './mock-ediabas.js';
import { requestSecurityAccess, type AuthRandomSource } from './auth-flow.js';
import { AUTH_MESSAGE_HEADER, AUTH_MESSAGE_LENGTH } from './auth.js';

function fixedRandom(bytes: Uint8Array): AuthRandomSource {
  return { userID: () => new Uint8Array(bytes) };
}

describe('requestSecurityAccess', () => {
  const userID = new Uint8Array([0x11, 0x22, 0x33, 0x44]);

  it('drives seriennummer_lesen → zufallszahl_lesen → authentisierung_start', async () => {
    const m = new MockIEdiabas();
    // Serial reply: 8-byte buffer where the last 5 bytes are 01 02 03 04 <term>.
    m.setResults('seriennummer_lesen', {
      _TEL_ANTWORT: new Uint8Array([0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03, 0x04, 0xff]),
    });
    m.setResults('authentisierung_zufallszahl_lesen', {
      ZUFALLSZAHL: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]),
    });
    m.setResults('authentisierung_start', {});

    const result = await requestSecurityAccess(m, 'D_Motor', {
      random: fixedRandom(userID),
    });

    expect(result.userID).toEqual(userID);
    expect(Array.from(result.serialNumber)).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(Array.from(result.seed)).toEqual([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);

    // Verify job order and arg shapes.
    expect(m.calls.map((c) => c.job)).toEqual([
      'seriennummer_lesen',
      'authentisierung_zufallszahl_lesen',
      'authentisierung_start',
    ]);

    // The seed-request arg is "3;0x<hex-BE-userID>".
    expect(m.calls[1]!.arg).toBe('3;0x11223344');

    // The authentisierung_start arg is the 90-byte binary blob.
    const authArg = m.calls[2]!.arg;
    expect(authArg).toBeInstanceOf(Uint8Array);
    expect((authArg as Uint8Array).length).toBe(AUTH_MESSAGE_LENGTH);
    expect(Array.from((authArg as Uint8Array).subarray(0, AUTH_MESSAGE_HEADER.length))).toEqual(
      Array.from(AUTH_MESSAGE_HEADER),
    );
  });

  it('propagates the DME rejection when authentisierung_start returns non-OKAY', async () => {
    const m = new MockIEdiabas();
    m.setResults('seriennummer_lesen', {
      _TEL_ANTWORT: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0xff]),
    });
    m.setResults('authentisierung_zufallszahl_lesen', {
      ZUFALLSZAHL: new Uint8Array([0x00, 0x11, 0x22]),
    });
    m.setResponse('authentisierung_start', undefined, () => ({
      sets: [{ JOB_STATUS: { name: 'JOB_STATUS', type: 'text', value: 'ERROR_AUTH_DENIED' } }],
    }));

    await expect(
      requestSecurityAccess(m, 'D_Motor', { random: fixedRandom(userID) }),
    ).rejects.toMatchObject({ job: 'authentisierung_start', jobStatus: 'ERROR_AUTH_DENIED' });
  });
});
