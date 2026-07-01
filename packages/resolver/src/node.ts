/**
 * Node-only entry point — fs-based SP-Daten loaders + the
 * `resolveFlashContext` helpers that scan the on-disk chassis drop
 * for IPO / SGBD paths.
 *
 * CLI, tests, and any other Node consumer imports from here. The
 * browser main entry (`@emdzej/nfsx-resolver`) omits everything in
 * this file so Vite doesn't try to bundle `node:fs` / `node:path`.
 */
export {
  loadSpDaten,
  loadSpDatenFromDir,
  loadZbNrTabForSg,
  defaultSpDatenPaths,
} from './load.js';

export {
  resolveFlashContext,
  resolveFlashContextLite,
  FlashContextError,
  type FlashContext,
  type FlashContextLite,
  type ResolveFlashContextOptions,
} from './flash-context.js';

// Convenience re-exports so a Node caller can grab everything from
// the `/node` subpath without also importing the main entry for
// types / resolvers.
export { type SpDaten, type SpDatenPaths } from './types.js';
export { type SpDatenSource } from './source.js';
export {
  loadSpDatenFromSource,
  loadZbNrTabForSgFromSource,
  defaultSpDatenRelativePaths,
} from './load-source.js';
export {
  resolveByHwnr,
  resolveBySgTyp,
  resolveByDiagAddr,
  resolveUpgrade,
  type FlashCandidate,
} from './resolve.js';
