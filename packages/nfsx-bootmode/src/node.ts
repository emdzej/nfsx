/**
 * Node-only entry point — exports the `NodeBootmodeTransport` (which
 * uses `serialport`) and the FS-backed `BundleLoader` factory
 * (`createNodeBundleLoader`), plus the sync helpers that predate the
 * async `BundleLoader` interface.
 *
 * Browser callers must NOT import this — Vite would try to bundle
 * `node:buffer`, `node:fs`, `node:crypto`, and `serialport`, all of
 * which fail in a browser build. Import from the main entry
 * (`@emdzej/nfsx-bootmode`) and supply your own transport + loader.
 */
export { NodeBootmodeTransport } from './transport.js';
export {
  createNodeBundleLoader,
  loadBundleManifest,
  readBundledBlob,
  verifyBundleIntegrity,
  assertBundleIntegrity,
} from './manifest.js';
