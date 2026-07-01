/**
 * Browser-safe surface. Node consumers with a filesystem-hosted IPO
 * import `startNfsRuntimeFromPath` and `nodeFileBackend` from the
 * `./node` subpath (which pulls in `node:fs`); browsers pre-load the
 * IPO bytes themselves (e.g. via a VirtualDirectory) and hand them
 * to `startNfsRuntime`.
 */
export {
  startNfsRuntime,
  type NfsRuntimeHandle,
  type StartNfsRuntimeOptions,
} from './runtime.js';
export { CabiState } from './state.js';
export {
  buildSystemFunctions,
  type FirmwareSource,
  type BuildSystemFunctionsOptions,
} from './system-functions.js';
export { type FileBackend } from './file-backend.js';
