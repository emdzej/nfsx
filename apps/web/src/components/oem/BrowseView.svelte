<script lang="ts">
  import { app } from "../../lib/state.svelte";
</script>

<div class="mx-auto max-w-4xl p-6">
  <h2 class="text-lg font-bold text-foreground">Browse SP-Daten</h2>

  {#if app.install?.spDaten}
    <p class="mt-2 text-sm text-muted">
      SP-Daten folder found at <code class="text-foreground">{app.install.root.name}/EC-APPS/NFS/DATA</code>.
    </p>
    <div class="mt-6 rounded border border-divider bg-surface p-8 text-center text-sm text-faint">
      HWNR browser coming soon. Enter an HWNR to resolve IPO, SGBD, and firmware files.
    </div>
  {:else}
    <div class="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-300">
      No SP-Daten folder found. Expected <code>EC-APPS/NFS/DATA/</code> inside the picked install root.
    </div>
  {/if}
</div>
