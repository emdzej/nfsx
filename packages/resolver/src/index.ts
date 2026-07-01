/**
 * Browser-safe surface. Node-only file-loading helpers (fs-based
 * `loadSpDaten*`, disk-scanning `resolveFlashContext`, etc.) live at
 * the `./node` subpath so consumers importing here don't drag in
 * `node:fs` / `node:path` transitively.
 *
 * Web consumers construct their own `SpDatenSource` implementation
 * (VFS-backed) and drive the async loader from there.
 */
export { type SpDaten, type SpDatenPaths } from './types.js';

export {
  loadSpDatenFromSource,
  loadZbNrTabForSgFromSource,
  defaultSpDatenRelativePaths,
} from './load-source.js';

export { type SpDatenSource } from './source.js';

export {
  resolveByHwnr,
  resolveBySgTyp,
  resolveByDiagAddr,
  resolveUpgrade,
  type FlashCandidate,
} from './resolve.js';
