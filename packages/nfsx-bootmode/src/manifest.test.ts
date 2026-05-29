import { describe, it, expect } from 'vitest';
import {
  loadBundleManifest,
  readBundledBlob,
  verifyBundleIntegrity,
  assertBundleIntegrity,
} from './manifest.js';

describe('bundle manifest', () => {
  it('loads the manifest', () => {
    const m = loadBundleManifest();
    expect(m.blobs.length).toBeGreaterThan(0);
    expect(m.source).toContain('MiniMon');
  });

  it('reads each bundled blob by name', () => {
    const m = loadBundleManifest();
    for (const b of m.blobs) {
      const buf = readBundledBlob(b.name);
      expect(buf.length).toBeGreaterThan(0);
    }
  });

  it('verifies all blobs match their declared SHA-256', () => {
    const report = verifyBundleIntegrity();
    for (const r of report.results) {
      expect(r.match, `${r.name}: ${r.actualSha256} vs ${r.expectedSha256}`).toBe(true);
    }
    expect(report.allValid).toBe(true);
  });

  it('assertBundleIntegrity does not throw on a clean install', () => {
    expect(() => assertBundleIntegrity()).not.toThrow();
  });
});
