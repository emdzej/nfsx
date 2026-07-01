<script lang="ts">
  import {
    LOG_LEVELS,
    resetConfig,
    saveConfig,
    type LogLevel,
  } from "../../lib/config";
  import {
    InterfaceConfigPanel,
    ModeConfigPanel,
    ServerConfigPanel,
    ConnectConfigPanel,
  } from "@emdzej/ediabasx-web-ui";
  import {
    clearInstallHandle,
    saveInstallHandle,
    clearRemoteInstallUrl,
    loadRemoteInstallUrl,
    isFileSystemAccessSupported,
  } from "../../lib/install-storage";
  import { clearInstallSource, setInstallSource } from "../../lib/bundled-install";
  import { FsaDirectory } from "@emdzej/bimmerz-vfs";
  import { discoverInstall } from "../../lib/install-discovery";
  import { clearSpDatenState, loadSpDatenIntoState } from "../../lib/sp-daten-loader";
  import { app } from "../../lib/state.svelte";
  import { applyLoggerConfig } from "../../lib/logger-wiring";
  import { LOG_CATEGORIES as INPAX_LOG_CATEGORIES } from "@emdzej/inpax-interpreter";
  import { LOG_CATEGORIES as EDIABASX_LOG_CATEGORIES } from "@emdzej/ediabasx-ediabas";

  const KNOWN_LOG_CATEGORIES = [
    ...INPAX_LOG_CATEGORIES,
    ...EDIABASX_LOG_CATEGORIES,
  ];

  $effect(() => {
    saveConfig(app.config);
  });

  $effect(() => {
    applyLoggerConfig(app.config.logging);
  });

  function setLogLevel(value: LogLevel): void {
    app.config.logging = { ...(app.config.logging ?? {}), level: value };
  }

  function setCategoryLevel(name: string, value: LogLevel | ""): void {
    const next = { ...(app.config.logging?.categories ?? {}) };
    if (value === "") {
      delete next[name];
    } else {
      next[name] = value;
    }
    app.config.logging = {
      ...(app.config.logging ?? {}),
      categories: Object.keys(next).length > 0 ? next : undefined,
    };
  }

  function close(): void {
    app.showSettings = false;
  }

  function reset(): void {
    app.config = resetConfig();
  }

  const fsaSupported = isFileSystemAccessSupported();
  const savedRemoteUrl = $derived(loadRemoteInstallUrl());

  /**
   * Reset every piece of app state that assumes an install is
   * mounted. Keeps the checksum tab (which is install-independent)
   * intact so the user doesn't lose an in-progress checksum session
   * just because they changed folders.
   */
  function clearDerivedInstallState(): void {
    app.install = null;
    app.installSource = null;
    app.oemView = "picker";
    clearSpDatenState();
  }

  async function forgetInstall(): Promise<void> {
    await clearInstallHandle();
    clearRemoteInstallUrl();
    clearInstallSource();
    clearDerivedInstallState();
    app.showSettings = false;
  }

  async function changeInstall(): Promise<void> {
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      const install = await discoverInstall(new FsaDirectory(handle));
      app.install = install;
      await saveInstallHandle(handle);
      // Picking a new folder supersedes any prior remote-URL pin.
      clearRemoteInstallUrl();
      setInstallSource({ source: "fs-access" });
      app.installSource = { source: "fs-access" };
      // Kick off SP-Daten parse for the new install.
      void loadSpDatenIntoState(install);
      app.oemView = "browse";
      app.showSettings = false;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      app.error = err instanceof Error ? err.message : String(err);
    }
  }

  type Tab = "connection" | "data" | "developer";
  let activeTab = $state<Tab>("connection");
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "connection", label: "Connection" },
    { id: "data", label: "Data" },
    { id: "developer", label: "Developer" },
  ];
</script>

{#if app.showSettings}
  <div
    class="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    onclick={close}
    onkeydown={(e) => e.key === "Escape" && close()}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex max-h-[90vh] w-full max-w-xl flex-col rounded border border-rule bg-surface shadow-2xl"
      role="document"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <header class="flex shrink-0 items-baseline justify-between gap-4 border-b border-divider px-4 py-3">
        <h2 class="text-sm font-bold uppercase tracking-wider text-muted">Settings</h2>
        <button
          class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
          onclick={close}
        >
          close
        </button>
      </header>

      <div class="flex shrink-0 gap-1 border-b border-divider px-2" role="tablist">
        {#each tabs as tab (tab.id)}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            class="border-b-2 px-3 py-2 text-xs font-medium uppercase tracking-wider transition"
            class:border-accent={activeTab === tab.id}
            class:text-accent={activeTab === tab.id}
            class:border-transparent={activeTab !== tab.id}
            class:text-muted={activeTab !== tab.id}
            class:hover:text-foreground={activeTab !== tab.id}
            onclick={() => (activeTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <section class="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm text-foreground">
        {#if activeTab === "connection"}
          <!-- Mode toggle — embedded (local cable) vs client
               (remote ediabasx-server over WebSocket or Bimmerz
               Connect relay). Branches the fieldsets below. -->
          <ModeConfigPanel bind:config={app.config} />

          {#if app.config.mode === "client"}
            <ConnectConfigPanel bind:config={app.config} />
            <ServerConfigPanel bind:config={app.config} />
          {:else}
            <InterfaceConfigPanel bind:config={app.config} />
          {/if}
        {:else if activeTab === "data"}
          <!-- Install root — surfaces the picked BMW Standard Tools
               folder (or remote URL) and lets the user swap it or
               forget the saved handle. The picker on first launch
               handles first-time setup; this tab covers "install
               moved" and "wrong folder picked" without dropping
               back to the picker. -->
          <div>
            <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-faint">
              Install
            </span>
            <div class="flex items-center justify-between gap-2 rounded border border-divider bg-base px-3 py-2">
              <span class="min-w-0 truncate text-sm">
                {#if app.install}
                  <span class="font-mono text-foreground">{app.install.root.name}</span>
                  <span class="ml-2 text-xs text-faint">
                    · {app.installSource?.source ?? "local"}
                  </span>
                {:else if savedRemoteUrl}
                  <span class="italic text-faint">
                    Remote URL saved — <code class="font-mono">{savedRemoteUrl}</code>
                  </span>
                {:else}
                  <span class="italic text-faint">(no install picked)</span>
                {/if}
              </span>
              <div class="flex shrink-0 items-center gap-3">
                {#if fsaSupported}
                  <button
                    class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:bg-elevated hover:text-foreground"
                    onclick={changeInstall}
                    title="Pick a different install folder (replaces the saved one)"
                  >
                    Change folder…
                  </button>
                {/if}
                <button
                  class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  onclick={forgetInstall}
                  disabled={!app.install && !savedRemoteUrl}
                  title="Drop the remembered install and return to the picker"
                >
                  Forget
                </button>
              </div>
            </div>
            {#if app.install}
              <ul class="mt-2 space-y-0.5 text-xs text-faint">
                <li>
                  <code class="font-mono">EDIABAS/Ecu</code>:
                  {#if app.install.ediabasEcu}
                    <span class="text-muted">present</span>
                  {:else}
                    <span class="text-amber-700 dark:text-amber-400">missing — EDIABAS-driven flash paths won't resolve SGBDs</span>
                  {/if}
                </li>
                <li>
                  <code class="font-mono">EC-APPS/NFS/DATA</code>:
                  {#if app.install.spDaten}
                    <span class="text-muted">present</span>
                  {:else}
                    <span class="text-amber-700 dark:text-amber-400">missing — `nfsx flash` and `nfsx plan` need SP-Daten</span>
                  {/if}
                </li>
              </ul>
            {/if}
            {#if !fsaSupported}
              <p class="mt-2 text-xs text-faint">
                Chromium-only. Use Chrome / Edge / Opera to pick a local
                folder — or mount a remote URL from the install picker.
              </p>
            {/if}
          </div>

        {:else if activeTab === "developer"}
          <fieldset class="space-y-2 rounded border border-divider bg-base p-3">
            <legend class="px-1 text-xs font-semibold uppercase tracking-wider text-faint">
              Logging
            </legend>
            <label class="text-xs text-muted">
              Default level
              <select
                class="mt-0.5 w-full rounded border border-rule bg-surface px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none"
                value={app.config.logging?.level ?? "info"}
                onchange={(e) => setLogLevel((e.currentTarget as HTMLSelectElement).value as LogLevel)}
              >
                {#each LOG_LEVELS as lvl (lvl)}
                  <option value={lvl}>{lvl}</option>
                {/each}
              </select>
            </label>

            <div class="pt-1">
              <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-faint">
                Category overrides
              </p>
              <ul class="space-y-1.5">
                {#each KNOWN_LOG_CATEGORIES as cat (cat.name)}
                  {@const current = app.config.logging?.categories?.[cat.name] ?? ""}
                  <li class="grid grid-cols-[1fr_8rem] items-baseline gap-2">
                    <div class="min-w-0">
                      <code class="text-xs text-foreground">{cat.name}</code>
                      {#if cat.hint}
                        <p class="text-xs text-faint">{cat.hint}</p>
                      {/if}
                    </div>
                    <select
                      class="rounded border border-rule bg-surface px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
                      value={current}
                      onchange={(e) =>
                        setCategoryLevel(
                          cat.name,
                          (e.currentTarget as HTMLSelectElement).value as LogLevel | "",
                        )}
                    >
                      <option value="">(inherit)</option>
                      {#each LOG_LEVELS as lvl (lvl)}
                        <option value={lvl}>{lvl}</option>
                      {/each}
                    </select>
                  </li>
                {/each}
              </ul>
            </div>
          </fieldset>
        {/if}
      </section>

      <footer class="flex shrink-0 items-center justify-between gap-2 border-t border-divider bg-elevated/50 px-4 py-2">
        <button
          class="rounded border border-rule px-2 py-0.5 text-xs text-muted hover:bg-elevated hover:text-foreground"
          onclick={reset}
          title="Reset to default config"
        >
          Reset to defaults
        </button>
        <button
          class="rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent-muted"
          onclick={close}
        >
          Done
        </button>
      </footer>
    </div>
  </div>
{/if}
