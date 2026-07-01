/**
 * Browser `BundleLoader` — supplies the MiniMon / stub blobs to the
 * bootmode session by importing them via Vite's `?url` query, then
 * fetching them at runtime.
 *
 * `?url` gives us the hashed asset URL Vite emits at build time
 * (avoiding a large string inline in the JS bundle for each blob).
 * The manifest itself is imported as a JSON module so the SHA-256
 * hashes come along at build time — no manifest.json network round
 * trip.
 *
 * Integrity is verified with the browser's Web Crypto API
 * (`crypto.subtle.digest`). Runs once per session before any bytes
 * hit the wire.
 */
import type { BundleLoader, BundleManifest, IntegrityReport } from "@emdzej/nfsx-bootmode";

// Vite resolves each package path to the raw file inside
// `packages/nfsx-bootmode/bundled/`, honoring the `./bundled/*`
// exports entry in the package.json.
import manifestJson from "@emdzej/nfsx-bootmode/bundled/manifest.json";
import LOADK_URL from "@emdzej/nfsx-bootmode/bundled/LOADK.hex?url";
import MINIMONK_URL from "@emdzej/nfsx-bootmode/bundled/MINIMONK.hex?url";
import JMG_LOADK_URL from "@emdzej/nfsx-bootmode/bundled/JMG_LOADK.hex?url";
import JMG_BLOB_URL from "@emdzej/nfsx-bootmode/bundled/JMG_BLOB.hex?url";
import ERASE_STUB_URL from "@emdzej/nfsx-bootmode/bundled/ERASE_STUB.hex?url";
import PROGRAMMER_STUB_URL from "@emdzej/nfsx-bootmode/bundled/PROGRAMMER_STUB.hex?url";
import PROBE_STUB_URL from "@emdzej/nfsx-bootmode/bundled/PROBE_STUB.hex?url";

const BLOB_URLS: Record<string, string> = {
  "LOADK.hex": LOADK_URL,
  "MINIMONK.hex": MINIMONK_URL,
  "JMG_LOADK.hex": JMG_LOADK_URL,
  "JMG_BLOB.hex": JMG_BLOB_URL,
  "ERASE_STUB.hex": ERASE_STUB_URL,
  "PROGRAMMER_STUB.hex": PROGRAMMER_STUB_URL,
  "PROBE_STUB.hex": PROBE_STUB_URL,
};

const blobCache = new Map<string, Uint8Array>();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS 5.7 tightened BufferSource — Uint8Array<ArrayBufferLike> no
  // longer assigns to ArrayBufferView<ArrayBuffer>. Copy into a plain
  // ArrayBuffer for the digest input.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the browser-side `BundleLoader`. Idempotent; blobs are cached. */
export function createWebBundleLoader(): BundleLoader {
  return {
    async getManifest(): Promise<BundleManifest> {
      // The JSON module is a plain object at runtime; no network hop.
      return manifestJson as BundleManifest;
    },
    async getBlob(name: string): Promise<Uint8Array> {
      const cached = blobCache.get(name);
      if (cached) return cached;
      const url = BLOB_URLS[name];
      if (!url) {
        throw new Error(
          `bootmode bundle: unknown blob "${name}". Known: ${Object.keys(BLOB_URLS).join(", ")}`,
        );
      }
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`bootmode bundle: failed to fetch ${name}: ${res.status} ${res.statusText}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      blobCache.set(name, bytes);
      return bytes;
    },
    async verifyIntegrity(): Promise<IntegrityReport> {
      const manifest = manifestJson as BundleManifest;
      const results = await Promise.all(
        manifest.blobs.map(async (b) => {
          const url = BLOB_URLS[b.name];
          if (!url) {
            return {
              name: b.name,
              expectedSha256: b.sha256,
              actualSha256: "<not-bundled>",
              match: false,
            };
          }
          const res = await fetch(url);
          const bytes = new Uint8Array(await res.arrayBuffer());
          // Populate the cache too — no reason to fetch these twice.
          blobCache.set(b.name, bytes);
          const actual = await sha256Hex(bytes);
          return {
            name: b.name,
            expectedSha256: b.sha256,
            actualSha256: actual,
            match: actual === b.sha256.toLowerCase(),
          };
        }),
      );
      return {
        manifest,
        results,
        allValid: results.every((r) => r.match),
      };
    },
  };
}
