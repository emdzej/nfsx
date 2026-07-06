import "./app.css";
import App from "./App.svelte";
import { mount } from "svelte";
import { getLogger } from "@emdzej/bimmerz-logger";
import { loadConfig } from "./lib/config";
import { isEmbedded } from "./lib/embedded";
import { applyLoggerConfig } from "./lib/logger-wiring";

applyLoggerConfig(loadConfig().logging);

const target = document.getElementById("app");
if (!target) {
  throw new Error("Missing #app mount point");
}

mount(App, { target });

/* PWA service worker — dropped in the embedded build. The dongle has
   no internet, no offline-cache benefit (the SPA already lives on
   flash), and autoUpdate flows are confusing on hardware the user
   doesn't manage. Rollup marks `virtual:pwa-register` as external in
   the embedded build (see vite.config.ts) so this gated branch
   tree-shakes cleanly. */
if (!isEmbedded) {
  const log = getLogger("NFSX.web.pwa");
  void import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({
      onRegisteredSW(swUrl) {
        log.info({ swUrl }, "service worker registered");
      },
      onOfflineReady() {
        log.info("offline-ready");
      },
    });
  });
}
