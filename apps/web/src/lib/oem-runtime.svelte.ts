/**
 * Browser-side OEM IPO runtime — the identity / backup / verify
 * flows all boot the same shape (load IPO from VFS → construct
 * IEdiabasProvider around the connected wire → run cabimain jobs →
 * read cabd-pars).
 *
 * Held here as a small reactive `$state` blob so views can share a
 * running handle without re-loading the IPO every time the user
 * clicks another button.
 */
import { startNfsRuntime, type NfsRuntimeHandle } from "@emdzej/nfsx-runtime";
import { EdiabasXProvider } from "@emdzej/inpax-ediabasx-provider";
import { drillPath, type VirtualDirectory } from "@emdzej/bimmerz-vfs";
import type { FlashCandidate } from "@emdzej/nfsx-resolver";
import type { IEdiabas } from "@emdzej/ediabasx-core";
import { app } from "./state.svelte";
import { connection } from "./ediabas-session.svelte";

export interface OemRuntimeState {
  /** True while an IPO dispatch is in flight — drives UI spinners. */
  busy: boolean;
  /** Most recent cabd-pars snapshot (across all completed dispatches). */
  cabdPars: Map<string, string>;
  /** Per-job status codes, keyed by JOBNAME. */
  jobStatuses: Record<string, string | number | undefined>;
  /** Free-form status message for the operator. */
  status: string;
  /** Last error, if any. */
  error: string | null;
}

export const oem: OemRuntimeState = $state({
  busy: false,
  cabdPars: new Map(),
  jobStatuses: {},
  status: "",
  error: null,
});

/** Reset the shared per-session state (used when the user switches HWNR). */
export function resetOemRuntime(): void {
  oem.busy = false;
  oem.cabdPars = new Map();
  oem.jobStatuses = {};
  oem.status = "";
  oem.error = null;
}

/**
 * Locate the target IPO in the SP-Daten VFS. IPOs live under
 * `<sp-daten>/sgdat/<name>.IPO` — case-insensitive lookup handled
 * by `drillPath` + `dir.file`.
 */
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

/**
 * Build an `IEdiabasProvider` around the currently-connected wire.
 * Fails if no session exists — caller must connect first via the
 * Settings dialog's Connect flow.
 */
function requireEdiabasProvider(): { provider: EdiabasXProvider; ediabas: IEdiabas } {
  const session = connection.session;
  if (!session) {
    throw new Error(
      "Not connected. Open Settings and click Connect before running an ECU probe.",
    );
  }
  const provider = new EdiabasXProvider({
    instance: session.ediabas,
    autoConnect: false,
  });
  return { provider, ediabas: session.ediabas };
}

/**
 * The four "read live identity" IPO dispatches `nfsx check` runs.
 * ZIF_BACKUP is a fifth — added when the caller wants a snapshot too.
 */
export const IDENTITY_JOBS = [
  "HW_REFERENZ",
  "SG_STATUS_LESEN",
  "SG_IDENT_LESEN",
  "SG_AIF_LESEN",
] as const;

export interface RunIdentityInput {
  /** SGBD name resolved from the flash candidate (KFCONF row). */
  sgbd: string;
  /** IPO filename (basename), e.g. `10GD20.IPO`. */
  ipoFileName: string;
  /** Include ZIF_BACKUP in the dispatch list (5th job). */
  includeZifBackup?: boolean;
}

/**
 * Boot a runtime handle, dispatch each identity job in sequence, and
 * accumulate cabd-pars. Returns the built handle so the caller can
 * pull results out of `handle.state` — or use the reactive `oem`
 * mirror populated in-flight.
 */
export async function runIdentityJobs(
  input: RunIdentityInput,
): Promise<NfsRuntimeHandle | null> {
  resetOemRuntime();
  const spDaten = app.install?.spDaten;
  if (!spDaten) {
    oem.error =
      "No SP-Daten mounted — pick an install with EC-APPS/NFS/DATA in Settings › Data.";
    return null;
  }
  oem.busy = true;
  try {
    oem.status = `Loading IPO ${input.ipoFileName}`;
    const ipoBytes = await loadIpoBytes(spDaten, input.ipoFileName);

    oem.status = "Preparing EDIABAS provider";
    const { provider } = requireEdiabasProvider();
    await provider.init();

    oem.status = "Starting NFS runtime";
    const handle = await startNfsRuntime({
      ipoPath: input.ipoFileName,
      ipoBytes,
      sgbd: input.sgbd,
      ediabas: provider,
    });

    const jobs = input.includeZifBackup
      ? [...IDENTITY_JOBS, "ZIF_BACKUP"]
      : [...IDENTITY_JOBS];

    for (const job of jobs) {
      oem.status = `Running ${job}`;
      try {
        await handle.runCabimain(job);
        oem.jobStatuses = {
          ...oem.jobStatuses,
          [job]: handle.state.lastJobStatus ?? undefined,
        };
      } catch (err) {
        oem.jobStatuses = {
          ...oem.jobStatuses,
          [job]: err instanceof Error ? err.message : String(err),
        };
        // Continue to next job — check is a diagnostic, not a
        // hard-fail flow.
      }
    }

    oem.cabdPars = new Map(handle.state.cabdPars);
    oem.status = `Ran ${jobs.length} jobs`;
    return handle;
  } catch (err) {
    oem.error = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    oem.busy = false;
  }
}
