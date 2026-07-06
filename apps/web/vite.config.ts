import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string; dependencies?: Record<string, string> };

function cleanSemver(range: string | undefined): string {
  if (!range) return "(unknown)";
  return range.replace(/^[\^~]/, "");
}

const ediabasxVersion = cleanSemver(pkg.dependencies?.["@emdzej/ediabasx-ediabas"]);
const inpaxVersion = cleanSemver(pkg.dependencies?.["@emdzej/inpax-interpreter"]);

/**
 * Build modes — same shape as the ediabasx / inpax / ncsx web apps.
 *
 *   • `pnpm build:web` — default. Full browser SPA: install picker,
 *     mode toggle, settings, PWA service worker, persisted config.
 *     Deploys to nfsx.bimmerz.app.
 *
 *   • `pnpm build:web:embedded` — dongle build. SPA hosted by the
 *     dongle at `/nfsx/`, talking back to the same origin for
 *     IEdiabas (`/rpc/ediabasx`), raw K-line (`/rpc/uart/0`), and
 *     install (`/data`):
 *       - `__EMBEDDED__` compile-time constant.
 *       - Mode / connectionMethod / serverUrl locked to client +
 *         direct + `${origin}/rpc/ediabasx` (see `lib/embedded.ts`).
 *       - Directmode / Bootmode transports build against
 *         `${origin}/rpc/uart/0` instead of Web Serial — no cable
 *         picker on the dongle path.
 *       - Install auto-mounts from `${origin}/data` on boot.
 *       - PWA service worker dropped.
 *
 * Outputs live side-by-side: `dist/` and `dist-embedded/`.
 */
export default defineConfig(({ mode }) => {
  const isEmbedded = mode === "embedded";
  return {
    /* Embedded build is mounted at `/nfsx/` on the dongle — firmware
       serves `/ediabasx/`, `/inpax/`, `/ncsx/`, `/nfsx/` side by side
       with `/rpc/ediabasx`, `/rpc/uart/0`, and `/data/` as siblings
       at the HTTP root. */
    base: isEmbedded ? "/nfsx/" : "/",
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __EDIABASX_VERSION__: JSON.stringify(ediabasxVersion),
      __INPAX_VERSION__: JSON.stringify(inpaxVersion),
      __EMBEDDED__: JSON.stringify(isEmbedded),
    },
    plugins: [
      svelte(),
      /* Bimmerz Box app manifest. The dongle's dashboard auto-
         discovers apps under `/sdcard/apps/<slug>/` and reads each
         folder's `manifest.json` to render a tile — see
         https://github.com/emdzej/bimmerz-box#app-manifest. Emitting
         from the plugin (not a static file in `public/`) keeps the
         `version` field in lockstep with package.json without a
         manual bump on every release. Only relevant to the embedded
         build. */
      isEmbedded && {
        name: "nfsx-embedded-manifest",
        apply: "build" as const,
        generateBundle(): void {
          this.emitFile({
            type: "asset",
            fileName: "manifest.json",
            source: JSON.stringify(
              {
                name: "NFSX",
                description: "BMW ECU flashing — direct DS2, C167 bootmode, IPO-driven",
                version: pkg.version,
                icon: "icon.svg",
                /* Advisory — dashboard flags tiles whose requirements
                   aren't met by the dongle hardware. Both flash paths
                   drive K-line: direct DS2 uses the L9637D
                   transceiver via `/rpc/uart/0`, and the C167 BSL
                   speaks the same wire. No CAN traffic in either
                   scope today. */
                requires: ["kline"],
              },
              null,
              2,
            ) + "\n",
          });
        },
      },
      /* PWA — skipped in the embedded build (no offline-cache benefit
         on a dongle with no internet, autoUpdate is confusing on
         hardware the user doesn't manage). */
      !isEmbedded && VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["icon.svg"],
        manifest: {
          name: "NFSX",
          short_name: "NFSX",
          description:
            "BMW ECU flashing in the browser — IPO-driven, direct DS2, and C167 bootmode paths.",
          theme_color: "#1c69d4",
          background_color: "#ffffff",
          display: "standalone",
          start_url: "/",
          scope: "/",
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          navigateFallback: "/index.html",
        },
      }),
    ],
    server: {
      port: 5176,
    },
    optimizeDeps: {
      include: [
        "@emdzej/nfsx-data-files",
        "@emdzej/nfsx-flash-data",
        "@emdzej/nfsx-resolver",
        "@emdzej/nfsx-runtime",
        "@emdzej/nfsx-flash",
        "@emdzej/nfsx-fsc",
        "@emdzej/nfsx-directmode",
        "@emdzej/ediabasx-ediabas",
        "@emdzej/ediabasx-interface-base",
        "@emdzej/ediabasx-interface-serial",
        "@emdzej/ediabasx-interfaces/client",
        "@emdzej/inpax-core",
        "@emdzej/inpax-dispatcher",
        "@emdzej/inpax-ediabasx-provider",
        "@emdzej/inpax-interfaces",
        "@emdzej/inpax-interpreter",
        "@emdzej/inpax-parser",
        "@emdzej/inpax-providers",
      ],
      /* `@emdzej/bimmerz-ui` ships source-only `.svelte` + `.svelte.ts`.
         Excluded from pre-bundling so each file goes through
         `@sveltejs/vite-plugin-svelte`'s transform on-demand —
         esbuild lacks the loader for those extensions and would
         choke on TS syntax in a `.svelte.ts` rune helper. Same
         pattern the ediabasx / inpax / ncsx web apps use. */
      exclude: ["@emdzej/bimmerz-ui"],
    },
    build: {
      /* Embedded output lives in dist-embedded/ — firmware packagers
         ship it at the dongle's `/nfsx/` HTTP prefix. */
      outDir: isEmbedded ? "dist-embedded" : "dist",
      /* Drop sourcemaps on the dongle — flash is precious. */
      sourcemap: !isEmbedded,
      commonjsOptions: {
        include: [/node_modules/, /packages\//],
        transformMixedEsModules: true,
      },
      /* Embedded build drops the PWA plugin. main.ts's dynamic
         `import("virtual:pwa-register")` is gated behind
         `if (!isEmbedded)` and tree-shakes, but Rollup still resolves
         the virtual specifier statically — mark it external so the
         unreachable call site doesn't fail the build. */
      rollupOptions: isEmbedded
        ? { external: ["virtual:pwa-register"] }
        : undefined,
    },
  };
});
