import type {
  Ms4xChecksumReport as ChecksumReport,
  Ms4xEcuVariant as EcuVariant,
} from "@emdzej/nfsx-flash-data";
import { loadConfig, type WebConfig } from "./config";

export type Scope = "oem" | "flashing";

export type OemView =
  | "picker"
  | "browse"
  | "plan"
  | "check"
  | "flash"
  | "verify";

export type FlashingTab = "checksum" | "directmode" | "bootmode";

export interface NfsxInstall {
  root: FileSystemDirectoryHandle;
  ediabasEcu: FileSystemDirectoryHandle | null;
  spDaten: FileSystemDirectoryHandle | null;
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

  // Flashing
  flashingTab: FlashingTab;
  checksumState: ChecksumState;

  // Shared
  config: WebConfig;
  showSettings: boolean;
  showAbout: boolean;
  error: string | null;
  busy: boolean;
}

export const app: AppState = $state({
  scope: "flashing",

  oemView: "picker",
  install: null,

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
  error: null,
  busy: false,
});
