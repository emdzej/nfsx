<script lang="ts">
  import { app } from "../../lib/state.svelte";
  import {
    detectVariant,
    verifyMs4xChecksums,
    MS4X_EXPECTED_FILE_LENGTH,
  } from "@emdzej/nfsx-flash-data";

  async function pickFile(): Promise<void> {
    app.error = null;
    app.checksumState = {
      fileName: null,
      fileSize: null,
      variant: null,
      report: null,
      rewritten: null,
    };

    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "Firmware BIN",
            accept: { "application/octet-stream": [".bin"] },
          },
        ],
      });
      const file = await handle.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());

      app.checksumState.fileName = file.name;
      app.checksumState.fileSize = buf.length;

      if (buf.length !== MS4X_EXPECTED_FILE_LENGTH) {
        app.error = `Expected ${MS4X_EXPECTED_FILE_LENGTH} bytes (512 KB), got ${buf.length}.`;
        return;
      }

      const variant = detectVariant(buf);
      const report = verifyMs4xChecksums(buf, { variant });

      app.checksumState.variant = variant;
      app.checksumState.report = report;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      app.error = err instanceof Error ? err.message : String(err);
    }
  }

  const allPass = $derived(
    app.checksumState.report != null &&
    app.checksumState.report.results.filter((r) => r.supported).every((r) => r.match),
  );
</script>

<div class="mx-auto max-w-3xl p-6">
  <h2 class="text-lg font-bold text-foreground">MS42 / MS43 Checksum</h2>
  <p class="mt-1 text-sm text-muted">
    Verify or recompute CRC-16 and add-32 checksums in a 512 KB firmware BIN.
    No hardware needed.
  </p>

  <div class="mt-4">
    <button
      class="rounded bg-accent px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-accent-muted"
      onclick={pickFile}
    >
      Pick .bin file
    </button>
  </div>

  {#if app.checksumState.fileName}
    <div class="mt-4 rounded border border-divider bg-surface p-4 text-sm">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-foreground">{app.checksumState.fileName}</span>
        <span class="text-xs text-faint">{app.checksumState.fileSize?.toLocaleString()} bytes</span>
        {#if app.checksumState.variant}
          <span class="rounded bg-elevated px-2 py-0.5 text-xs font-medium text-foreground">
            {app.checksumState.variant}
          </span>
        {/if}
      </div>
    </div>
  {/if}

  {#if app.checksumState.report}
    {@const report = app.checksumState.report}
    {@const supported = report.results.filter((r) => r.supported)}
    <div class="mt-4">
      <div class="mb-2 flex items-center gap-2">
        {#if allPass}
          <span class="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300">
            ALL PASS
          </span>
        {:else}
          <span class="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300">
            MISMATCH
          </span>
        {/if}
        <span class="text-xs text-faint">
          {supported.length} checksum{supported.length !== 1 ? "s" : ""} verified
        </span>
      </div>

      <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-divider text-left text-faint">
            <th class="px-2 py-1.5 font-medium">Name</th>
            <th class="px-2 py-1.5 font-medium">Kind</th>
            <th class="px-2 py-1.5 font-medium">Regions</th>
            <th class="px-2 py-1.5 font-medium">Stored</th>
            <th class="px-2 py-1.5 font-medium">Computed</th>
            <th class="px-2 py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each supported as ck (ck.name)}
            <tr class="border-b border-divider/50">
              <td class="px-2 py-1.5 font-mono text-foreground">{ck.name}</td>
              <td class="px-2 py-1.5 text-muted">{ck.kind}</td>
              <td class="px-2 py-1.5 font-mono text-muted">
                {#each ck.ranges as r, i}
                  {#if i > 0}, {/if}
                  {r.start.toString(16).padStart(5, "0")}–{r.end.toString(16).padStart(5, "0")}
                {/each}
              </td>
              <td class="px-2 py-1.5 font-mono text-foreground">
                {ck.stored.toString(16).padStart(ck.kind === "crc16" ? 4 : 8, "0")}
              </td>
              <td class="px-2 py-1.5 font-mono text-foreground">
                {ck.computed.toString(16).padStart(ck.kind === "crc16" ? 4 : 8, "0")}
              </td>
              <td class="px-2 py-1.5">
                {#if ck.match}
                  <span class="text-green-600 dark:text-green-400">pass</span>
                {:else}
                  <span class="font-semibold text-red-600 dark:text-red-400">FAIL</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
