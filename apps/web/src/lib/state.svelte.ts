import type {
  Ms4xChecksumReport as ChecksumReport,
  Ms4xEcuVariant as EcuVariant,
} from "@emdzej/nfsx-flash-data";
import type { VirtualDirectory } from "@emdzej/bimmerz-vfs";
import { loadConfig, type WebConfig } from "./config";
import { getInstallSource, type InstallSource } from "./bundled-install";

export type Scope = "oem" | "flashing";

export type OemView =
  | "picker"
  | "browse"
  | "plan"
  | "check"
  | "flash"
  | "verify";

export type FlashingTab = "checksum" | "tune" | "directmode" | "bootmode";

/**
 * Discovered install layout. Directory fields are typed as
 * `VirtualDirectory` from `@emdzej/bimmerz-vfs` so the same code
 * works against three backings:
 *
 *   • Local folder picked via `showDirectoryPicker` → `FsaDirectory`
 *   • OPFS-imported bundle (reserved — not wired yet) → `FsaDirectory`
 *   • Remote install served by `bimmerz data index` → `HttpDirectory`
 */
export interface NfsxInstall {
  /** The root the user picked / mounted. */
  root: VirtualDirectory;
  /** `<root>/EDIABAS/Ecu` — SGBD `.prg` / `.grp` files. */
  ediabasEcu: VirtualDirectory | null;
  /** `<root>/EC-APPS/NFS/DATA` — SP-Daten files. */
  spDaten: VirtualDirectory | null;
}

export interface ChecksumState {
  fileName: string | null;
  fileSize: number | null;
  variant: EcuVariant | null;
  report: ChecksumReport | null;
  rewritten: Uint8Array | null;
}

interface AppState {
  scope: Scope;

  // OEM
  oemView: OemView;
  install: NfsxInstall | null;
  /**
   * Where the currently-loaded install came from — FSA folder pick
   * or remote VFS URL. Reactive mirror of the localStorage marker
   * (`getInstallSource()`) so the top-bar source pill updates
   * mid-session when the user switches sources without reloading.
   */
  installSource: InstallSource | null;

  // Flashing
  flashingTab: FlashingTab;
  checksumState: ChecksumState;

  // Shared
  config: WebConfig;
  showSettings: boolean;
  showAbout: boolean;
  /** Whether the Bimmerz Connect session-token dialog is open. */
  showConnectSession: boolean;
  /** Bimmerz Connect: transient session ID (not persisted). */
  connectSessionId: string | null;
  /** Bimmerz Connect: transient initiator token (not persisted). */
  connectToken: string | null;
  error: string | null;
  busy: boolean;
}

export const app: AppState = $state({
  scope: "flashing",

  oemView: "picker",
  install: null,
  installSource: getInstallSource(),

  flashingTab: "checksum",
  checksumState: {
    fileName: null,
    fileSize: null,
    variant: null,
    report: null,
    rewritten: null,
  },

  config: loadConfig(),
  showSettings: false,
  showAbout: false,
  showConnectSession: false,
  connectSessionId: null,
  connectToken: null,
  error: null,
  busy: false,
});
