/**
 * Browser-side plumbing shared by the OEM Backup and Flash views.
 *
 * The Node CLI passes `startNfsRuntimeFromPath` + `nodeBackupEmitter`
 * to `@emdzej/nfsx-flash`; here we mirror the same interfaces against
 * the mounted SP-Daten VFS + a Blob-download for the backup JSON.
 */
import { drillPath, type VirtualDirectory } from "@emdzej/bimmerz-vfs";
import {
  startNfsRuntime,
  type IpoRuntimeStart,
  type NfsRuntimeHandle,
} from "@emdzej/nfsx-runtime";
import type { BackupEmitter } from "@emdzej/nfsx-flash";

/**
 * Build an `IpoRuntimeStart` that resolves IPO basenames against
 * `<spDaten>/sgdat/`, reads bytes from the VFS, and delegates to the
 * browser-safe `startNfsRuntime`. Case-insensitive lookup handled by
 * `drillPath` + `dir.file`, matching how CheckView loads IPOs.
 *
 * The BACKUP / PRECHECK dispatches don't touch fileopen — no
 * `fileBackend` wired. PROGRAM would need one; see FlashView.
 */
export function createVfsStartRuntime(spDaten: VirtualDirectory): IpoRuntimeStart {
  return async (ipoPath: string, options): Promise<NfsRuntimeHandle> => {
    const bytes = await loadIpoBytes(spDaten, ipoPath);
    return startNfsRuntime({ ...options, ipoPath, ipoBytes: bytes });
  };
}

/**
 * `BackupEmitter` that offers the JSON as a download via a temporary
 * anchor + `URL.createObjectURL`. Returns the filename so
 * `FlashResult.backupPath` reads as an operator-friendly hint.
 */
export const browserBackupEmitter: BackupEmitter = {
  emit(filename: string, bytes: Uint8Array): string {
    // Copy into a fresh `ArrayBuffer` so `BlobPart` is happy — a
    // `Uint8Array<ArrayBufferLike>` (which is what `serializeBackup`
    // returns per DOM lib typings) isn't a `BlobPart` under strict
    // lib.dom checks.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick — Firefox needs the URL alive across
    // the click handler; `setTimeout(0)` is enough.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return filename;
  },
};

async function loadIpoBytes(
  spDaten: VirtualDirectory,
  ipoFileName: string,
): Promise<Uint8Array> {
  const sgdat = await drillPath(spDaten, "sgdat");
  if (!sgdat) {
    throw new Error(
      "sgdat/ directory not found under the SP-Daten root — cannot load IPO",
    );
  }
  const file = await sgdat.file(ipoFileName);
  if (!file) {
    throw new Error(`IPO not found in sgdat/: ${ipoFileName}`);
  }
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}
