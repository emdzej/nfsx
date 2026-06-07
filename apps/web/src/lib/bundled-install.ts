/**
 * Install-source marker for the top-bar pill — which of the install
 * paths the currently-mounted install came from. Mirrors the
 * inpax-web / ncsx-web shape; `"bundled"` is reserved for a future
 * ZIP-import path (not wired in this release).
 */

const STORAGE_KEY = "nfsx.web.install.source";

export type InstallSource =
  | { source: "fs-access" }
  | {
      source: "bundled";
      importedAt: string;
      fileCount: number;
      bytes: number;
    }
  | { source: "remote" };

export function getInstallSource(): InstallSource | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as InstallSource;
    if (
      parsed.source === "fs-access" ||
      parsed.source === "bundled" ||
      parsed.source === "remote"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function setInstallSource(source: InstallSource): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(source));
}

export function clearInstallSource(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
