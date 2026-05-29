/**
 * Integrity verification for the bundled MiniMon binaries.
 *
 * `bundled/manifest.json` records SHA-256 hashes of each blob. At
 * runtime, before any blob is sent to an ECU, we verify the on-disk
 * contents still match. Any tampering (or accidental corruption) fails
 * the check before bytes leave the host.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundleBlob {
  name: string;
  role: string;
  format: string;
  sha256: string;
}

export interface BundleManifest {
  source: string;
  extracted_from: string;
  license: string;
  blobs: BundleBlob[];
}

export interface BlobIntegrity {
  name: string;
  expectedSha256: string;
  actualSha256: string;
  match: boolean;
}

export interface IntegrityReport {
  manifest: BundleManifest;
  results: BlobIntegrity[];
  allValid: boolean;
}

function sha256Hex(buf: Buffer): string {
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

export function loadBundleManifest(): BundleManifest {
  if (cachedManifest) return cachedManifest;
  const path = resolve(resolveBundleDir(), 'manifest.json');
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text) as BundleManifest;
  cachedManifest = parsed;
  return parsed;
}

export function readBundledBlob(name: string): Buffer {
  return readFileSync(resolve(resolveBundleDir(), name));
}

export function verifyBundleIntegrity(): IntegrityReport {
  const manifest = loadBundleManifest();
  const results: BlobIntegrity[] = [];
  for (const b of manifest.blobs) {
    const buf = readBundledBlob(b.name);
    const actual = sha256Hex(buf);
    results.push({
      name: b.name,
      expectedSha256: b.sha256,
      actualSha256: actual,
      match: actual === b.sha256.toLowerCase(),
    });
  }
  return {
    manifest,
    results,
    allValid: results.every((r) => r.match),
  };
}

/**
 * Convenience: verify integrity and throw if any blob fails. Use this at
 * the start of any bootmode operation to abort before bytes go on the
 * wire.
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
