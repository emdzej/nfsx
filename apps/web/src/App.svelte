<script lang="ts">
  import { app } from "./lib/state.svelte";

  import ErrorBanner from "./components/shared/ErrorBanner.svelte";
  import ConnectButton from "./components/shared/ConnectButton.svelte";
  import SettingsDialog from "./components/shared/SettingsDialog.svelte";
  import AboutDialog from "./components/shared/AboutDialog.svelte";

  import InstallPicker from "./components/oem/InstallPicker.svelte";
  import BrowseView from "./components/oem/BrowseView.svelte";
  import PlanView from "./components/oem/PlanView.svelte";

  import ChecksumView from "./components/flashing/ChecksumView.svelte";
  import DirectmodeView from "./components/flashing/DirectmodeView.svelte";
  import BootmodeView from "./components/flashing/BootmodeView.svelte";

  type ScopeTab = { id: typeof app.scope; label: string };
  const scopeTabs: ScopeTab[] = [
    { id: "oem", label: "OEM" },
    { id: "flashing", label: "Flashing" },
  ];

  type FlashTab = { id: typeof app.flashingTab; label: string };
  const flashTabs: FlashTab[] = [
    { id: "checksum", label: "Checksum" },
    { id: "directmode", label: "Directmode" },
    { id: "bootmode", label: "Bootmode" },
  ];

  function oemHome(): void {
    app.oemView = app.install ? "browse" : "picker";
    app.error = null;
  }
</script>

<div class="flex h-full flex-col bg-base text-foreground">
  <header class="flex items-center gap-4 border-b border-divider bg-surface px-4 py-2 text-sm">
    <button
      class="font-semibold text-accent transition hover:text-accent-muted"
      onclick={oemHome}
    >
      NFSX
    </button>
    <button
      class="text-xs text-faint underline-offset-2 transition hover:text-foreground hover:underline"
      onclick={() => (app.showAbout = true)}
      title="About NFSX — versions, source, report an issue"
    >
      {__APP_VERSION__}
    </button>
    <a
      href="https://github.com/emdzej/nfsx"
      target="_blank"
      rel="noopener noreferrer"
      class="text-faint transition hover:text-foreground"
      title="nfsx on GitHub"
      aria-label="nfsx on GitHub"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
    </a>

    <!-- Scope tabs -->
    <div class="flex gap-1 rounded border border-divider bg-base px-0.5 py-0.5" role="tablist">
      {#each scopeTabs as tab (tab.id)}
        <button
          type="button"
          role="tab"
          aria-selected={app.scope === tab.id}
          class="rounded px-3 py-0.5 text-xs font-medium transition"
          class:bg-accent={app.scope === tab.id}
          class:text-zinc-950={app.scope === tab.id}
          class:text-muted={app.scope !== tab.id}
          class:hover:text-foreground={app.scope !== tab.id}
          onclick={() => (app.scope = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <span class="flex-1"></span>
    <button
      class="rounded border border-divider bg-surface px-2 py-0.5 text-xs text-muted transition hover:border-accent hover:bg-elevated"
      onclick={() => (app.showSettings = true)}
      title="Configure interface, serial parameters, gateway URL"
    >
      Settings
    </button>
    <ConnectButton />
  </header>

  <main class="flex-1 overflow-y-auto">
    {#if app.scope === "oem"}
      {#if app.oemView === "picker"}
        <InstallPicker />
      {:else if app.oemView === "browse"}
        <BrowseView />
      {:else if app.oemView === "plan"}
        <PlanView />
      {/if}
    {:else}
      <!-- Flashing sub-tabs -->
      <div class="flex gap-1 border-b border-divider bg-surface px-4 py-1.5" role="tablist">
        {#each flashTabs as tab (tab.id)}
          <button
            type="button"
            role="tab"
            aria-selected={app.flashingTab === tab.id}
            class="border-b-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition"
            class:border-accent={app.flashingTab === tab.id}
            class:text-accent={app.flashingTab === tab.id}
            class:border-transparent={app.flashingTab !== tab.id}
            class:text-muted={app.flashingTab !== tab.id}
            class:hover:text-foreground={app.flashingTab !== tab.id}
            onclick={() => (app.flashingTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      {#if app.flashingTab === "checksum"}
        <ChecksumView />
      {:else if app.flashingTab === "directmode"}
        <DirectmodeView />
      {:else if app.flashingTab === "bootmode"}
        <BootmodeView />
      {/if}
    {/if}
  </main>

  <ErrorBanner />
  <SettingsDialog />
  <AboutDialog />
</div>
