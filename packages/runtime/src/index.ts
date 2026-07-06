/**
 * Browser-safe surface. Node consumers with a filesystem-hosted IPO
 * import `startNfsRuntimeFromPath` and `nodeFileBackend` from the
 * `./node` subpath (which pulls in `node:fs`); browsers pre-load the
 * IPO bytes themselves (e.g. via a VirtualDirectory) and hand them
 * to `startNfsRuntime`.
 */
import type { NfsRuntimeHandle, StartNfsRuntimeOptions } from './runtime.js';

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

/**
 * Boot an `NfsRuntimeHandle` from an IPO reference. Callers hand this
 * to `@emdzej/nfsx-flash` and `@emdzej/nfsx-fsc` so those packages stay
 * browser-safe — they never need to reach for `node:fs`.
 *
 * The Node convenience `startNfsRuntimeFromPath` (from
 * `@emdzej/nfsx-runtime/node`) satisfies this shape directly; browsers
 * write a small closure that loads IPO bytes via `VirtualDirectory`
 * and delegates to `startNfsRuntime`.
 */
export type IpoRuntimeStart = (
  ipoPath: string,
  options: Omit<StartNfsRuntimeOptions, 'ipoPath' | 'ipoBytes'>,
) => Promise<NfsRuntimeHandle>;
