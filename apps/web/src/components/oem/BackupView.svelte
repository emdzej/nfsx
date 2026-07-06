<script lang="ts">
  /**
   * Pre-flash audit snapshot. Mirrors `nfsx backup` — dispatches the
   * five default backup jobs (`DEFAULT_BACKUP_JOBS` from
   * `@emdzej/nfsx-flash`), captures every cabd-par the IPO published,
   * and offers the JSON as a download.
   *
   * Not a brick-recovery image — same story as WinKFP's audit
   * backup (see `packages/flash/src/backup.ts` §11.6 for the
   * NCSEXPER walk-through).
   */
  import {
    runBackup,
    defaultBackupFilename,
    serializeBackup,
    DEFAULT_BACKUP_JOBS,
    ZIF_BACKUP_NOT_AVAILABLE,
    type BackupReport,
  } from "@emdzej/nfsx-flash";
  import { EdiabasXProvider } from "@emdzej/inpax-ediabasx-provider";
  import { resolveByHwnr, type FlashCandidate } from "@emdzej/nfsx-resolver";
  import { app } from "../../lib/state.svelte";
  import { connection } from "../../lib/ediabas-session.svelte";
  import {
    browserBackupEmitter,
    createVfsStartRuntime,
  } from "../../lib/oem-flash-runtime";

  let busy = $state(false);
  let status = $state("");
  let error = $state<string | null>(null);
  let report = $state<BackupReport | null>(null);
  let downloadedAs = $state<string | null>(null);

  const candidates = $derived.by((): FlashCandidate[] => {
    if (!app.spDaten || !app.selectedHwnr) return [];
    return resolveByHwnr(app.spDaten, app.selectedHwnr);
  });

  const target = $derived.by(() => {
    const c = candidates[0];
    if (!c) return null;
    const k = c.kfConfRows[0];
    if (!k) return null;
    return {
      sgTyp: c.sgTyp,
      sgbd: k.flashSgbd,
      ipoFile: k.ipoFile,
    };
  });

  const isConnected = $derived(connection.status.kind === "connected");

  const cabdParEntries = $derived(
    report
      ? Object.entries(report.finalCabdPars).sort(([a], [b]) =>
          a.localeCompare(b),
        )
      : [],
  );

  const dispatchEntries = $derived(
    report ? Object.entries(report.ipoDispatches) : [],
  );

  function resetState(): void {
    status = "";
    error = null;
    report = null;
    downloadedAs = null;
  }

  async function captureBackup(): Promise<void> {
    if (!target) return;
    const spDaten = app.install?.spDaten;
    if (!spDaten) {
      error =
        "No SP-Daten mounted — pick an install with EC-APPS/NFS/DATA in Settings › Data.";
      return;
    }
    const session = connection.session;
    if (!session) {
      error = "Not connected. Open Settings and click Connect first.";
      return;
    }
    resetState();
    busy = true;
    try {
      status = "Preparing EDIABAS provider";
      const provider = new EdiabasXProvider({
        instance: session.ediabas,
        autoConnect: false,
      });
      await provider.init();

      status = "Running backup dispatches";
      const startRuntime = createVfsStartRuntime(spDaten);
      const captured = await runBackup(
        {
          sgbd: target.sgbd,
          ipoPath: target.ipoFile,
          swtIpoPath: "",
          expectedHwnr: app.selectedHwnr ?? undefined,
        },
        provider,
        startRuntime,
      );
      report = captured;
      status = `${DEFAULT_BACKUP_JOBS.length} dispatches complete`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function downloadBackup(): Promise<void> {
    if (!report) return;
    const filename = defaultBackupFilename(report);
    const bytes = serializeBackup(report);
    const emitted = await browserBackupEmitter.emit(filename, bytes);
    downloadedAs = emitted ?? filename;
  }

  function backToPlan(): void {
    app.oemView = "plan";
  }

  // Drop stale results when the operator switches HWNR.
  let lastHwnr: string | null = $state(null);
  $effect(() => {
    if (app.selectedHwnr !== lastHwnr) {
      lastHwnr = app.selectedHwnr;
      resetState();
    }
  });
</script>

<div class="mx-auto max-w-4xl p-6">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-foreground">Backup identity</h2>
    <button
      class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
      onclick={backToPlan}
    >
      ← back to plan
    </button>
  </div>

  {#if !app.spDaten}
    <p class="mt-4 text-sm text-faint">
      No SP-Daten loaded — pick an install first via
      <button class="underline underline-offset-2 hover:no-underline" onclick={() => (app.showSettings = true)}>
        Settings › Data
      </button>.
    </p>
  {:else if !app.selectedHwnr}
    <p class="mt-4 text-sm text-faint">
      No HWNR selected. Go back to
      <button class="underline underline-offset-2 hover:no-underline" onclick={() => (app.oemView = "browse")}>
        Browse
      </button>
      and pick one.
    </p>
  {:else if !target}
    <p class="mt-4 text-sm text-red-600 dark:text-red-400">
      No KFCONF candidate for HWNR <code class="font-mono">{app.selectedHwnr}</code>
      — SP-Daten doesn't declare a flashable variant for this part.
    </p>
  {:else}
    <div class="mt-4 rounded border border-divider bg-surface p-4 text-sm">
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt class="text-faint">HWNR</dt>
        <dd class="font-mono text-foreground">{app.selectedHwnr}</dd>
        <dt class="text-faint">SG_TYP</dt>
        <dd class="font-mono text-foreground">{target.sgTyp}</dd>
        <dt class="text-faint">SGBD</dt>
        <dd class="font-mono text-foreground">{target.sgbd}</dd>
        <dt class="text-faint">IPO</dt>
        <dd class="font-mono text-foreground">{target.ipoFile}</dd>
      </dl>
    </div>

    {#if !isConnected}
      <div class="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-300">
        <strong>Not connected.</strong> Open
        <button class="underline underline-offset-2 hover:no-underline" onclick={() => (app.showSettings = true)}>
          Settings
        </button>
        and click Connect first — the backup dispatches need a live wire session.
      </div>
    {/if}

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!isConnected || busy}
        onclick={captureBackup}
      >
        {busy ? "Running…" : "Capture backup"}
      </button>
      <button
        class="rounded border border-rule px-3 py-1.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!report}
        onclick={downloadBackup}
      >
        Download backup.json
      </button>
      <span class="text-xs text-faint">
        Runs {DEFAULT_BACKUP_JOBS.join(", ")} — no writes to the ECU.
      </span>
    </div>

    {#if status}
      <p class="mt-3 text-xs text-muted">
        <code class="font-mono">[{status}]</code>
      </p>
    {/if}
    {#if downloadedAs}
      <p class="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
        Downloaded as <code class="font-mono">{downloadedAs}</code>.
      </p>
    {/if}
    {#if error}
      <div class="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </div>
    {/if}

    {#if dispatchEntries.length > 0}
      <div class="mt-6">
        <h3 class="text-sm font-semibold text-foreground">Job dispatches</h3>
        <table class="mt-2 w-full text-xs">
          <thead>
            <tr class="border-b border-divider text-left text-faint">
              <th class="px-2 py-1 font-medium">Job</th>
              <th class="px-2 py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each dispatchEntries as [job, result] (job)}
              <tr class="border-b border-divider/40">
                <td class="px-2 py-1 font-mono text-foreground">{job}</td>
                <td class="px-2 py-1 font-mono">
                  {#if "error" in result}
                    <span class="text-red-600 dark:text-red-400">error: {result.error}</span>
                  {:else if result.setjobstatus === 0}
                    <span class="text-emerald-600 dark:text-emerald-400">ok</span>
                  {:else if job === "ZIF_BACKUP" && result.setjobstatus === ZIF_BACKUP_NOT_AVAILABLE}
                    <span class="text-muted">no backup data (redundant region empty)</span>
                  {:else}
                    <span class="text-amber-600 dark:text-amber-400">
                      setjobstatus={result.setjobstatus}
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if cabdParEntries.length > 0}
      <div class="mt-6">
        <h3 class="text-sm font-semibold text-foreground">
          Final cabd-pars ({cabdParEntries.length})
        </h3>
        <p class="mt-1 text-xs text-faint">
          Merged snapshot the IPO published across every dispatch — the
          same payload that goes into <code class="font-mono">backup.json</code>.
        </p>
        <table class="mt-2 w-full text-xs">
          <thead>
            <tr class="border-b border-divider text-left text-faint">
              <th class="px-2 py-1 font-medium">Key</th>
              <th class="px-2 py-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {#each cabdParEntries as [key, value] (key)}
              <tr class="border-b border-divider/40">
                <td class="px-2 py-1 font-mono text-foreground">{key}</td>
                <td class="px-2 py-1 font-mono text-muted">{value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>
