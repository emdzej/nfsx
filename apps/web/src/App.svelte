<script lang="ts">
  import { app } from "./lib/state.svelte";
  import { loadRemoteInstallUrl } from "./lib/install-storage";

  import ErrorBanner from "./components/shared/ErrorBanner.svelte";
  import ConnectButton from "./components/shared/ConnectButton.svelte";
  import SettingsDialog from "./components/shared/SettingsDialog.svelte";
  import AboutDialog from "./components/shared/AboutDialog.svelte";
  import ConnectSessionDialog from "./components/shared/ConnectSessionDialog.svelte";

  import InstallPicker from "./components/oem/InstallPicker.svelte";
  import BrowseView from "./components/oem/BrowseView.svelte";
  import PlanView from "./components/oem/PlanView.svelte";

  import ChecksumView from "./components/flashing/ChecksumView.svelte";
  import TuneView from "./components/flashing/TuneView.svelte";
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
    { id: "tune", label: "Tune" },
    { id: "directmode", label: "Directmode" },
    { id: "bootmode", label: "Bootmode" },
  ];

  function oemHome(): void {
    app.oemView = app.install ? "browse" : "picker";
    app.error = null;
  }

  /**
   * Top-bar install-source pill. Shown across both OEM and Flashing
   * scopes — useful even in Flashing because the cabi/flash IPO
   * runtime relies on `app.install.ediabasEcu` for SGBD loads.
   * Reads from reactive `app.installSource` so mid-session source
   * switches refresh without a reload (matches inpax-web /
   * ncsx-web pattern).
   */
  const installPill = $derived.by((): { label: string; tooltip: string } => {
    if (!app.install) {
      return { label: "no install", tooltip: "No install loaded" };
    }
    const source = app.installSource;
    const rootName = app.install.root.name || "(unnamed root)";
    if (source?.source === "remote") {
      const url = loadRemoteInstallUrl();
      return {
        label: "remote",
        tooltip: `Remote VFS · ${url ?? rootName}`,
      };
    }
    if (source?.source === "bundled") {
      return {
        label: "bundled",
        tooltip: `OPFS bundle · ${rootName} · ${source.fileCount} files · imported ${source.importedAt}`,
      };
    }
    if (source?.source === "fs-access") {
      return {
        label: "local",
        tooltip: `Local folder · ${rootName}`,
      };
    }
    return { label: "?", tooltip: `Unknown install source · ${rootName}` };
  });

  /**
   * Connection-mode pill. Sits next to the Connect button so the
   * user sees at a glance which path the cable goes through.
   */
  const modePill = $derived.by((): { label: string; tooltip: string } => {
    const cfg = app.config;
    if (cfg.mode === "client") {
      if (cfg.connectionMethod === "connect") {
        return {
          label: "bimmerz connect",
          tooltip: `Client · Bimmerz Connect relay · ${cfg.connectRelayUrl ?? "wss://connect.bimmerz.app"}`,
        };
      }
      return {
        label: "ws server",
        tooltip: `Client · direct WebSocket · ${cfg.serverUrl ?? "(URL not set)"}`,
      };
    }
    if (cfg.interface === "webserial") {
      const baud = cfg.serial?.baudRate ?? 9600;
      return { label: "web serial", tooltip: `Embedded · Web Serial @ ${baud}` };
    }
    if (cfg.interface === "j2534") {
      return { label: "j2534", tooltip: "Embedded · J2534 (Tactrix OpenPort 2.0)" };
    }
    if (cfg.interface === "gateway") {
      return {
        label: "gateway",
        tooltip: `Embedded · Remote gateway · ${cfg.gateway?.url ?? "(URL not set)"}`,
      };
    }
    return { label: cfg.interface, tooltip: `Embedded · ${cfg.interface}` };
  });
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
          class:text-white={app.scope === tab.id}
          class:text-muted={app.scope !== tab.id}
          class:hover:text-foreground={app.scope !== tab.id}
          onclick={() => (app.scope = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    <span class="flex-1"></span>
    <!-- Right cluster: data-location pill, mode pill, Settings,
         Connect button. All OEM-scope only — the Flashing scope's
         subviews (directmode / bootmode / checksum) manage their own
         wire connections and don't use the shared ediabasx client
         or a mounted SP-Daten install. -->
    {#if app.scope === "oem"}
      <span
        class="flex items-center gap-1.5 text-xs text-faint"
        title={installPill.tooltip}
      >
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4a1.5 1.5 0 0 1 1.06.44L8 4.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/>
        </svg>
        {installPill.label}
      </span>
      <span
        class="flex items-center gap-1.5 text-xs text-faint"
        title={modePill.tooltip}
      >
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 2v3.5M9 2v3.5M3.5 5.5h7v3a3.5 3.5 0 0 1-3.5 3.5h0a3.5 3.5 0 0 1-3.5-3.5v-3zM7 12v2"/>
        </svg>
        {modePill.label}
      </span>
      <button
        class="rounded border border-divider bg-surface px-2 py-0.5 text-xs text-muted transition hover:border-accent hover:bg-elevated"
        onclick={() => (app.showSettings = true)}
        title="Configure interface, serial parameters, gateway URL"
      >
        Settings
      </button>
      <ConnectButton />
    {/if}
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
      {:else if app.flashingTab === "tune"}
        <TuneView />
      {:else if app.flashingTab === "directmode"}
        <DirectmodeView />
      {:else if app.flashingTab === "bootmode"}
        <BootmodeView />
      {/if}
    {/if}
  </main>

  <ErrorBanner />
  <SettingsDialog />
  <ConnectSessionDialog />
  <AboutDialog />
</div>
