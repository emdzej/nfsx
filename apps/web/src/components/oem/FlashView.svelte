<script lang="ts">
  /**
   * Browser flash driver. Mirrors `nfsx flash` — wraps `FlashSession`
   * from `@emdzej/nfsx-flash` and streams the 5-stage progress
   * (RESOLVE → PRECHECK → BACKUP → PROGRAM → POSTCHECK) into the UI.
   *
   * Scope for the current cut:
   *   - Dry-run is the default and only supported path in-browser.
   *     Full destructive flash needs a VFS-backed `FileBackend` for
   *     the `.0PA`/`.0DA` reads the IPO does via `CABFOpen` — that's
   *     a follow-up. Meanwhile the CLI (`nfsx flash --write`)
   *     handles the destructive path with the Node fileBackend.
   *   - Backup runs by default with the browser Blob-download
   *     emitter, so an operator gets an audit trail even on a
   *     dry-run.
   */
  import {
    FlashSession,
    defaultBackupFilename,
    type FlashEvent,
    type FlashResult,
    type Stage,
  } from "@emdzej/nfsx-flash";
  import { EdiabasXProvider } from "@emdzej/inpax-ediabasx-provider";
  import {
    loadZbNrTabForSgFromSource,
    resolveByHwnr,
    type FlashCandidate,
  } from "@emdzej/nfsx-resolver";
  import { findByHwNr, type ZbNrTabRow } from "@emdzej/nfsx-data-files";
  import { drillPath } from "@emdzej/bimmerz-vfs";
  import { app } from "../../lib/state.svelte";
  import { connection } from "../../lib/ediabas-session.svelte";
  import {
    browserBackupEmitter,
    createVfsStartRuntime,
  } from "../../lib/oem-flash-runtime";
  import { createVfsSpDatenSource } from "../../lib/vfs-sp-daten-source";

  const STAGES: Stage[] = ["RESOLVE", "PRECHECK", "BACKUP", "PROGRAM", "POSTCHECK"];

  type StageState = "pending" | "running" | "done" | "skipped" | "error";

  let busy = $state(false);
  let error = $state<string | null>(null);
  let events = $state<FlashEvent[]>([]);
  let stageStates = $state<Record<Stage, StageState>>({
    RESOLVE: "pending",
    PRECHECK: "pending",
    BACKUP: "pending",
    PROGRAM: "pending",
    POSTCHECK: "pending",
  });
  let result = $state<FlashResult | null>(null);
  let confirmText = $state("");

  // Options mirror the CLI flags.
  let dryRun = $state(true);
  let skipBackup = $state(false);
  let skipPostcheck = $state(false);

  // ZB choice from the per-SG .DAT — auto-picked when there's only one.
  let zbRows = $state<ZbNrTabRow[] | null>(null);
  let zbLoadError = $state<string | null>(null);
  let selectedZbNr = $state<string | null>(null);
  let firmwareLoading = $state(false);

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
      datFile: k.datFile,
    };
  });

  const selectedZb = $derived(
    zbRows?.find((r) => r.zbNr === selectedZbNr) ?? null,
  );

  const isConnected = $derived(connection.status.kind === "connected");

  /**
   * Load ZB candidates whenever the target changes. Auto-pick the
   * single-candidate case to match the CLI's `resolveFlashContext`
   * single-candidate branch.
   */
  $effect(() => {
    const spDatenDir = app.install?.spDaten;
    const hwnr = app.selectedHwnr;
    const t = target;
    zbRows = null;
    selectedZbNr = null;
    zbLoadError = null;
    if (!spDatenDir || !hwnr || !t) return;
    const source = createVfsSpDatenSource(spDatenDir);
    loadZbNrTabForSgFromSource(source, t.sgTyp, t.datFile)
      .then((tab) => {
        const rows = tab ? findByHwNr(tab, hwnr) : [];
        zbRows = rows;
        if (rows.length === 1) selectedZbNr = rows[0]!.zbNr;
      })
      .catch((err) => {
        zbLoadError = err instanceof Error ? err.message : String(err);
      });
  });

  /**
   * Read the firmware `.0PA` bytes from `<spDaten>/data/<SG_TYP>/`.
   * Case-insensitive on filename to survive on-disk casing drift.
   */
  async function loadFirmwareBytes(
    sgTyp: string,
    programFile: string,
  ): Promise<Uint8Array> {
    const spDaten = app.install?.spDaten;
    if (!spDaten) throw new Error("SP-Daten VFS not mounted");
    const dataDir = await drillPath(spDaten, "data", sgTyp);
    if (!dataDir) {
      throw new Error(`data/${sgTyp}/ directory not found in SP-Daten`);
    }
    const file = await dataDir.file(programFile);
    if (!file) {
      throw new Error(`Firmware ${programFile} not found in data/${sgTyp}/`);
    }
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Locate any `sgdat/00swt*.ipo`. If there are multiple we take the
   * first — matches CLI's single-file auto-pick; multi-transport
   * chassis would need an explicit transport selector.
   */
  async function findSwtIpoBasename(): Promise<string | null> {
    const spDaten = app.install?.spDaten;
    if (!spDaten) return null;
    const sgdat = await drillPath(spDaten, "sgdat");
    if (!sgdat) return null;
    const entries = await sgdat.entries();
    const swt = entries.find(
      (e) => e.kind === "file" && /^00swt[a-z0-9_]*\.ipo$/i.test(e.name),
    );
    return swt?.name ?? null;
  }

  function resetRunState(): void {
    events = [];
    result = null;
    error = null;
    stageStates = {
      RESOLVE: "pending",
      PRECHECK: "pending",
      BACKUP: "pending",
      PROGRAM: "pending",
      POSTCHECK: "pending",
    };
  }

  function applyEvent(e: FlashEvent): void {
    // Append + reassign for reactivity.
    events = [...events, e];
    if (e.type === "stage:start") {
      stageStates = { ...stageStates, [e.stage]: "running" };
    } else if (e.type === "stage:done") {
      stageStates = { ...stageStates, [e.stage]: "done" };
    } else if (e.type === "stage:skipped") {
      stageStates = { ...stageStates, [e.stage]: "skipped" };
    }
  }

  async function runFlash(): Promise<void> {
    if (!target || !selectedZb) return;
    const spDaten = app.install?.spDaten;
    if (!spDaten) {
      error = "No SP-Daten mounted.";
      return;
    }
    const session = connection.session;
    if (!session) {
      error = "Not connected — open Settings and click Connect first.";
      return;
    }
    if (!dryRun && confirmText.trim().toUpperCase() !== "FLASH") {
      error =
        'Destructive flash requires typing "FLASH" in the confirmation box.';
      return;
    }

    resetRunState();
    busy = true;
    firmwareLoading = true;
    try {
      const fwBytes = await loadFirmwareBytes(target.sgTyp, selectedZb.programFile);
      firmwareLoading = false;

      const swtBasename = (await findSwtIpoBasename()) ?? "";

      const provider = new EdiabasXProvider({
        instance: session.ediabas,
        autoConnect: false,
      });
      await provider.init();

      const flashSession = new FlashSession({
        ecu: {
          sgbd: target.sgbd,
          ipoPath: target.ipoFile,
          swtIpoPath: swtBasename,
          expectedHwnr: app.selectedHwnr ?? undefined,
          // workingDir is host-relative — the browser fileBackend
          // (not yet wired) would resolve `.0PA`/`.0DA` under here.
          // Left blank for dry-run.
        },
        firmware: { paDaBytes: fwBytes },
        ediabas: provider,
        startRuntime: createVfsStartRuntime(spDaten),
        backup: { emitter: browserBackupEmitter },
      });
      flashSession.on("event", applyEvent);

      const runResult = await flashSession.run({
        dryRun,
        skipBackup,
        skipPostcheck,
        // Real destructive flash requires a VFS fileBackend — the CLI
        // does this via `nodeFileBackend()`. In-browser dry-run only.
        confirm: () => confirmText.trim().toUpperCase() === "FLASH",
      });
      result = runResult;
      if (!runResult.ok && runResult.abortedAt) {
        stageStates = { ...stageStates, [runResult.abortedAt]: "error" };
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      firmwareLoading = false;
    }
  }

  function backToPlan(): void {
    app.oemView = "plan";
  }

  // Drop the run state when the HWNR changes.
  let lastHwnr: string | null = $state(null);
  $effect(() => {
    if (app.selectedHwnr !== lastHwnr) {
      lastHwnr = app.selectedHwnr;
      resetRunState();
      confirmText = "";
    }
  });

  const backupFilenamePreview = $derived.by((): string => {
    if (!target || !selectedZb) return "backup.json";
    return defaultBackupFilename({
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      target: {
        sgbd: target.sgbd,
        ipoPath: target.ipoFile,
        expectedHwnr: app.selectedHwnr ?? undefined,
      },
      ipoDispatches: {},
      finalCabdPars: {
        ID_BMW_NR: app.selectedHwnr ?? "",
        AIF_ZB_NR: selectedZb.zbNr,
      },
      systemData: {},
    });
  });
</script>

<div class="mx-auto max-w-4xl p-6">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-foreground">Flash</h2>
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
      No KFCONF candidate for HWNR <code class="font-mono">{app.selectedHwnr}</code>.
    </p>
  {:else}
    <!-- Target summary -->
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

    <!-- ZB / firmware selection -->
    {#if zbLoadError}
      <p class="mt-3 text-xs text-red-600 dark:text-red-400">
        Failed to load ZB rows: {zbLoadError}
      </p>
    {:else if zbRows === null}
      <p class="mt-3 text-xs text-faint">Loading ZB candidates…</p>
    {:else if zbRows.length === 0}
      <p class="mt-3 text-xs text-red-600 dark:text-red-400">
        No ZB rows for HWNR <code class="font-mono">{app.selectedHwnr}</code>
        in <code class="font-mono">data/{target.sgTyp}/{target.datFile}</code>.
      </p>
    {:else}
      <div class="mt-4">
        <div class="mb-1 text-xs font-semibold uppercase tracking-wider text-faint">
          Firmware ZB ({zbRows.length} candidate{zbRows.length === 1 ? "" : "s"})
        </div>
        <select
          class="w-full rounded border border-rule bg-base px-3 py-1.5 font-mono text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          bind:value={selectedZbNr}
          disabled={busy || zbRows.length === 1}
        >
          {#if zbRows.length > 1 && selectedZbNr === null}
            <option value={null} disabled>— pick a ZB —</option>
          {/if}
          {#each zbRows as row (row.zbNr)}
            <option value={row.zbNr}>
              {row.zbNr} — {row.programFile}
              {row.dataFile ? `+ ${row.dataFile}` : ""}
            </option>
          {/each}
        </select>
      </div>
    {/if}

    {#if !isConnected}
      <div class="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-300">
        <strong>Not connected.</strong> Open
        <button class="underline underline-offset-2 hover:no-underline" onclick={() => (app.showSettings = true)}>
          Settings
        </button>
        and click Connect first — the flash pipeline needs a live wire session.
      </div>
    {/if}

    <!-- Run controls -->
    <div class="mt-4 space-y-2 rounded border border-divider bg-surface p-4">
      <div class="text-xs font-semibold uppercase tracking-wider text-faint">
        Options
      </div>
      <label class="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" bind:checked={dryRun} class="accent-accent" />
        Dry-run (skips PROGRAM — safe, mirrors <code class="font-mono">nfsx flash</code> without <code class="font-mono">--write</code>)
      </label>
      <label class="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" bind:checked={skipBackup} class="accent-accent" />
        Skip BACKUP stage
      </label>
      <label class="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" bind:checked={skipPostcheck} class="accent-accent" />
        Skip POSTCHECK stage
      </label>
      {#if !skipBackup}
        <p class="pl-6 text-xs text-faint">
          Backup will download as <code class="font-mono">{backupFilenamePreview}</code>
          when the BACKUP stage completes.
        </p>
      {/if}
      {#if !dryRun}
        <div class="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-600/40 dark:bg-red-950/30">
          <p class="font-semibold text-red-800 dark:text-red-300">
            Destructive flash is not yet supported in the browser.
          </p>
          <p class="mt-1 text-xs text-red-700 dark:text-red-400">
            The IPO reads <code class="font-mono">.0PA</code>/<code class="font-mono">.0DA</code>
            via <code class="font-mono">CABFOpen</code> — the CLI plumbs those through
            <code class="font-mono">nodeFileBackend()</code>; the equivalent VFS-backed
            <code class="font-mono">FileBackend</code> is still to do. Type
            <code class="font-mono">FLASH</code> below and press Run to try anyway; the
            PROGRAM stage will surface the concrete error.
          </p>
          <input
            type="text"
            placeholder='type "FLASH" to confirm'
            bind:value={confirmText}
            class="mt-2 w-full rounded border border-red-400 bg-white px-2 py-1 font-mono text-sm text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-200"
          />
        </div>
      {/if}
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!isConnected || busy || !selectedZb}
        onclick={runFlash}
      >
        {busy ? "Running…" : dryRun ? "Run dry-run" : "Run destructive"}
      </button>
      {#if firmwareLoading}
        <span class="text-xs text-faint">Loading firmware…</span>
      {/if}
    </div>

    {#if error}
      <div class="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </div>
    {/if}

    <!-- Stage strip -->
    {#if events.length > 0 || busy}
      <div class="mt-6">
        <h3 class="text-sm font-semibold text-foreground">Pipeline</h3>
        <div class="mt-2 flex gap-2">
          {#each STAGES as stage (stage)}
            {@const s = stageStates[stage]}
            <div
              class="flex-1 rounded border px-2 py-1 text-center text-xs font-mono"
              class:border-divider={s === "pending"}
              class:bg-surface={s === "pending"}
              class:text-faint={s === "pending"}
              class:border-accent={s === "running"}
              class:bg-elevated={s === "running"}
              class:text-accent={s === "running"}
              class:border-emerald-500={s === "done"}
              class:bg-emerald-50={s === "done"}
              class:text-emerald-700={s === "done"}
              class:border-amber-400={s === "skipped"}
              class:bg-amber-50={s === "skipped"}
              class:text-amber-700={s === "skipped"}
              class:border-red-500={s === "error"}
              class:bg-red-50={s === "error"}
              class:text-red-700={s === "error"}
            >
              {stage}
              {#if s === "done"}✓{/if}
              {#if s === "skipped"}·{/if}
              {#if s === "error"}✗{/if}
              {#if s === "running"}…{/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Event log -->
    {#if events.length > 0}
      <div class="mt-4">
        <h3 class="text-sm font-semibold text-foreground">Log</h3>
        <div class="mt-2 max-h-64 overflow-y-auto rounded border border-divider bg-base p-2 font-mono text-xs">
          {#each events as e, i (i)}
            {#if e.type === "stage:start"}
              <div class="text-accent">▶ {e.stage}</div>
            {:else if e.type === "stage:done"}
              <div class="text-emerald-600 dark:text-emerald-400">
                ✓ {e.stage} ({e.durationMs}ms)
              </div>
            {:else if e.type === "stage:skipped"}
              <div class="text-amber-600 dark:text-amber-400">
                · {e.stage} skipped ({e.reason})
              </div>
            {:else if e.type === "log"}
              <div
                class:text-faint={e.level === "info"}
                class:text-amber-600={e.level === "warn"}
                class:text-red-600={e.level === "error"}
              >
                &nbsp;&nbsp;{e.level}: {e.message}
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/if}

    <!-- Result summary -->
    {#if result}
      <div class="mt-4 rounded border border-divider bg-surface p-3 text-sm">
        <div class="flex items-baseline gap-2">
          <span
            class="font-semibold"
            class:text-emerald-600={result.ok}
            class:text-red-600={!result.ok}
          >
            {result.ok ? "flash complete" : "flash aborted"}
          </span>
          <span class="text-xs text-faint">
            dryRun={result.dryRun}, {result.totalBytes} bytes
          </span>
        </div>
        {#if result.abortedAt}
          <p class="mt-1 text-xs text-red-700 dark:text-red-400">
            Aborted at <code class="font-mono">{result.abortedAt}</code>:
            {result.abortReason}
          </p>
        {/if}
        {#if result.backupPath}
          <p class="mt-1 text-xs text-muted">
            Backup: <code class="font-mono">{result.backupPath}</code>
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</div>
