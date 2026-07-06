<script lang="ts">
  /**
   * Resolved flash plan for `app.selectedHwnr`. Mirrors what
   * `nfsx plan --hwnr X` prints — candidate SG_TYPs, KFCONF rows
   * (IPO / SGBD / working files), per-HWNR flash-file rows from the
   * per-SG `.DAT` table, kmm_SIT + prgifsel metadata.
   *
   * ZB rows are loaded async on demand via the VFS SpDatenSource,
   * so we don't front-load per-SG `.DAT` files that most users
   * won't look at.
   */
  import {
    resolveByHwnr,
    loadZbNrTabForSgFromSource,
    type FlashCandidate,
  } from "@emdzej/nfsx-resolver";
  import { findByHwNr, type ZbNrTabRow } from "@emdzej/nfsx-data-files";
  import { app } from "../../lib/state.svelte";
  import { createVfsSpDatenSource } from "../../lib/vfs-sp-daten-source";

  // Text input for editing the HWNR without going back to Browse.
  let queryInput = $state(app.selectedHwnr ?? "");
  $effect(() => {
    if (app.selectedHwnr !== null && queryInput === "") {
      queryInput = app.selectedHwnr;
    }
  });

  const candidates = $derived.by((): FlashCandidate[] => {
    if (!app.spDaten || !app.selectedHwnr) return [];
    return resolveByHwnr(app.spDaten, app.selectedHwnr);
  });

  // Async ZB-NR row load per (SG_TYP, .DAT filename). Keyed by
  // `${sgTyp}|${datFile}` — cached across renders.
  const zbCache = new Map<string, Promise<ZbNrTabRow[]>>();

  function keyFor(sgTyp: string, datFile: string): string {
    return `${sgTyp}|${datFile}`;
  }

  function loadZbRows(sgTyp: string, datFile: string): Promise<ZbNrTabRow[]> {
    const key = keyFor(sgTyp, datFile);
    const cached = zbCache.get(key);
    if (cached) return cached;
    const hwnr = app.selectedHwnr;
    const spDatenDir = app.install?.spDaten;
    if (!hwnr || !spDatenDir) {
      const empty = Promise.resolve<ZbNrTabRow[]>([]);
      zbCache.set(key, empty);
      return empty;
    }
    const source = createVfsSpDatenSource(spDatenDir);
    const p = loadZbNrTabForSgFromSource(source, sgTyp, datFile).then((tab) =>
      tab ? findByHwNr(tab, hwnr) : [],
    );
    zbCache.set(key, p);
    return p;
  }

  function search(): void {
    const trimmed = queryInput.trim();
    if (trimmed.length === 0) return;
    app.selectedHwnr = trimmed;
    zbCache.clear();
  }

  function backToBrowse(): void {
    app.oemView = "browse";
  }
</script>

<div class="mx-auto max-w-4xl p-6">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-foreground">Flash Plan</h2>
    <button
      class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
      onclick={backToBrowse}
    >
      ← back to browse
    </button>
  </div>

  {#if !app.spDaten}
    <p class="mt-4 text-sm text-faint">
      No SP-Daten loaded — pick an install first via
      <button class="underline underline-offset-2 hover:no-underline" onclick={() => (app.showSettings = true)}>
        Settings › Data
      </button>.
    </p>
  {:else}
    <!-- HWNR search box — inline so the user can retry a different
         number without popping back to Browse. -->
    <div class="mt-4 flex items-stretch gap-2">
      <input
        type="text"
        class="flex-1 rounded border border-rule bg-base px-3 py-1.5 font-mono text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
        placeholder="HWNR (7-digit, e.g. 7544721)"
        bind:value={queryInput}
        onkeydown={(e) => e.key === "Enter" && search()}
      />
      <button
        class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
        onclick={search}
        disabled={queryInput.trim().length === 0}
      >
        Plan
      </button>
    </div>

    {#if !app.selectedHwnr}
      <p class="mt-4 text-sm text-faint">
        Enter an HWNR above, or pick one from the browser.
      </p>
    {:else if candidates.length === 0}
      <p class="mt-4 text-sm text-red-600 dark:text-red-400">
        No candidates found for HWNR <code class="font-mono">{app.selectedHwnr}</code>.
      </p>
    {:else}
      <p class="mt-4 text-xs text-faint">
        {candidates.length} candidate{candidates.length === 1 ? "" : "s"} for HWNR
        <code class="font-mono text-foreground">{app.selectedHwnr}</code>
      </p>

      <div class="mt-3 space-y-4">
        {#each candidates as c (c.sgTyp)}
          <div class="rounded border border-divider bg-surface p-4">
            <!-- SG header -->
            <div class="flex items-baseline gap-3">
              <h3 class="text-base font-bold text-foreground">
                SG_TYP: <code class="font-mono">{c.sgTyp}</code>
              </h3>
              {#if c.hwnrRows.length > 1}
                <span class="text-xs text-faint">
                  · known HWNRs: {c.hwnrRows.length}
                </span>
              {/if}
            </div>

            <!-- KFCONF rows -->
            {#if c.kfConfRows.length === 0}
              <p class="mt-2 text-xs text-amber-700 dark:text-amber-400">
                No KFCONF row — SG_TYP isn't flashable in this SP-Daten drop.
              </p>
            {:else}
              <div class="mt-3 space-y-3">
                {#each c.kfConfRows as k (k.variantHex + "/" + k.version)}
                  <div class="rounded border border-divider/60 bg-base p-3">
                    <div class="text-xs font-semibold uppercase tracking-wider text-faint">
                      variant {k.variantHex}/{k.version}
                    </div>
                    <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      <dt class="text-faint">IPO</dt>
                      <dd class="font-mono text-foreground">{k.ipoFile}</dd>
                      <dt class="text-faint">Flash SGBD</dt>
                      <dd class="font-mono text-foreground">{k.flashSgbd}</dd>
                      <dt class="text-faint">Working files</dt>
                      <dd class="font-mono text-muted">
                        .HIS={k.hisFile}
                        · .DAT={k.datFile}
                        · .DIR={k.dirFile}
                        · .HWH={k.hwhFile}
                      </dd>
                    </dl>

                    <!-- ZB rows (async load per KFCONF row) -->
                    {#if k.datFile}
                      {#await loadZbRows(c.sgTyp, k.datFile)}
                        <p class="mt-2 text-xs text-faint">Loading flash files…</p>
                      {:then zbRows}
                        {#if zbRows.length === 0}
                          <p class="mt-2 text-xs text-amber-700 dark:text-amber-400">
                            HWNR {app.selectedHwnr} not present in
                            <code class="font-mono">data/{c.sgTyp}/{k.datFile}</code>.
                          </p>
                        {:else}
                          <div class="mt-3">
                            <div class="text-xs font-semibold uppercase tracking-wider text-faint">
                              Flash files ({zbRows.length} ZB rows)
                            </div>
                            <table class="mt-1 w-full text-xs">
                              <thead>
                                <tr class="border-b border-divider text-left text-faint">
                                  <th class="px-2 py-1 font-medium">ZB-Nr</th>
                                  <th class="px-2 py-1 font-medium">.0PA</th>
                                  <th class="px-2 py-1 font-medium">.0DA</th>
                                  <th class="px-2 py-1 font-medium">PIN</th>
                                  <th class="px-2 py-1 font-medium">S</th>
                                  <th class="px-2 py-1 font-medium">CS</th>
                                </tr>
                              </thead>
                              <tbody>
                                {#each zbRows as r (r.zbNr)}
                                  <tr class="border-b border-divider/40">
                                    <td class="px-2 py-1 font-mono text-foreground">{r.zbNr}</td>
                                    <td class="px-2 py-1 font-mono text-muted">
                                      {r.hwNr}{r.ix}.0PA
                                    </td>
                                    <td class="px-2 py-1 font-mono text-muted">
                                      A{r.swNr.replace(/DA$/, "")}.0DA
                                    </td>
                                    <td class="px-2 py-1 font-mono text-muted">{r.pin}</td>
                                    <td class="px-2 py-1 font-mono text-muted">{r.s}</td>
                                    <td class="px-2 py-1 font-mono text-muted">{r.cs}</td>
                                  </tr>
                                {/each}
                              </tbody>
                            </table>
                          </div>
                        {/if}
                      {:catch err}
                        <p class="mt-2 text-xs text-red-600 dark:text-red-400">
                          Flash file lookup failed: {err.message ?? String(err)}
                        </p>
                      {/await}
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            <!-- kmm_SIT + prgifsel side by side -->
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <div class="rounded border border-divider/60 bg-base p-3">
                <div class="text-xs font-semibold uppercase tracking-wider text-faint">
                  kmm_SIT
                </div>
                {#if c.sit}
                  <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    <dt class="text-faint">DiagAddr</dt>
                    <dd class="font-mono text-foreground">
                      0x{c.sit.diagAddr.toString(16).padStart(2, "0")}
                    </dd>
                    <dt class="text-faint">Transport</dt>
                    <dd class="font-mono text-foreground">{c.sit.transport}</dd>
                    <dt class="text-faint">Flash limit</dt>
                    <dd class="font-mono text-muted">{c.sit.flashLimit ?? "—"}</dd>
                    <dt class="text-faint">Category</dt>
                    <dd class="font-mono text-muted">{c.sit.category}</dd>
                    <dt class="text-faint">AIF mode</dt>
                    <dd class="font-mono text-muted">{c.sit.aifMode}</dd>
                    <dt class="text-faint">HW-ID mode</dt>
                    <dd class="font-mono text-muted">{c.sit.hwIdMode}</dd>
                  </dl>
                {:else}
                  <p class="mt-1 text-xs text-faint">not covered</p>
                {/if}
              </div>
              <div class="rounded border border-divider/60 bg-base p-3">
                <div class="text-xs font-semibold uppercase tracking-wider text-faint">
                  prgifsel
                </div>
                {#if c.prgIfSel}
                  <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    <dt class="text-faint">Protocol</dt>
                    <dd class="font-mono text-foreground">{c.prgIfSel.protocol}</dd>
                    <dt class="text-faint">Interface</dt>
                    <dd class="font-mono text-muted">{c.prgIfSel.iface}</dd>
                    <dt class="text-faint">Hardware</dt>
                    <dd class="font-mono text-muted">{c.prgIfSel.hardware}</dd>
                    <dt class="text-faint">Info</dt>
                    <dd class="font-mono text-muted">{c.prgIfSel.information}</dd>
                  </dl>
                {:else}
                  <p class="mt-1 text-xs text-faint">no transport selector</p>
                {/if}
              </div>
            </div>

            <!-- Actions — check / flash / verify (routed even though
                 the views are still stubs in Phase 1; the buttons
                 make the next-step nav discoverable). -->
            <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-divider pt-3">
              <span class="text-xs text-faint">Next:</span>
              <button
                class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground"
                onclick={() => (app.oemView = "check")}
              >
                Check identity →
              </button>
              <button
                class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground"
                onclick={() => (app.oemView = "backup")}
              >
                Backup →
              </button>
              <button
                class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground"
                onclick={() => (app.oemView = "flash")}
              >
                Flash →
              </button>
              <button
                class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:border-accent hover:bg-elevated hover:text-foreground"
                onclick={() => (app.oemView = "verify")}
              >
                Verify →
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
