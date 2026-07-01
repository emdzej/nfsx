/**
 * `SpDatenSource` — filesystem abstraction the async SP-Daten loader
 * speaks. Mirrors ncsx-chassis's `ChassisSource` shape so browser
 * consumers (VFS-backed) and CLI consumers (Node fs) plug in the same
 * way.
 *
 * Paths are POSIX-style forward-slash strings, relative to the
 * source's root. Implementations own the mapping to their native
 * layout — Node fs joins with `path.sep`, VFS impls split and
 * traverse via `dir(name)`.
 */
export interface SpDatenSource {
  /** Read a file's bytes. Should reject on ENOENT — callers gate reads with `exists()`. */
  read(path: string): Promise<Uint8Array>;
  /** Cheap existence probe. Never throws — returns false on any error. */
  exists(path: string): Promise<boolean>;
  /** Best-effort directory listing. Returns [] when the dir doesn't exist. */
  list(dir: string): Promise<string[]>;
}
