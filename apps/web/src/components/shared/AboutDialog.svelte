<script lang="ts">
  import { app } from "../../lib/state.svelte";

  function close(): void {
    app.showAbout = false;
  }
</script>

{#if app.showAbout}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={close}
    onkeydown={(e) => e.key === "Escape" && close()}
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="w-full max-w-md rounded border border-rule bg-surface shadow-2xl"
      role="document"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <header class="flex items-baseline justify-between gap-4 border-b border-divider px-4 py-3">
        <h2 class="text-sm font-bold uppercase tracking-wider text-muted">About NFSX</h2>
        <button
          class="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
          onclick={close}
        >
          close
        </button>
      </header>

      <section class="space-y-3 px-4 py-4 text-sm text-foreground">
        <p class="text-faint">
          BMW ECU flash programming in your browser. IPO-driven, direct DS2, and C167 bootmode paths.
        </p>

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded border border-divider bg-base p-3 text-xs">
          <dt class="font-mono text-faint">nfsx</dt>
          <dd>
            <a
              href="https://github.com/emdzej/nfsx/releases/tag/{__APP_VERSION__}"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-foreground underline-offset-2 hover:text-accent hover:underline"
            >
              {__APP_VERSION__}
            </a>
          </dd>
          <dt class="font-mono text-faint">ediabasx</dt>
          <dd>
            <a
              href="https://github.com/emdzej/ediabasx/releases/tag/{__EDIABASX_VERSION__}"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-foreground underline-offset-2 hover:text-accent hover:underline"
            >
              {__EDIABASX_VERSION__}
            </a>
            <span class="ml-2 text-faint">— EDIABAS / BEST-VM engine</span>
          </dd>
          <dt class="font-mono text-faint">inpax</dt>
          <dd>
            <a
              href="https://github.com/emdzej/inpax/releases/tag/{__INPAX_VERSION__}"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-foreground underline-offset-2 hover:text-accent hover:underline"
            >
              {__INPAX_VERSION__}
            </a>
            <span class="ml-2 text-faint">— INPA IPO interpreter</span>
          </dd>
        </dl>

        <ul class="space-y-1 text-xs">
          <li>
            <a
              href="https://github.com/emdzej/nfsx"
              target="_blank"
              rel="noopener noreferrer"
              class="text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Source on GitHub
            </a>
          </li>
          <li>
            <a
              href="https://github.com/emdzej/nfsx/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              class="text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Report an issue
            </a>
          </li>
        </ul>
      </section>

      <footer class="flex items-center justify-end border-t border-divider bg-elevated/50 px-4 py-2">
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
