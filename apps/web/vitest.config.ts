import { defineConfig } from "vitest/config";

/**
 * Scope: unit tests for the app's `lib/` helpers only. UI components
 * aren't covered here — Svelte-check catches typing regressions, and
 * end-to-end behaviour is verified via the embedded preview + manual
 * smoke testing on hardware.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
