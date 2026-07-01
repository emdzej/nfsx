/**
 * Shared install discovery — walks a mounted root and picks out the
 * two nfsx subdirs (`EDIABAS/Ecu` for SGBDs, `EC-APPS/NFS/DATA` for
 * SP-Daten). Both are optional at discovery time — the individual
 * flash paths validate what they actually need.
 *
 * Both `InstallPicker` (first-time pick) and `SettingsDialog > Data`
 * (change folder / forget) go through this function so the derived
 * shape stays consistent regardless of which entry point mounted the
 * install.
 */
import { drillPath, type VirtualDirectory } from "@emdzej/bimmerz-vfs";
import type { NfsxInstall } from "./state.svelte";

export async function discoverInstall(root: VirtualDirectory): Promise<NfsxInstall> {
  const [ediabasEcu, spDaten] = await Promise.all([
    drillPath(root, "EDIABAS", "Ecu"),
    drillPath(root, "EC-APPS", "NFS", "DATA"),
  ]);
  return { root, ediabasEcu, spDaten };
}
