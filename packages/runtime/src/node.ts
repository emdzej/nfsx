/**
 * Node-only entry point — CLI + server callers who already have an
 * IPO on disk. Wraps the browser-safe `startNfsRuntime` with the
 * `readFileSync` + `nodeFileBackend()` setup so existing callers
 * don't need to duplicate that boilerplate.
 */
import { readFileSync } from 'node:fs';
import {
  startNfsRuntime,
  type NfsRuntimeHandle,
  type StartNfsRuntimeOptions,
} from './runtime.js';
import { nodeFileBackend } from './node-file-backend.js';

export { nodeFileBackend } from './node-file-backend.js';
export {
  startNfsRuntime,
  type NfsRuntimeHandle,
  type StartNfsRuntimeOptions,
} from './runtime.js';
export { type FileBackend } from './file-backend.js';
export { CabiState } from './state.js';
export {
  buildSystemFunctions,
  type FirmwareSource,
  type BuildSystemFunctionsOptions,
} from './system-functions.js';
export type { IpoRuntimeStart } from './index.js';

/**
 * Convenience: read the IPO from `path`, wire the Node fileBackend
 * by default, then delegate to `startNfsRuntime`. Callers who
 * already have bytes go straight to `startNfsRuntime`.
 */
export async function startNfsRuntimeFromPath(
  path: string,
  options: Omit<StartNfsRuntimeOptions, 'ipoBytes' | 'ipoPath'> & {
    /** Optional override — defaults to `nodeFileBackend()`. */
    fileBackend?: StartNfsRuntimeOptions['fileBackend'];
  } = {},
): Promise<NfsRuntimeHandle> {
  const buf = readFileSync(path);
  const ipoBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return startNfsRuntime({
    ...options,
    ipoPath: path,
    ipoBytes,
    fileBackend: options.fileBackend ?? nodeFileBackend(),
  });
}
