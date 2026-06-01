<script lang="ts">
  import { isWebSerialSupported } from "../../lib/config";

  const supported = isWebSerialSupported();
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
  {/if}

  <div class="mt-6 grid gap-4 sm:grid-cols-3">
    <div class="rounded border border-divider bg-surface p-4">
      <h3 class="text-sm font-semibold text-foreground">Probe</h3>
      <p class="mt-1 text-xs text-faint">BSL handshake + read flash chip ID.</p>
      <button
        class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!supported}
      >
        Probe
      </button>
    </div>
    <div class="rounded border border-divider bg-surface p-4">
      <h3 class="text-sm font-semibold text-foreground">Read</h3>
      <p class="mt-1 text-xs text-faint">Read full 512 KB flash.</p>
      <button
        class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!supported}
      >
        Read Flash
      </button>
    </div>
    <div class="rounded border border-divider bg-surface p-4">
      <h3 class="text-sm font-semibold text-foreground">Write</h3>
      <p class="mt-1 text-xs text-faint">Erase + write 512 KB .bin.</p>
      <button
        class="mt-3 w-full rounded border border-rule px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!supported}
      >
        Write Flash
      </button>
    </div>
  </div>

  <p class="mt-6 text-xs text-faint">
    Uses MiniMon + custom stubs by default. JMG blob path (monolithic secondary with
    built-in AM29F400B driver) available as an alternative.
  </p>
</div>
