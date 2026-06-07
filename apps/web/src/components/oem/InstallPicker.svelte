<script lang="ts">
  /**
   * Install picker — two paths to a mounted install (FSA local
   * folder + remote HTTP-served install via `bimmerz data index`).
   * Same shape as ncsx-web — see that file for the rationale. The
   * `"bundled"` tile is reserved on the source marker for a future
   * ZIP-import flow.
   */
  import { onMount } from "svelte";
  import { app, type NfsxInstall } from "../../lib/state.svelte";
  import { FsaDirectory, HttpDirectory, drillPath, type VirtualDirectory } from "@emdzej/bimmerz-vfs";
  import {
    isFileSystemAccessSupported,
    loadInstallHandle,
    saveInstallHandle,
    clearInstallHandle,
    queryHandlePermission,
    requestHandlePermission,
    loadRemoteInstallUrl,
    saveRemoteInstallUrl,
    clearRemoteInstallUrl,
  } from "../../lib/install-storage";
  import {
    getInstallSource,
    setInstallSource,
    clearInstallSource,
  } from "../../lib/bundled-install";

  const supported = isFileSystemAccessSupported();

  let savedHandle = $state<FileSystemDirectoryHandle | null>(null);
  let savedRemoteUrl = $state<string | null>(null);
  let restoring = $state(false);
  let remoteUrl = $state("");

  onMount(async () => {
    const remembered = loadRemoteInstallUrl();
    if (remembered) {
      restoring = true;
      try {
        await mountRemote(remembered, { skipSave: true });
        return;
      } catch (err) {
        app.error = err instanceof Error ? err.message : String(err);
        remoteUrl = remembered;
        savedRemoteUrl = remembered;
      } finally {
        restoring = false;
      }
    }

    if (!supported) return;
    const handle = await loadInstallHandle();
    if (!handle) return;
    const perm = await queryHandlePermission(handle);
    if (perm === "granted") {
      restoring = true;
      try {
        await mountFsaHandle(handle, { skipSave: true });
      } catch (err) {
        app.error = err instanceof Error ? err.message : String(err);
      } finally {
        restoring = false;
      }
      return;
    }
    if (perm === "denied") {
      await clearInstallHandle();
      return;
    }
    savedHandle = handle;
  });

  /**
   * Discover the install layout under `root`. nfsx needs only two
   * subdirs: `EDIABAS/Ecu` (SGBDs for the flash IPO's
   * apiJob/apiJobData dispatches) and `EC-APPS/NFS/DATA` (SP-Daten
   * files for the per-ECU `.0PA`/`.0DA` records the IPO reads via
   * `fileopen` syscalls). Both are optional — directmode flash
   * works without either, but the EDIABAS path needs Ecu/.
   */
  async function discoverInstall(root: VirtualDirectory): Promise<NfsxInstall> {
    const [ediabasEcu, spDaten] = await Promise.all([
      drillPath(root, "EDIABAS", "Ecu"),
      drillPath(root, "EC-APPS", "NFS", "DATA"),
    ]);
    return { root, ediabasEcu, spDaten };
  }

  async function mountInstall(root: VirtualDirectory): Promise<void> {
    const install = await discoverInstall(root);
    app.install = install;
    app.oemView = "browse";
    app.installSource = getInstallSource();
  }

  async function mountFsaHandle(
    handle: FileSystemDirectoryHandle,
    options: { skipSave?: boolean } = {},
  ): Promise<void> {
    await mountInstall(new FsaDirectory(handle));
    if (!options.skipSave) {
      await saveInstallHandle(handle);
      clearRemoteInstallUrl();
    }
    /* Write the marker on both first-pick and restore paths so the
       top-bar source pill resolves to "local" either way. Same fix
       as ncsx-web. */
    setInstallSource({ source: "fs-access" });
    app.installSource = getInstallSource();
  }

  async function mountRemote(
    url: string,
    options: { skipSave?: boolean } = {},
  ): Promise<void> {
    const root = new HttpDirectory(url);
    await mountInstall(root);
    if (!options.skipSave) {
      saveRemoteInstallUrl(url);
      await clearInstallHandle();
    }
    setInstallSource({ source: "remote" });
    app.installSource = getInstallSource();
  }

  async function pickFolder(): Promise<void> {
    app.error = null;
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await mountFsaHandle(handle);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      app.error = err instanceof Error ? err.message : String(err);
    }
  }

  async function continueLast(): Promise<void> {
    if (!savedHandle) return;
    app.error = null;
    try {
      const perm = await requestHandlePermission(savedHandle);
      if (perm !== "granted") {
        await clearInstallHandle();
        savedHandle = null;
        return;
      }
      await mountFsaHandle(savedHandle);
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    }
  }

  async function submitRemote(): Promise<void> {
    const url = remoteUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      app.error = "Remote install URL must start with http:// or https://";
      return;
    }
    app.error = null;
    try {
      await mountRemote(url);
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    }
  }

  function dismissSavedRemote(): void {
    savedRemoteUrl = null;
    clearRemoteInstallUrl();
    clearInstallSource();
    app.installSource = null;
    remoteUrl = "";
  }
</script>

<div class="flex h-full flex-col items-center justify-center gap-8 p-8">
  <div class="max-w-2xl text-center">
    <h1 class="text-4xl font-bold text-accent">NFSX</h1>
    <p class="mt-2 text-muted">
      OEM flash programming. Mirrors WinKFP's IPO-driven flow.
    </p>
    <p class="mt-3 flex items-center justify-center gap-2 text-xs text-faint">
      <a
        href="https://github.com/emdzej/nfsx/releases/tag/{__APP_VERSION__}"
        target="_blank"
        rel="noopener noreferrer"
        class="transition hover:text-foreground"
      >
        {__APP_VERSION__}
      </a>
    </p>
  </div>

  {#if restoring}
    <p class="text-sm text-faint">Restoring last install…</p>
  {:else if savedHandle && !savedRemoteUrl}
    <div class="flex flex-col items-center gap-3">
      <button
        class="rounded bg-accent px-6 py-3 font-medium text-zinc-950 transition hover:bg-accent-muted"
        onclick={continueLast}
      >
        Continue with {savedHandle.name}
      </button>
      <button
        class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
        onclick={() => (savedHandle = null)}
      >
        Pick a different install
      </button>
    </div>
  {:else}
    <div class="flex w-full max-w-2xl flex-col items-stretch gap-3">
      {#if savedRemoteUrl}
        <div class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-300">
          Couldn't reach <code class="font-mono">{savedRemoteUrl}</code>.
          Edit the URL below and re-mount, or
          <button class="underline-offset-2 hover:underline" onclick={dismissSavedRemote}>
            forget the saved URL
          </button>.
        </div>
      {/if}

      {#if supported}
        <button
          class="flex flex-col items-center gap-2 rounded border border-rule bg-surface p-4 text-center transition hover:border-accent hover:bg-elevated"
          onclick={pickFolder}
        >
          <span class="font-semibold text-foreground">
            Pick BMW Standard Tools install folder
          </span>
          <span class="text-xs text-faint">
            Point us at the folder containing
            <code class="text-muted">EDIABAS/</code> and
            <code class="text-muted">EC-APPS/NFS/DATA/</code>.
            Auto-discovers SGBDs + SP-Daten. NFSX remembers it.
            <span class="block mt-1 italic">Local — nothing leaves your machine.</span>
          </span>
        </button>
      {:else}
        <div class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>Local folder picker unavailable.</strong> The File
          System Access API is Chromium-only — use Chrome, Edge, or
          Opera to pick a local install. Mount-by-URL works on any browser.
        </div>
      {/if}

      <div class="rounded border border-rule bg-surface p-4">
        <div class="font-semibold text-foreground text-center">
          Mount a remote install
        </div>
        <p class="mt-1 text-center text-xs text-faint">
          Point us at a tree of <code class="text-muted">index.json</code>
          listings served over HTTP — generate one with
          <code class="text-muted">bimmerz data index</code> against your
          BMW Standard Tools install.
        </p>
        <div class="mt-3 flex items-stretch gap-2">
          <input
            type="url"
            class="flex-1 rounded border border-rule bg-base px-2 py-1.5 font-mono text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
            placeholder="https://my-installs.example.com/bmw-standard-tools/"
            bind:value={remoteUrl}
            onkeydown={(e) => e.key === 'Enter' && submitRemote()}
          />
          <button
            class="rounded bg-accent px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!remoteUrl.trim()}
            onclick={submitRemote}
          >
            Mount
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if app.error}
    <div class="max-w-md rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
      {app.error}
    </div>
  {/if}
</div>
