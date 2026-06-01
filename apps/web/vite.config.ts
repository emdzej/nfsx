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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __EDIABASX_VERSION__: JSON.stringify(ediabasxVersion),
    __INPAX_VERSION__: JSON.stringify(inpaxVersion),
  },
  plugins: [
    svelte(),
    VitePWA({
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
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\//],
      transformMixedEsModules: true,
    },
  },
});
