<script lang="ts">
  import { app } from "../../lib/state.svelte";
</script>

{#if app.error}
  <div class="fixed bottom-4 left-1/2 z-50 max-w-2xl -translate-x-1/2 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-300">
    <div class="flex items-start justify-between gap-3">
      <span>{app.error}</span>
      <button
        class="text-xs text-red-700 hover:underline dark:text-red-400"
        onclick={() => (app.error = null)}
      >
        dismiss
      </button>
    </div>
  </div>
{/if}
