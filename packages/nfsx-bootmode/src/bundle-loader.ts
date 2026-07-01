/**
 * `BundleLoader` — abstraction over "where do the MiniMon blobs come
 * from" so the same session code runs in Node (blobs on disk) and in
 * the browser (blobs bundled at build time via Vite raw imports).
 *
 * The types + interface live in this file so browser callers can
 * implement `BundleLoader` without pulling in `node:fs` / `node:crypto`
 * transitively. The Node default implementation lives in
 * `manifest.ts` (imported from the package's `/node` subpath only).
 */

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

/**
 * A source of MiniMon / stub blobs plus their integrity manifest. The
 * loader is intentionally async: browser implementations often want to
 * defer the actual byte read until first use, and Web Crypto's SHA-256
 * is `Promise`-based anyway.
 */
export interface BundleLoader {
  /** Return the full parsed `manifest.json`. */
  getManifest(): Promise<BundleManifest>;
  /** Return the raw bytes of the named blob. */
  getBlob(name: string): Promise<Uint8Array>;
  /**
   * Recompute SHA-256 of every blob in the manifest and check against
   * the recorded hashes. Implementations pick their preferred hash
   * primitive (Node's `crypto.createHash` or Web Crypto).
   */
  verifyIntegrity(): Promise<IntegrityReport>;
}

/**
 * Convenience: `verifyIntegrity()` + throw if anything mismatches.
 * Kept out of the interface so implementations don't each need to
 * duplicate the string formatting.
 */
export async function assertBundleIntegrity(loader: BundleLoader): Promise<void> {
  const report = await loader.verifyIntegrity();
  if (!report.allValid) {
    const failed = report.results
      .filter((r) => !r.match)
      .map((r) => `${r.name}: expected ${r.expectedSha256}, got ${r.actualSha256}`)
      .join('; ');
    throw new Error(`Bundled MiniMon blob integrity check failed: ${failed}`);
  }
}
