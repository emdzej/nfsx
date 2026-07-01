/**
 * Small `Uint8Array` helpers. Bootmode's core code paths use plain
 * `Uint8Array` so they run in both Node and the browser without a
 * `Buffer` polyfill; these are the couple of operations that don't
 * have a one-liner equivalent on `Uint8Array`.
 */

/** Concatenate one or more `Uint8Array` chunks into a fresh buffer. */
export function concatU8(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Little-endian 24-bit encoding — the address width the MiniMon
 * protocol uses.
 */
export function le24(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
}

/** Little-endian 16-bit encoding. */
export function le16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}
