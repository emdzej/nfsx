/**
 * Node-only entry point for `@emdzej/nfsx-flash`.
 *
 * Re-exports the browser-safe surface plus:
 *
 *   - `nodeStartRuntime` — the Node `IpoRuntimeStart` (thin alias for
 *     `startNfsRuntimeFromPath`). Pass to `runPrecheck` /
 *     `runBackup` / `runProgramSg` / `FlashSession` /
 *     `FscManager` from CLI/server callers.
 *   - `nodeBackupEmitter(outputDir)` — persists the BACKUP JSON to
 *     disk under `outputDir`, returning the resolved absolute path
 *     (mirrors the old `writeBackupFile`).
 *   - `writeBackupFile` — legacy convenience for callers that used
 *     the pre-refactor Node API.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { startNfsRuntimeFromPath } from '@emdzej/nfsx-runtime/node';
import type { IpoRuntimeStart } from '@emdzej/nfsx-runtime';
import type { BackupEmitter } from './types.js';
import { defaultBackupFilename, serializeBackup, type BackupReport } from './backup.js';

export * from './index.js';

/**
 * The Node `IpoRuntimeStart`. Thin alias for `startNfsRuntimeFromPath`
 * — same shape, but named so it's obvious at the call site what
 * seam this is filling.
 */
export const nodeStartRuntime: IpoRuntimeStart = startNfsRuntimeFromPath;

/**
 * `BackupEmitter` that writes to disk under `outputDir`. Creates the
 * directory if missing. Returns the resolved absolute path so the
 * caller can log it.
 */
export function nodeBackupEmitter(outputDir: string): BackupEmitter {
  return {
    emit(filename: string, bytes: Uint8Array): string {
      const dir = resolvePath(outputDir);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, filename);
      writeFileSync(path, bytes);
      return path;
    },
  };
}

/**
 * Persist a `BackupReport` to disk. Default filename pattern:
 * `<HWNR>-<ZB>-<UTC-timestamp>.json` under the chosen directory.
 * Creates the directory if missing. Returns the resolved absolute
 * path.
 *
 * Node-only — the browser bundle uses `emitBackup` with a Blob-based
 * `BackupEmitter` instead.
 */
export function writeBackupFile(
  report: BackupReport,
  outputDir: string,
  filename?: string,
): string {
  const dir = resolvePath(outputDir);
  mkdirSync(dir, { recursive: true });
  const name = filename ?? defaultBackupFilename(report);
  const path = join(dir, name);
  writeFileSync(path, serializeBackup(report));
  return path;
}
