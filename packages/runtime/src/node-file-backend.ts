/**
 * Node.js `FileBackend` — wraps `node:fs` + `node:path` so
 * `system-functions.ts` doesn't need those imports at module scope.
 * CLI / server callers construct one via `nodeFileBackend()` and hand
 * it to `startNfsRuntime`.
 *
 * Kept in its own file so the browser bundle never resolves
 * `node:fs`; Vite tree-shakes anything the main entry doesn't touch.
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { FileBackend } from './file-backend.js';

export function nodeFileBackend(): FileBackend {
  return {
    resolveWorkingPath(workingDir, filename) {
      if (isAbsolute(filename)) {
        // Absolute paths are trusted — the IPO must have been given
        // them by the host. `resolve` normalizes `.` / `..` and
        // trailing slashes.
        return resolve(filename);
      }
      if (!workingDir) {
        throw new Error(
          `no working directory configured — cannot resolve relative path "${filename}"`,
        );
      }
      const baseDir = resolve(workingDir);
      const full = resolve(baseDir, filename);
      if (full !== baseDir && !full.startsWith(baseDir + sep)) {
        throw new Error(
          `path traversal blocked: "${filename}" resolves outside ${baseDir}`,
        );
      }
      return full;
    },
    readAll(path) {
      const buf = readFileSync(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    openForWrite(path, mode) {
      return openSync(path, mode === 'w' ? 'w' : 'a');
    },
    writeString(fd, s) {
      writeSync(fd, s);
    },
    close(fd) {
      closeSync(fd);
    },
  };
}
