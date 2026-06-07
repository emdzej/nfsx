import { getLogger } from "@emdzej/bimmerz-logger";

const log = getLogger("NFSX.web.install-storage");

const DB_NAME = "nfsx-web";
const DB_VERSION = 1;
const STORE_NAME = "install";
const RECORD_KEY = "root";

type PermissionState = "granted" | "denied" | "prompt";

type HandleWithPermissions = {
  queryPermission?: (desc?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (desc?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveInstallHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).put(handle, RECORD_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch (err) {
    log.warn({ err }, "save failed");
  }
}

export async function loadInstallHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        req.onsuccess = () =>
          resolve((req.result as FileSystemDirectoryHandle) ?? null);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    return handle;
  } catch (err) {
    log.warn({ err }, "load failed");
    return null;
  }
}

export async function clearInstallHandle(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch (err) {
    log.warn({ err }, "clear failed");
  }
}

export async function queryHandlePermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const h = handle as unknown as HandleWithPermissions;
  if (!h.queryPermission) return "prompt";
  try {
    return await h.queryPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

export async function requestHandlePermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const h = handle as unknown as HandleWithPermissions;
  if (!h.requestPermission) return "prompt";
  try {
    return await h.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/* ── Remote install URL ──────────────────────────────────────────── */

const REMOTE_URL_KEY = "nfsx.web.install.remoteUrl";

export function saveRemoteInstallUrl(url: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(REMOTE_URL_KEY, url);
}

export function loadRemoteInstallUrl(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(REMOTE_URL_KEY);
}

export function clearRemoteInstallUrl(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(REMOTE_URL_KEY);
}
