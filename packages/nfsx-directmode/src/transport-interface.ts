export interface DirectModeTransport {
  transact(request: Uint8Array): Promise<Uint8Array>;
  reconfigureBaud(newBaud: number): Promise<void>;
  setSessionTimeout(timeoutMs: number): Promise<void>;
}

export function buildRequestPayload(addr: number, payload: Uint8Array): Uint8Array {
  const total = payload.length + 3;
  if (total > 0xff) {
    throw new Error(
      `DS2 frame too large: payload ${payload.length} bytes → LEN ${total} exceeds 0xFF`,
    );
  }
  const buf = new Uint8Array(total - 1);
  buf[0] = addr & 0xff;
  buf[1] = total;
  buf.set(payload, 2);
  return buf;
}
