<script lang="ts">
  /**
   * Live-ECU identity probe. Mirrors `nfsx check` — dispatches the
   * 4 identity IPO jobs (HW_REFERENZ, SG_STATUS_LESEN, SG_IDENT_LESEN,
   * SG_AIF_LESEN) and surfaces every cabd-par the IPO published.
   * Extra ZIF_BACKUP dispatch toggleable.
   *
   * Wire path: uses the shared `connection.session.ediabas` set up by
   * the Settings › Connect flow — same session directmode / bootmode
   * views would use. Runs in-browser via the browser-safe
   * `startNfsRuntime` from `@emdzej/nfsx-runtime` (fileBackend omitted
   * — identity IPOs don't call fileopen).
   */
  import { resolveByHwnr, type FlashCandidate } from "@emdzej/nfsx-resolver";
  import { app } from "../../lib/state.svelte";
  import { connection } from "../../lib/ediabas-session.svelte";
  import { oem, runIdentityJobs, resetOemRuntime } from "../../lib/oem-runtime.svelte";

  let includeZifBackup = $state(false);

  const candidates = $derived.by((): FlashCandidate[] => {
    if (!app.spDaten || !app.selectedHwnr) return [];
    return resolveByHwnr(app.spDaten, app.selectedHwnr);
  });

  /**
   * Take the first KFCONF row of the first candidate as the target.
   * A polished flow would let the user pick when there are multiple
   * SG_TYPs / variants — Phase 2 keeps it linear.
   */
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

  async function runProbe(): Promise<void> {
    if (!target) return;
    await runIdentityJobs({
      sgbd: target.sgbd,
      ipoFileName: target.ipoFile,
      includeZifBackup,
    });
  }

  function backToPlan(): void {
    app.oemView = "plan";
  }

  const cabdParEntries = $derived(Array.from(oem.cabdPars.entries()).sort(([a], [b]) => a.localeCompare(b)));
  const jobStatusEntries = $derived(Object.entries(oem.jobStatuses));

  // When the HWNR changes, drop any previous results so stale data
  // doesn't linger in the panel.
  let lastHwnr: string | null = $state(null);
  $effect(() => {
    if (app.selectedHwnr !== lastHwnr) {
      lastHwnr = app.selectedHwnr;
      resetOemRuntime();
    }
  });
</script>

<div class="mx-auto max-w-4xl p-6">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-foreground">Check identity</h2>
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
        and click Connect first — the identity probe needs a live wire session.
      </div>
    {/if}

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!isConnected || oem.busy}
        onclick={runProbe}
      >
        {oem.busy ? "Running…" : "Run identity probe"}
      </button>
      <label class="flex items-center gap-1.5 text-xs text-faint">
        <input type="checkbox" bind:checked={includeZifBackup} class="accent-accent" />
        Also read <code class="font-mono">ZIF_BACKUP</code>
      </label>
    </div>

    {#if oem.status}
      <p class="mt-3 text-xs text-muted">
        <code class="font-mono">[{oem.status}]</code>
      </p>
    {/if}
    {#if oem.error}
      <div class="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
        {oem.error}
      </div>
    {/if}

    <!-- Per-job status -->
    {#if jobStatusEntries.length > 0}
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
            {#each jobStatusEntries as [job, status] (job)}
              <tr class="border-b border-divider/40">
                <td class="px-2 py-1 font-mono text-foreground">{job}</td>
                <td class="px-2 py-1 font-mono text-muted">{String(status ?? "—")}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- Cabd-pars (identity fields the IPO published) -->
    {#if cabdParEntries.length > 0}
      <div class="mt-6">
        <h3 class="text-sm font-semibold text-foreground">
          Published cabd-pars ({cabdParEntries.length})
        </h3>
        <p class="mt-1 text-xs text-faint">
          Every string the IPO wrote via <code class="font-mono">CDHSetCabdPar</code>.
          Includes VIN (<code class="font-mono">AIF_FG_NR</code>), ECU part number
          (<code class="font-mono">ID_BMW_NR</code>), ZB (<code class="font-mono">AIF_ZB_NR</code>),
          hardware kennung, project code, and every AIF row.
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
