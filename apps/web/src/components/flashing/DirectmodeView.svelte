<script lang="ts">
  import {
    dm,
    connectDirectmode,
    disconnectDirectmode,
    probeEcu,
    readEcuFlash,
    writeEcuFlash,
    isWebSerialSupported,
  } from "../../lib/directmode-session.svelte";
  import type { FlashMode } from "@emdzej/nfsx-directmode";

  const supported = isWebSerialSupported();
  const connected = $derived(dm.status.kind === "connected");
  const portInfo = $derived(dm.status.kind === "connected" ? dm.status.portInfo : "");

  let readMode: FlashMode = $state("full");
  let readBaud: number = $state(38400);
  let writeMode: FlashMode = $state("full");
  let writeBaud: number = $state(38400);
  let skipVerify = $state(false);
  let writeFile: File | null = $state(null);

  async function handleConnect() {
    if (connected) {
      await disconnectDirectmode();
    } else {
      await connectDirectmode();
    }
  }

  async function handleProbe() {
    await probeEcu();
  }

  async function handleRead() {
    const image = await readEcuFlash(readMode, readBaud);
    if (!image) return;
    const blob = new Blob([image], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dm.probeResult?.variant ?? "ecu"}_${readMode}.bin`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleWrite() {
    if (!writeFile) return;
    const buf = new Uint8Array(await writeFile.arrayBuffer());
    await writeEcuFlash(buf, writeMode, { skipVerify, writeBaud });
  }

  function onFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    writeFile = input.files?.[0] ?? null;
  }

  const pct = $derived(
    dm.progress?.fraction !== undefined
      ? Math.round(dm.progress.fraction * 100)
      : null,
  );
</script>

<div class="mx-auto max-w-4xl p-6">
  <h2 class="text-lg font-bold text-foreground">Direct DS2 Flashing</h2>
  <p class="mt-1 text-sm text-muted">
    Raw DS2 protocol over K-line. IDENT, SEED/KEY auth, erase, write, verify.
    MS42, MS43, GS20.
  </p>

  {#if !supported}
    <div class="mt-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
      Web Serial is not available in this browser. Use Chrome, Edge, or Opera over HTTPS/localhost.
    </div>
  {:else}
    <!-- Connect/Disconnect -->
    <div class="mt-4 flex items-center gap-3">
      <button
        class="rounded border border-rule px-3 py-1.5 text-xs transition
          {connected
            ? 'border-red-400 text-red-600 hover:bg-red-50 dark:border-red-600 dark:text-red-400 dark:hover:bg-red-950/30'
            : 'text-muted hover:border-accent hover:bg-elevated hover:text-foreground'}
          disabled:cursor-not-allowed disabled:opacity-50"
        onclick={handleConnect}
        disabled={dm.busy}
      >
        {connected ? "Disconnect" : "Connect K-line"}
      </button>
      {#if connected}
        <span class="text-xs text-faint">{portInfo}</span>
      {/if}
    </div>

    <!-- Progress bar -->
    {#if dm.progress}
      <div class="mt-4">
        <div class="flex items-baseline gap-2 text-xs text-muted">
          <span class="font-mono uppercase">{dm.progress.stage}</span>
          <span>{dm.progress.message}</span>
        </div>
        {#if pct !== null}
          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
            <div
              class="h-full rounded-full bg-accent transition-all"
              style="width: {pct}%"
            ></div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Error -->
    {#if dm.lastError}
      <div class="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
        {dm.lastError}
      </div>
    {/if}

    <!-- Cards -->
    <div class="mt-6 grid gap-4 sm:grid-cols-3">
      <!-- Probe -->
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Probe</h3>
        <p class="mt-1 text-xs text-faint">IDENT + ECU type detection.</p>
        <button
          class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!connected || dm.busy}
          onclick={handleProbe}
        >
          Probe ECU
        </button>
        {#if dm.probeResult}
          <div class="mt-3 space-y-0.5 text-xs text-muted">
            <div><span class="text-faint">Variant:</span> {dm.probeResult.variant}</div>
            <div><span class="text-faint">HW #:</span> {dm.probeResult.ident.hwNumber}</div>
            <div><span class="text-faint">SW #:</span> {dm.probeResult.ident.swNumber}</div>
            <div><span class="text-faint">BMW #:</span> {dm.probeResult.ident.bmwNumber}</div>
            <div><span class="text-faint">SW date:</span> {dm.probeResult.ident.swDate}</div>
          </div>
        {/if}
      </div>

      <!-- Read -->
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Read</h3>
        <p class="mt-1 text-xs text-faint">Dump flash to .bin.</p>
        <div class="mt-2 flex gap-2 text-xs">
          <label class="flex items-center gap-1">
            <input type="radio" bind:group={readMode} value="full" class="accent-accent" />
            Full
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" bind:group={readMode} value="calibration" class="accent-accent" />
            Cal
          </label>
        </div>
        <div class="mt-2">
          <label class="text-xs text-faint">
            Baud
            <select bind:value={readBaud} class="ml-1 rounded border border-rule bg-base px-1 py-0.5 text-xs text-foreground">
              <option value={9600}>9600</option>
              <option value={19200}>19200</option>
              <option value={38400}>38400</option>
              <option value={62500}>62500</option>
              <option value={125000}>125000</option>
            </select>
          </label>
        </div>
        <button
          class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!connected || dm.busy}
          onclick={handleRead}
        >
          Read Flash
        </button>
      </div>

      <!-- Write -->
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Write</h3>
        <p class="mt-1 text-xs text-faint">Flash a .bin via DS2.</p>
        <div class="mt-2">
          <input
            type="file"
            accept=".bin"
            onchange={onFileInput}
            class="w-full text-xs text-muted file:mr-2 file:rounded file:border file:border-rule file:bg-base file:px-2 file:py-0.5 file:text-xs file:text-muted"
          />
        </div>
        <div class="mt-2 flex gap-2 text-xs">
          <label class="flex items-center gap-1">
            <input type="radio" bind:group={writeMode} value="full" class="accent-accent" />
            Full
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" bind:group={writeMode} value="calibration" class="accent-accent" />
            Cal
          </label>
        </div>
        <div class="mt-2 flex items-center gap-3 text-xs">
          <label class="text-faint">
            Baud
            <select bind:value={writeBaud} class="ml-1 rounded border border-rule bg-base px-1 py-0.5 text-xs text-foreground">
              <option value={9600}>9600</option>
              <option value={19200}>19200</option>
              <option value={38400}>38400</option>
              <option value={62500}>62500</option>
              <option value={125000}>125000</option>
            </select>
          </label>
          <label class="flex items-center gap-1 text-faint">
            <input type="checkbox" bind:checked={skipVerify} class="accent-accent" />
            Skip verify
          </label>
        </div>
        <button
          class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!connected || dm.busy || !writeFile}
          onclick={handleWrite}
        >
          Write Flash
        </button>
      </div>
    </div>
  {/if}
</div>
