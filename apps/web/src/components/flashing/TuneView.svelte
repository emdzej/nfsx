<script lang="ts">
  /**
   * Offline BIN tune editor — mirrors `nfsx tune read | apply`.
   *
   * Load an MS42 / MS43 firmware BIN. The read side surfaces every
   * field the CLI's `read` feature exposes (VIN, immo status, ISN,
   * ECU number, software version, full UIF). The apply side lets the
   * user rewrite the VIN or virginize (0xFF-fill) the immobilizer
   * region. Every apply recomputes CRC-16 + add-32 checksums and
   * offers a download of the patched BIN.
   *
   * Zero-hardware — everything runs client-side against a Uint8Array
   * copy of the file.
   */
  import {
    detectVariant,
    resolveLayout,
    readVin,
    writeVin,
    readImmoStatus,
    readIsn,
    readEcuNumber,
    readSoftwareVersion,
    readUif,
    virginize,
    rewriteMs4xChecksums,
    MS4X_EXPECTED_FILE_LENGTH,
    TuneError,
    type Ms4xEcuVariant,
    type FirmwareLayout,
    type UifRow,
    type ImmoStatus,
  } from "@emdzej/nfsx-flash-data";

  interface TuneState {
    fileName: string | null;
    fileSize: number | null;
    variant: Ms4xEcuVariant | null;
    layout: FirmwareLayout | null;
    // Snapshots of the currently-loaded buffer's fields.
    vin: string;
    immo: ImmoStatus | null;
    isnHex: string;
    ecuNumber: string;
    softwareVersion: string;
    uif: UifRow[];
    // The mutable working buffer + a flag for whether it's been
    // modified since load (drives the Download button's dirty state).
    buffer: Uint8Array | null;
    dirty: boolean;
    error: string | null;
    // Editable-VIN input state — held separately so we can validate
    // before writing.
    newVin: string;
    showUif: boolean;
  }

  const initial: TuneState = {
    fileName: null,
    fileSize: null,
    variant: null,
    layout: null,
    vin: "",
    immo: null,
    isnHex: "",
    ecuNumber: "",
    softwareVersion: "",
    uif: [],
    buffer: null,
    dirty: false,
    error: null,
    newVin: "",
    showUif: false,
  };

  let s: TuneState = $state({ ...initial });

  const canApplyVin = $derived(
    s.buffer !== null &&
      s.layout !== null &&
      /^[A-Z0-9]{17}$/i.test(s.newVin) &&
      s.newVin.toUpperCase() !== s.vin.toUpperCase(),
  );

  const canVirginize = $derived(
    s.buffer !== null && s.layout !== null && s.immo !== null && !s.immo.virgin,
  );

  function reset(): void {
    s = { ...initial };
  }

  function refreshFieldsFromBuffer(): void {
    if (!s.buffer || !s.layout) return;
    s.vin = readVin(s.buffer, s.layout);
    s.newVin = s.vin;
    s.immo = readImmoStatus(s.buffer, s.layout);
    const isnBytes = readIsn(s.buffer, s.layout);
    s.isnHex = Array.from(isnBytes, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    s.ecuNumber = readEcuNumber(s.buffer, s.layout);
    s.softwareVersion = readSoftwareVersion(s.buffer, s.layout);
    s.uif = readUif(s.buffer, s.layout);
  }

  async function pickFile(): Promise<void> {
    reset();
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

      s.fileName = file.name;
      s.fileSize = buf.length;

      if (buf.length !== MS4X_EXPECTED_FILE_LENGTH) {
        s.error = `Expected ${MS4X_EXPECTED_FILE_LENGTH} bytes (512 KB), got ${buf.length}.`;
        return;
      }

      const variant = detectVariant(buf);
      if (!variant) {
        s.error =
          "Could not auto-detect MS42 vs MS43 — header pointer at 0x502CE didn't resolve.";
        return;
      }
      const layout = resolveLayout(buf, variant);

      s.variant = variant;
      s.layout = layout;
      s.buffer = buf;
      refreshFieldsFromBuffer();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      s.error = err instanceof Error ? err.message : String(err);
    }
  }

  function applyVinChange(): void {
    if (!s.buffer || !s.layout) return;
    try {
      writeVin(s.buffer, s.layout, s.newVin);
      rewriteMs4xChecksums(s.buffer, { variant: s.variant ?? undefined });
      s.dirty = true;
      s.error = null;
      refreshFieldsFromBuffer();
    } catch (err) {
      s.error =
        err instanceof TuneError || err instanceof Error
          ? err.message
          : String(err);
    }
  }

  function applyVirginize(): void {
    if (!s.buffer || !s.layout) return;
    try {
      virginize(s.buffer, s.layout);
      rewriteMs4xChecksums(s.buffer, { variant: s.variant ?? undefined });
      s.dirty = true;
      s.error = null;
      refreshFieldsFromBuffer();
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
    }
  }

  function download(): void {
    if (!s.buffer || !s.fileName) return;
    // TS 5.7 tightened BlobPart — copy into a fresh ArrayBuffer so
    // Uint8Array<ArrayBufferLike> narrows to ArrayBufferView<ArrayBuffer>.
    const ab = new ArrayBuffer(s.buffer.byteLength);
    new Uint8Array(ab).set(s.buffer);
    const blob = new Blob([ab], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = derivePatchedName(s.fileName);
    a.click();
    URL.revokeObjectURL(url);
  }

  function derivePatchedName(name: string): string {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return `${name}.patched.bin`;
    return `${name.slice(0, dot)}.patched${name.slice(dot)}`;
  }
</script>

<div class="mx-auto max-w-3xl p-6">
  <h2 class="text-lg font-bold text-foreground">MS42 / MS43 Tune</h2>
  <p class="mt-1 text-sm text-muted">
    Read firmware fields (VIN, immobilizer, ISN, ECU #, software version,
    full UIF), rewrite the VIN, or virginize immobilizer data. All offline
    — nothing leaves the browser. Every apply recomputes CRC-16 + add-32
    checksums automatically.
  </p>

  <div class="mt-4 flex items-center gap-3">
    <button
      class="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-muted"
      onclick={pickFile}
    >
      Pick .bin file
    </button>
    {#if s.buffer}
      <button
        class="rounded border border-rule px-3 py-1.5 text-xs text-muted hover:bg-elevated hover:text-foreground"
        onclick={reset}
      >
        Close file
      </button>
    {/if}
    {#if s.dirty}
      <button
        class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-muted"
        onclick={download}
      >
        Download patched .bin
      </button>
    {/if}
  </div>

  {#if s.error}
    <div class="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
      {s.error}
    </div>
  {/if}

  {#if s.fileName}
    <div class="mt-4 rounded border border-divider bg-surface p-4 text-sm">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-foreground">{s.fileName}</span>
        <span class="text-xs text-faint">{s.fileSize?.toLocaleString()} bytes</span>
        {#if s.variant}
          <span class="rounded bg-elevated px-2 py-0.5 text-xs font-medium text-foreground">
            {s.variant}
          </span>
        {/if}
        {#if s.dirty}
          <span class="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            modified (unsaved)
          </span>
        {/if}
      </div>
    </div>
  {/if}

  {#if s.buffer && s.layout}
    <!-- ── Fields (read) ─────────────────────────────────────────── -->
    <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="rounded border border-divider bg-surface p-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-faint">VIN</div>
        <div class="mt-1 font-mono text-sm text-foreground">{s.vin || "(empty)"}</div>
      </div>
      <div class="rounded border border-divider bg-surface p-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-faint">Immobilizer</div>
        <div class="mt-1 text-sm">
          {#if s.immo?.virgin}
            <span class="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300">
              virgin
            </span>
            <span class="ml-2 text-xs text-faint">no EWS pairing data</span>
          {:else}
            <span class="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              paired
            </span>
            <span class="ml-2 font-mono text-xs text-foreground">ISN: {s.isnHex}</span>
          {/if}
        </div>
      </div>
      <div class="rounded border border-divider bg-surface p-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-faint">ECU number</div>
        <div class="mt-1 font-mono text-sm text-foreground">{s.ecuNumber || "(empty)"}</div>
      </div>
      <div class="rounded border border-divider bg-surface p-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-faint">Software version</div>
        <div class="mt-1 font-mono text-sm text-foreground">{s.softwareVersion || "(empty)"}</div>
      </div>
    </div>

    <!-- ── UIF table (expandable) ────────────────────────────────── -->
    <div class="mt-4 rounded border border-divider bg-surface">
      <button
        class="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-faint hover:bg-elevated"
        onclick={() => (s.showUif = !s.showUif)}
      >
        <span>UIF table — 14 rows</span>
        <span>{s.showUif ? "▾" : "▸"}</span>
      </button>
      {#if s.showUif}
        <table class="w-full text-xs">
          <thead>
            <tr class="border-t border-divider text-left text-faint">
              <th class="px-2 py-1 font-medium">#</th>
              <th class="px-2 py-1 font-medium">VIN</th>
              <th class="px-2 py-1 font-medium">Date</th>
              <th class="px-2 py-1 font-medium">Soft</th>
              <th class="px-2 py-1 font-medium">Serv</th>
            </tr>
          </thead>
          <tbody>
            {#each s.uif as row (row.index)}
              <tr class="border-t border-divider/50">
                <td class="px-2 py-1 text-muted">{row.index}</td>
                <td class="px-2 py-1 font-mono text-foreground">{row.vin || "—"}</td>
                <td class="px-2 py-1 font-mono text-muted">
                  {Array.from(row.date, (b) => b.toString(16).padStart(2, "0")).join(" ")}
                </td>
                <td class="px-2 py-1 font-mono text-muted">
                  {Array.from(row.soft, (b) => b.toString(16).padStart(2, "0")).join(" ")}
                </td>
                <td class="px-2 py-1 font-mono text-muted">
                  {Array.from(row.serv, (b) => b.toString(16).padStart(2, "0")).join(" ")}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- ── Apply (write) ─────────────────────────────────────────── -->
    <div class="mt-6 grid gap-4 sm:grid-cols-2">
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Rewrite VIN</h3>
        <p class="mt-1 text-xs text-faint">
          Writes the new VIN to all {s.layout.uifRows} UIF rows. Checksums are
          recomputed automatically. 17 chars, [A-Z0-9] only.
        </p>
        <input
          type="text"
          maxlength="17"
          class="mt-2 w-full rounded border border-rule bg-base px-2 py-1 font-mono text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
          bind:value={s.newVin}
          onchange={(e) => (s.newVin = (e.currentTarget as HTMLInputElement).value.toUpperCase())}
          placeholder="WBAXX00000AA00000"
        />
        <button
          class="mt-2 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canApplyVin}
          onclick={applyVinChange}
        >
          Apply VIN
        </button>
      </div>
      <div class="rounded border border-divider bg-surface p-4">
        <h3 class="text-sm font-semibold text-foreground">Virginize</h3>
        <p class="mt-1 text-xs text-faint">
          0xFF-fills the immobilizer region ({s.layout.immoClearSize} bytes @
          0x{s.layout.immoClearOffset.toString(16).toUpperCase()}). Clears ISN
          + EWS pairing so the DME can re-pair via INPA.
        </p>
        <button
          class="mt-2 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canVirginize}
          onclick={applyVirginize}
        >
          {s.immo?.virgin ? "Already virgin" : "Clear immobilizer"}
        </button>
      </div>
    </div>
  {/if}
</div>
