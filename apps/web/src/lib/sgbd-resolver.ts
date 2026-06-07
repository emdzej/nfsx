/**
 * Loader function for `@emdzej/ediabasx-ediabas`'s `loadSgbdResolver`
 * config slot. Given an SGBD short name (`ACC65`, `MS43`, …), returns
 * the bytes + resolved filename of the matching `.prg` or `.grp`
 * file from the user-picked EDIABAS/Ecu directory.
 *
 * Backed by `@emdzej/bimmerz-vfs`'s `VirtualDirectory` so the same
 * resolver works for local FSA picks and remote `bimmerz data
 * index`-served installs without branching at the call site.
 *
 * Case-insensitive at every step — `dir.file(name)` is documented
 * as case-insensitive on the VFS contract. Probes both `.prg` and
 * `.grp` when the caller passes a bare name (matches native
 * EDIABAS `ResolveSgbdFile`).
 */
import type { VirtualDirectory } from "@emdzej/bimmerz-vfs";

export function makeBrowserSgbdResolver(
  ecuDir: VirtualDirectory,
): (filename: string) => Promise<{ bytes: Uint8Array; name: string }> {
  return async (filename) => {
    const lower = filename.toLowerCase();
    const candidates: string[] = [];
    if (lower.endsWith(".prg") || lower.endsWith(".grp")) {
      candidates.push(filename);
      candidates.push(
        lower.endsWith(".prg")
          ? `${filename.slice(0, -4)}.grp`
          : `${filename.slice(0, -4)}.prg`,
      );
    } else {
      candidates.push(`${filename}.prg`, `${filename}.grp`);
    }
    for (const candidate of candidates) {
      const file = await ecuDir.file(candidate);
      if (!file) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, name: file.name };
    }
    throw new Error(`SGBD not found in EDIABAS/Ecu: ${filename}`);
  };
}
