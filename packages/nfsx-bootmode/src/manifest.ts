/**
 * Node.js bundle loader — reads the packaged `bundled/*.hex` blobs
 * from disk and verifies their SHA-256 hashes against `manifest.json`.
 *
 * Import from `@emdzej/nfsx-bootmode/node` (or from within this package
 * via the top-level entry that re-exports through `./node`). The
 * browser path uses `bundle-loader.ts`'s interface and supplies its own
 * `BundleLoader` implementation over Vite-imported blob URLs.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BundleLoader,
  BundleManifest,
  IntegrityReport,
} from './bundle-loader.js';

// Re-export the types so callers who only import `manifest.ts` still
// see them alongside the impl (backwards compatible with the previous
// single-file layout).
export type {
  BundleBlob,
  BundleManifest,
  BlobIntegrity,
  IntegrityReport,
  BundleLoader,
} from './bundle-loader.js';
export { assertBundleIntegrity as assertBundleIntegrityLoader } from './bundle-loader.js';

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve the bundled/ directory inside this package, regardless of
 * whether we're running from src/ (vitest), dist/ (compiled), or as a
 * dependency under node_modules/.
 */
function resolveBundleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/manifest.ts → ../bundled
  // dist/manifest.js → ../bundled
  return resolve(here, '..', 'bundled');
}

let cachedManifest: BundleManifest | null = null;

/**
 * Synchronous manifest read — retained for callers (CLI, tests) that
 * were built against the pre-async API. New code should prefer
 * `createNodeBundleLoader().getManifest()`.
 */
export function loadBundleManifest(): BundleManifest {
  if (cachedManifest) return cachedManifest;
  const path = resolve(resolveBundleDir(), 'manifest.json');
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text) as BundleManifest;
  cachedManifest = parsed;
  return parsed;
}

/** Sync blob read (Node-only). */
export function readBundledBlob(name: string): Uint8Array {
  const buf = readFileSync(resolve(resolveBundleDir(), name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Sync integrity check. Node-only. */
export function verifyBundleIntegrity(): IntegrityReport {
  const manifest = loadBundleManifest();
  const results = manifest.blobs.map((b) => {
    const actual = sha256Hex(readBundledBlob(b.name));
    return {
      name: b.name,
      expectedSha256: b.sha256,
      actualSha256: actual,
      match: actual === b.sha256.toLowerCase(),
    };
  });
  return {
    manifest,
    results,
    allValid: results.every((r) => r.match),
  };
}

/**
 * Convenience: verify integrity and throw if any blob fails. Use this
 * at the start of any bootmode operation to abort before bytes go on
 * the wire. Sync — Node-only.
 */
export function assertBundleIntegrity(): void {
  const report = verifyBundleIntegrity();
  if (!report.allValid) {
    const failed = report.results
      .filter((r) => !r.match)
      .map((r) => `${r.name}: expected ${r.expectedSha256}, got ${r.actualSha256}`)
      .join('; ');
    throw new Error(`Bundled MiniMon blob integrity check failed: ${failed}`);
  }
}

/**
 * Build a `BundleLoader` backed by the Node filesystem — the default
 * for CLI callers. Browser callers construct their own loader over
 * Vite-imported blob URLs.
 *
 * Ignore the `Buffer` re-import: the type is referenced only inside
 * this Node-scoped file; the browser code path never touches it.
 */
export function createNodeBundleLoader(): BundleLoader {
  return {
    async getManifest(): Promise<BundleManifest> {
      return loadBundleManifest();
    },
    async getBlob(name: string): Promise<Uint8Array> {
      return readBundledBlob(name);
    },
    async verifyIntegrity(): Promise<IntegrityReport> {
      return verifyBundleIntegrity();
    },
  };
}

// The following symbol is imported here purely so `unused-import` linting
// stays quiet in the future if a Buffer-typed export is added.
void Buffer;
