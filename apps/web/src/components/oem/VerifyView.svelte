<script lang="ts">
  /**
   * Verify — read the ECU's current identity via IPO and optionally
   * diff against a saved backup JSON. Mirrors `nfsx verify --hwnr X
   * --against ./backups/<HWNR>-<ZB>-<ts>.json` from the CLI.
   *
   * Uses the same `runBackup` under the hood as BackupView (it's the
   * cleanest IPO-driven identity read we have), but doesn't offer
   * the JSON download — verify is a live read, not a snapshot save.
   */
  import {
    runBackup,
    type BackupReport,
  } from "@emdzej/nfsx-flash";
  import { EdiabasXProvider } from "@emdzej/inpax-ediabasx-provider";
  import { resolveByHwnr, type FlashCandidate } from "@emdzej/nfsx-resolver";
  import { app } from "../../lib/state.svelte";
  import { connection } from "../../lib/ediabas-session.svelte";
  import { createVfsStartRuntime } from "../../lib/oem-flash-runtime";

  /**
   * Cabd-par keys the CLI's `nfsx verify` surfaces. Same list — keeps
   * the operator's mental model portable between CLI and browser.
   */
  const KEY_FIELDS = [
    "ID_BMW_NR",
    "AIF_ZB_NR",
    "AIF_SW_NR",
    "AIF_FG_NR",
    "HW_REF_SG_KENNUNG",
    "HW_REF_PROJEKT",
  ] as const;

  let busy = $state(false);
  let status = $state("");
  let error = $state<string | null>(null);
  let report = $state<BackupReport | null>(null);

  let baseline = $state<Record<string, string> | null>(null);
  let baselineFilename = $state<string | null>(null);
  let baselineError = $state<string | null>(null);

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

  /**
   * Extract the `finalCabdPars` blob from either shape the CLI writes:
   *   - `{ outputPath, report: { finalCabdPars: {...} } }` (nfsx backup)
   *   - `{ finalCabdPars: {...} }` (raw BackupReport)
   */
  function extractBaseline(parsed: unknown): Record<string, string> | null {
    if (!parsed || typeof parsed !== "object") return null;
    const outer = parsed as Record<string, unknown>;
    const inner =
      (outer.report as Record<string, unknown> | undefined)?.finalCabdPars ??
      outer.finalCabdPars;
    if (!inner || typeof inner !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inner as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  async function handleBaselineUpload(event: Event): Promise<void> {
    baselineError = null;
    const target = event.target as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const extracted = extractBaseline(parsed);
      if (!extracted) {
        baselineError =
          "File didn't contain a `finalCabdPars` block — is this a backup JSON?";
        return;
      }
      baseline = extracted;
      baselineFilename = file.name;
    } catch (err) {
      baselineError = err instanceof Error ? err.message : String(err);
    }
  }

  function clearBaseline(): void {
    baseline = null;
    baselineFilename = null;
    baselineError = null;
  }

  async function runVerify(): Promise<void> {
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
    error = null;
    status = "";
    report = null;
    busy = true;
    try {
      status = "Preparing EDIABAS provider";
      const provider = new EdiabasXProvider({
        instance: session.ediabas,
        autoConnect: false,
      });
      await provider.init();

      status = "Reading ECU identity";
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
      status = "identity read complete";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function backToPlan(): void {
    app.oemView = "plan";
  }

  interface DiffRow {
    field: string;
    before?: string;
    after?: string;
    changed: boolean;
  }

  const diffRows = $derived.by((): DiffRow[] => {
    if (!report) return [];
    const current = report.finalCabdPars;
    return KEY_FIELDS.map((field) => {
      const after = current[field];
      const before = baseline?.[field];
      const changed = baseline !== null && before !== after;
      const row: DiffRow = { field, changed };
      if (after !== undefined) row.after = after;
      if (before !== undefined) row.before = before;
      return row;
    });
  });

  const changedCount = $derived(diffRows.filter((r) => r.changed).length);

  // Drop stale results when the operator switches HWNR.
  let lastHwnr: string | null = $state(null);
  $effect(() => {
    if (app.selectedHwnr !== lastHwnr) {
      lastHwnr = app.selectedHwnr;
      report = null;
      status = "";
      error = null;
    }
  });
</script>

<div class="mx-auto max-w-4xl p-6">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-foreground">Verify</h2>
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
        and click Connect first — verify needs a live wire session.
      </div>
    {/if}

    <!-- Baseline picker -->
    <div class="mt-4 rounded border border-divider bg-surface p-4">
      <div class="text-xs font-semibold uppercase tracking-wider text-faint">
        Baseline (optional)
      </div>
      <p class="mt-1 text-xs text-faint">
        Upload a <code class="font-mono">backup.json</code> from a prior run and
        we'll diff the key identity fields against the live read.
      </p>
      <div class="mt-2 flex flex-wrap items-center gap-3">
        <label class="cursor-pointer rounded border border-rule px-3 py-1.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground">
          Choose baseline…
          <input
            type="file"
            accept="application/json,.json"
            class="hidden"
            onchange={handleBaselineUpload}
          />
        </label>
        {#if baselineFilename}
          <span class="text-xs text-muted">
            <code class="font-mono">{baselineFilename}</code>
          </span>
          <button
            class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
            onclick={clearBaseline}
          >
            clear
          </button>
        {/if}
      </div>
      {#if baselineError}
        <div class="mt-2 text-xs text-red-600 dark:text-red-400">
          {baselineError}
        </div>
      {/if}
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!isConnected || busy}
        onclick={runVerify}
      >
        {busy ? "Reading…" : "Read live identity"}
      </button>
      <span class="text-xs text-faint">
        Dispatches HW_REFERENZ + SG_STATUS_LESEN + SG_IDENT_LESEN + SG_AIF_LESEN — no writes.
      </span>
    </div>

    {#if status}
      <p class="mt-3 text-xs text-muted">
        <code class="font-mono">[{status}]</code>
      </p>
    {/if}
    {#if error}
      <div class="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </div>
    {/if}

    <!-- Key-field summary + optional diff -->
    {#if report}
      <div class="mt-6">
        <h3 class="text-sm font-semibold text-foreground">
          Identity fields
          {#if baseline}
            <span class="text-xs font-normal text-faint">
              · {changedCount} changed vs baseline
            </span>
          {/if}
        </h3>
        <table class="mt-2 w-full text-xs">
          <thead>
            <tr class="border-b border-divider text-left text-faint">
              <th class="px-2 py-1 font-medium">Field</th>
              {#if baseline}
                <th class="px-2 py-1 font-medium">Baseline</th>
              {/if}
              <th class="px-2 py-1 font-medium">
                {baseline ? "Live" : "Value"}
              </th>
            </tr>
          </thead>
          <tbody>
            {#each diffRows as row (row.field)}
              <tr
                class="border-b border-divider/40"
                class:bg-amber-50={row.changed}
                class:dark:bg-amber-950={row.changed}
              >
                <td class="px-2 py-1 font-mono text-foreground">{row.field}</td>
                {#if baseline}
                  <td
                    class="px-2 py-1 font-mono"
                    class:text-red-700={row.changed}
                    class:dark:text-red-400={row.changed}
                    class:text-muted={!row.changed}
                  >
                    {row.before ?? "—"}
                  </td>
                {/if}
                <td
                  class="px-2 py-1 font-mono"
                  class:text-emerald-700={row.changed}
                  class:dark:text-emerald-400={row.changed}
                  class:text-foreground={!row.changed}
                >
                  {row.after ?? "—"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if baseline && changedCount === 0}
          <p class="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
            All {KEY_FIELDS.length} key fields match the baseline.
          </p>
        {/if}
      </div>

      <!-- Full cabd-pars snapshot -->
      <details class="mt-4">
        <summary class="cursor-pointer text-xs text-faint hover:text-muted">
          Full cabd-pars ({Object.keys(report.finalCabdPars).length} entries)
        </summary>
        <table class="mt-2 w-full text-xs">
          <thead>
            <tr class="border-b border-divider text-left text-faint">
              <th class="px-2 py-1 font-medium">Key</th>
              <th class="px-2 py-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(report.finalCabdPars).sort(([a], [b]) => a.localeCompare(b)) as [key, value] (key)}
              <tr class="border-b border-divider/40">
                <td class="px-2 py-1 font-mono text-foreground">{key}</td>
                <td class="px-2 py-1 font-mono text-muted">{value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </details>
    {/if}
  {/if}
</div>
