/**
 * Load the SP-Daten snapshot into `app.spDaten` after a fresh install
 * mount. Called from both `InstallPicker` (first mount) and
 * `SettingsDialog > Data > Change folder…` so all views see the same
 * parsed lookups.
 *
 * The install may legitimately lack an SP-Daten dir (bootmode /
 * directmode / MS45 / tune / checksum flows don't need one). We
 * surface that as `spDaten = null` and leave the OEM views to render
 * a "pick an install with SP-Daten" state.
 */
import { loadSpDatenFromSource } from "@emdzej/nfsx-resolver";
import { app, type NfsxInstall } from "./state.svelte";
import { createVfsSpDatenSource } from "./vfs-sp-daten-source";

export async function loadSpDatenIntoState(install: NfsxInstall): Promise<void> {
  app.selectedHwnr = null;
  if (!install.spDaten) {
    app.spDaten = null;
    app.spDatenLoading = false;
    return;
  }
  app.spDatenLoading = true;
  try {
    /* The SP-Daten dir the install exposes is `<root>/EC-APPS/NFS/DATA`,
       which contains `gdaten/` and `kmmData/` — the SAME layout the
       CLI's `--sp-daten` flag points at. The source is rooted there,
       so relative paths line up with the resolver's defaults. But the
       ncsx-style install may point one level up; try both to be
       tolerant. */
    const source = createVfsSpDatenSource(install.spDaten);
    const sp = await loadSpDatenFromSource(source);
    app.spDaten = sp;
  } catch (err) {
    app.spDaten = null;
    app.error = `SP-Daten load failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    app.spDatenLoading = false;
  }
}

export function clearSpDatenState(): void {
  app.spDaten = null;
  app.spDatenLoading = false;
  app.selectedHwnr = null;
}
