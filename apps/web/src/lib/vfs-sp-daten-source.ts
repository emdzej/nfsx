/**
 * `SpDatenSource` implementation backed by a `VirtualDirectory` from
 * `@emdzej/bimmerz-vfs`. Handles either FSA (locally-picked folder)
 * or HTTP (remote `bimmerz data index`) transparently — that's what
 * `VirtualDirectory` abstracts.
 *
 * Paths are POSIX-style forward slashes rooted at the SP-Daten dir
 * the user picked (typically `<install-root>/EC-APPS/NFS/DATA`).
 * `drillPath` walks segments case-insensitively so on-disk casing
 * variations (BMW installs mix `DATEN`, `Daten`, `daten`) don't
 * matter.
 */
import { drillPath, type VirtualDirectory } from "@emdzej/bimmerz-vfs";
import type { SpDatenSource } from "@emdzej/nfsx-resolver";

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export function createVfsSpDatenSource(root: VirtualDirectory): SpDatenSource {
  return {
    async read(path: string): Promise<Uint8Array> {
      const segments = splitPath(path);
      if (segments.length === 0) throw new Error(`empty path`);
      const fileName = segments[segments.length - 1]!;
      const parentSegments = segments.slice(0, -1);
      const parent =
        parentSegments.length === 0
          ? root
          : await drillPath(root, ...parentSegments);
      if (!parent) throw new Error(`directory not found: ${parentSegments.join("/")}`);
      const file = await parent.file(fileName);
      if (!file) throw new Error(`file not found: ${path}`);
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    },

    async exists(path: string): Promise<boolean> {
      try {
        const segments = splitPath(path);
        if (segments.length === 0) return false;
        const fileName = segments[segments.length - 1]!;
        const parentSegments = segments.slice(0, -1);
        const parent =
          parentSegments.length === 0
            ? root
            : await drillPath(root, ...parentSegments);
        if (!parent) return false;
        return (await parent.file(fileName)) !== null;
      } catch {
        return false;
      }
    },

    async list(dir: string): Promise<string[]> {
      try {
        const segments = splitPath(dir);
        const target =
          segments.length === 0 ? root : await drillPath(root, ...segments);
        if (!target) return [];
        const entries = await target.entries();
        return entries.map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}
