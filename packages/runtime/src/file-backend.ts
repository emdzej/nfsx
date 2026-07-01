/**
 * File-I/O backend for the IPO's `fileopen` / `fileread` / `filewrite`
 * / `fileclose` syscall slots. Browser-safe interface — the Node
 * impl (`nodeFileBackend()`) lives at the `./node` subpath so bundlers
 * bundling the browser entry don't drag in `node:fs`.
 *
 * When the runtime is started without a backend, fileopen slots
 * fail-close (recorded in the trace, no crash). The identity flow
 * (`nfsx check` / `runBackup`) doesn't call fileopen; the flash flow
 * (`SG_PROGRAMMIEREN`) does.
 *
 * Path resolution + traversal safety are the backend's responsibility
 * because they're OS-specific (Windows uses `\`, POSIX uses `/`, and
 * a browser-hosted VFS uses `/` internally too).
 */

export interface FileBackend {
  /**
   * Resolve `filename` under `workingDir`, rejecting escapes (e.g.
   * `../secrets`). Returns an absolute-ish path the backend can then
   * open, read, and write. Absolute inputs are honored as-is.
   */
  resolveWorkingPath(workingDir: string | undefined, filename: string): string;
  /** Read the file's full contents. */
  readAll(path: string): Uint8Array;
  /** Open for write (`'w'`) or append (`'a'`). Returns an opaque handle. */
  openForWrite(path: string, mode: 'w' | 'a'): number;
  /** Write a string chunk to a previously-opened write handle. */
  writeString(fd: number, s: string): void;
  /** Close a previously-opened write handle. */
  close(fd: number): void;
}
