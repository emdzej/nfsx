<script lang="ts">
  import {
    bm,
    connectBootmode,
    disconnectBootmode,
    probeBootmodeSession,
    readBootmodeFlash,
    writeBootmodeFlash,
    verifyBundleIntegrityWeb,
    isWebSerialSupported,
  } from "../../lib/bootmode-session.svelte";
  import {
    verifyMs4xChecksums,
    rewriteMs4xChecksums,
  } from "@emdzej/nfsx-flash-data";

  const AM29F400B_TOTAL_BYTES = 0x80000;

  const supported = isWebSerialSupported();
  const connected = $derived(bm.status.kind === "connected");
  const portInfo = $derived(bm.status.kind === "connected" ? bm.status.portInfo : "");
  const activeBaud = $derived(bm.status.kind === "connected" ? bm.status.baud : 0);

  let baudRate: number = $state(19200);
  let skipVerify = $state(false);
  let calculateChecksum = $state(false);
  let writeFile: File | null = $state(null);
  let probeSuccess: boolean | null = $state(null);
  let writeVerified: boolean | null = $state(null);

  const pct = $derived(
    bm.progress?.fraction !== undefined
      ? Math.round(bm.progress.fraction * 100)
      : null,
  );

  async function handleConnect() {
    probeSuccess = null;
    writeVerified = null;
    if (connected) {
      await disconnectBootmode();
    } else {
      await connectBootmode({ baudRate });
    }
  }

  async function handleVerifyBundle() {
    await verifyBundleIntegrityWeb();
  }

  async function handleProbe() {
    probeSuccess = null;
    probeSuccess = await probeBootmodeSession();
  }

  async function handleRead() {
    const image = await readBootmodeFlash();
    if (!image) return;
    // Copy into a fresh ArrayBuffer so the Blob ctor's tighter typing
    // in TS 5.7 doesn't reject the Uint8Array-over-shared-buffer view.
    const ab = new ArrayBuffer(image.byteLength);
    new Uint8Array(ab).set(image);
    const blob = new Blob([ab], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bootmode_${Date.now()}.bin`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleWrite() {
    if (!writeFile) return;
    writeVerified = null;
    const buf = new Uint8Array(await writeFile.arrayBuffer());
    if (buf.length !== AM29F400B_TOTAL_BYTES) {
      bm.lastError = `image must be exactly ${AM29F400B_TOTAL_BYTES} bytes (got ${buf.length})`;
      return;
    }

    // Optional MS42/MS43 CRC-16 recompute before flashing.
    if (calculateChecksum) {
      try {
        const pre = verifyMs4xChecksums(buf);
        if (!pre.allValid) rewriteMs4xChecksums(buf);
      } catch (err) {
        bm.lastError = `--calculate-checksum failed: ${(err as Error).message}`;
        return;
      }
    }

    const result = await writeBootmodeFlash(buf, { skipVerify });
    writeVerified = result ? result.verified : null;
  }

  function onFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    writeFile = input.files?.[0] ?? null;
    writeVerified = null;
  }
</script>

<div class="mx-auto max-w-4xl p-6">
  <h2 class="text-lg font-bold text-foreground">C167 Bootmode</h2>
  <p class="mt-1 text-sm text-muted">
    Infineon C167 silicon BSL. Bypasses BMW firmware entirely — uploads a
    loader into RAM and drives the flash chip directly. Bench-pull only.
  </p>

  {#if !supported}
    <div class="mt-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
      <strong class="font-semibold">Web Serial unavailable.</strong>
      Bootmode needs direct serial access — use Chrome, Edge, or Opera.
    </div>
  {:else}
    <!-- Connect + baud + bundle verify -->
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        class="rounded border border-rule px-3 py-1.5 text-xs transition
          {connected
            ? 'border-red-400 text-red-600 hover:bg-red-50 dark:border-red-600 dark:text-red-400 dark:hover:bg-red-950/30'
            : 'text-muted hover:border-accent hover:bg-elevated hover:text-foreground'}
          disabled:cursor-not-allowed disabled:opacity-50"
        onclick={handleConnect}
        disabled={bm.busy}
      >
        {connected ? "Disconnect" : "Connect K-line"}
      </button>
      {#if !connected}
        <label class="text-xs text-faint">
          Baud
          <select bind:value={baudRate} class="ml-1 rounded border border-rule bg-base px-1 py-0.5 text-xs text-foreground">
            <option value={9600}>9600</option>
            <option value={19200}>19200</option>
            <option value={38400}>38400</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
          </select>
        </label>
      {:else}
        <span class="text-xs text-faint">
          {portInfo} @ {activeBaud}
        </span>
      {/if}
      <button
        class="ml-auto rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        onclick={handleVerifyBundle}
        disabled={bm.busy}
      >
        Verify bundle
      </button>
    </div>

    <!-- Progress bar -->
    {#if bm.progress}
      <div class="mt-4">
        <div class="flex items-baseline gap-2 text-xs text-muted">
          <span class="font-mono uppercase">{bm.progress.stage}</span>
          <span>{bm.progress.message}</span>
        </div>
        {#if pct !== null}
          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
            <div class="h-full rounded-full bg-accent transition-all" style="width: {pct}%"></div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Error -->
    {#if bm.lastError}
      <div class="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
        {bm.lastError}
      </div>
    {/if}

    <!-- Bundle integrity report (from verify-bundle button) -->
    {#if bm.lastIntegrityReport}
      <div class="mt-3 rounded border border-divider bg-surface p-3 text-xs">
        <div class="font-semibold text-foreground">
          Bundle integrity — {bm.lastIntegrityReport.allValid ? "OK" : "FAIL"}
        </div>
        <div class="mt-1 text-faint">
          {bm.lastIntegrityReport.manifest.source}
        </div>
        <ul class="mt-2 space-y-0.5 font-mono text-[11px]">
          {#each bm.lastIntegrityReport.results as r}
            <li class:text-red-600={!r.match} class:text-muted={r.match}>
              {r.match ? "✓" : "✗"} {r.name}
              {#if !r.match}
                — expected {r.expectedSha256.slice(0, 12)}…, got {r.actualSha256.slice(0, 12)}…
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Cards -->
    <div class="mt-6 grid gap-4 sm:grid-cols-3">
      <!-- Probe -->
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Probe</h3>
        <p class="mt-1 text-xs text-faint">BSL handshake + comms test.</p>
        <button
          class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!connected || bm.busy}
          onclick={handleProbe}
        >
          Probe
        </button>
        {#if probeSuccess === true}
          <p class="mt-2 text-xs text-green-700 dark:text-green-400">
            ✓ handshake + testComm OK
          </p>
        {:else if probeSuccess === false}
          <p class="mt-2 text-xs text-red-600 dark:text-red-400">✗ probe failed</p>
        {/if}
      </div>

      <!-- Read -->
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Read</h3>
        <p class="mt-1 text-xs text-faint">Read full 512 KB flash.</p>
        <button
          class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!connected || bm.busy}
          onclick={handleRead}
        >
          Read Flash
        </button>
      </div>

      <!-- Write -->
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Write</h3>
        <p class="mt-1 text-xs text-faint">Erase + write 512 KB .bin.</p>
        <div class="mt-2">
          <input
            type="file"
            accept=".bin"
            onchange={onFileInput}
            class="w-full text-xs text-muted file:mr-2 file:rounded file:border file:border-rule file:bg-base file:px-2 file:py-0.5 file:text-xs file:text-muted"
          />
        </div>
        <div class="mt-2 flex flex-col gap-1 text-xs">
          <label class="flex items-center gap-1 text-faint">
            <input type="checkbox" bind:checked={skipVerify} class="accent-accent" />
            Skip readback verify
          </label>
          <label class="flex items-center gap-1 text-faint">
            <input type="checkbox" bind:checked={calculateChecksum} class="accent-accent" />
            Recompute MS4x CRC-16 first
          </label>
        </div>
        <button
          class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!connected || bm.busy || !writeFile}
          onclick={handleWrite}
        >
          Write Flash
        </button>
        {#if writeVerified === true}
          <p class="mt-2 text-xs text-green-700 dark:text-green-400">
            ✓ flash complete — verified
          </p>
        {:else if writeVerified === false}
          <p class="mt-2 text-xs text-yellow-700 dark:text-yellow-400">
            ⚠ flash complete — unverified (skip-verify was set)
          </p>
        {/if}
      </div>
    </div>

    <p class="mt-6 text-xs text-faint">
      Uses MiniMon + custom stubs. Flash chip: AM29F400B (512 KB, bottom-boot,
      11 sectors). Bench pull required with BOOT pin grounded.
    </p>
  {/if}
</div>
