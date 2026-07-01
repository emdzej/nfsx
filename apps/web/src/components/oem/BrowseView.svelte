<script lang="ts">
  /**
   * SP-Daten HWNR browser. Mirrors the offline half of `nfsx browse`
   * (the ink TUI) — enter a partial or full 7-digit HWNR, get the
   * matching rows from `HWNR.DA2`, click through to Plan for the
   * full resolved context.
   *
   * All lookups run against the parsed SP-Daten snapshot in
   * `app.spDaten` — no wire access.
   */
  import { app } from "../../lib/state.svelte";

  let query = $state("");

  /**
   * Deduplicate HWNR rows by (hwnr, sgTyp) — the same pair can appear
   * on multiple lines when BMW dupes rows. Sort by hwnr then sgTyp
   * for stable rendering.
   */
  const filtered = $derived.by(() => {
    const rows = app.spDaten?.hwnr?.rows ?? [];
    const q = query.trim().toLowerCase();
    // Empty query — show first 50 as a preview so the page isn't
    // blank on landing.
    const src = q === ""
      ? rows.slice(0, 50)
      : rows.filter(
          (r) =>
            r.hwnr.toLowerCase().includes(q) ||
            r.sgTyp.toLowerCase().includes(q),
        );
    const seen = new Set<string>();
    const out: typeof rows = [];
    for (const r of src) {
      const key = `${r.hwnr}|${r.sgTyp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= 200) break; // cap to keep the DOM light
    }
    return out.sort((a, b) => {
      if (a.hwnr !== b.hwnr) return a.hwnr.localeCompare(b.hwnr);
      return a.sgTyp.localeCompare(b.sgTyp);
    });
  });

  const totalRows = $derived(app.spDaten?.hwnr?.rows.length ?? 0);
  const distinctHwnrs = $derived(app.spDaten?.hwnr?.byHwnr.size ?? 0);
  const distinctSgTyps = $derived(app.spDaten?.hwnr?.bySgTyp.size ?? 0);

  function pick(hwnr: string): void {
    app.selectedHwnr = hwnr;
    app.oemView = "plan";
  }
</script>

<div class="mx-auto max-w-4xl p-6">
  <h2 class="text-lg font-bold text-foreground">Browse SP-Daten</h2>

  {#if !app.install?.spDaten}
    <div class="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-300">
      No SP-Daten folder found in the mounted install. Expected
      <code class="font-mono">EC-APPS/NFS/DATA/</code> inside the picked root.
      Pick a different install via
      <button
        class="underline underline-offset-2 hover:no-underline"
        onclick={() => (app.showSettings = true)}
      >
        Settings › Data
      </button>.
    </div>
  {:else if app.spDatenLoading}
    <p class="mt-4 text-sm text-faint">Loading SP-Daten…</p>
  {:else if !app.spDaten}
    <p class="mt-4 text-sm text-red-600 dark:text-red-400">
      SP-Daten load failed. See error banner.
    </p>
  {:else if !app.spDaten.hwnr}
    <p class="mt-4 text-sm text-red-600 dark:text-red-400">
      HWNR.DA2 missing from this SP-Daten drop — nothing to browse.
    </p>
    {#if app.spDaten.warnings.length > 0}
      <ul class="mt-2 space-y-0.5 text-xs text-faint">
        {#each app.spDaten.warnings as w}
          <li>· {w}</li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p class="mt-1 text-sm text-muted">
      {totalRows.toLocaleString()} rows · {distinctHwnrs.toLocaleString()}
      distinct HWNRs · {distinctSgTyps.toLocaleString()} SG variants
    </p>

    <div class="mt-4">
      <input
        type="text"
        class="w-full rounded border border-rule bg-base px-3 py-1.5 font-mono text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
        placeholder="Search by HWNR (e.g. 7544721) or SG_TYP (e.g. GD20)"
        bind:value={query}
      />
    </div>

    {#if app.spDaten.parseErrors.length > 0}
      <details class="mt-3 rounded border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs dark:border-amber-600/40 dark:bg-amber-950/20">
        <summary class="cursor-pointer text-amber-800 dark:text-amber-300">
          {app.spDaten.parseErrors.length} parse error{app.spDaten.parseErrors.length === 1 ? "" : "s"}
        </summary>
        <ul class="mt-2 space-y-0.5 font-mono text-[11px] text-muted">
          {#each app.spDaten.parseErrors.slice(0, 20) as pe}
            <li>{pe.source}:{pe.lineNo} — {pe.reason}</li>
          {/each}
          {#if app.spDaten.parseErrors.length > 20}
            <li class="text-faint">… + {app.spDaten.parseErrors.length - 20} more</li>
          {/if}
        </ul>
      </details>
    {/if}

    <div class="mt-4">
      {#if filtered.length === 0}
        <p class="text-sm text-faint">
          {#if query.trim()}
            No matches for <code class="font-mono">{query}</code>.
          {:else}
            No rows.
          {/if}
        </p>
      {:else}
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-divider text-left text-faint">
              <th class="px-2 py-1.5 font-medium">HWNR</th>
              <th class="px-2 py-1.5 font-medium">SG_TYP</th>
              <th class="px-2 py-1.5 font-medium">AT-HWNR</th>
              <th class="px-2 py-1.5 font-medium">EP-TSNR</th>
              <th class="px-2 py-1.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as row (row.hwnr + "|" + row.sgTyp)}
              <tr class="border-b border-divider/50 hover:bg-elevated">
                <td class="px-2 py-1.5 font-mono text-foreground">{row.hwnr}</td>
                <td class="px-2 py-1.5 font-mono text-foreground">{row.sgTyp}</td>
                <td class="px-2 py-1.5 font-mono text-muted">
                  {row.atHwnr === "0000000" ? "—" : row.atHwnr}
                </td>
                <td class="px-2 py-1.5 font-mono text-muted">
                  {row.epTsnr === "0000000" ? "—" : row.epTsnr}
                </td>
                <td class="px-2 py-1.5 text-right">
                  <button
                    class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground"
                    onclick={() => pick(row.hwnr)}
                  >
                    Plan →
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if query.trim() === "" && totalRows > 50}
          <p class="mt-2 text-xs text-faint">
            Showing first 50 of {totalRows.toLocaleString()} — type to filter.
          </p>
        {:else if filtered.length >= 200}
          <p class="mt-2 text-xs text-faint">
            Showing first 200 — narrow the query for a full listing.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
