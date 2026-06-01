import "./app.css";
import App from "./App.svelte";
import { mount } from "svelte";
import { registerSW } from "virtual:pwa-register";
import { getLogger } from "@emdzej/bimmerz-logger";
import { loadConfig } from "./lib/config";
import { applyLoggerConfig } from "./lib/logger-wiring";

applyLoggerConfig(loadConfig().logging);

const log = getLogger("NFSX.web.pwa");

const target = document.getElementById("app");
if (!target) {
  throw new Error("Missing #app mount point");
}

mount(App, { target });

registerSW({
  onRegisteredSW(swUrl) {
    log.info({ swUrl }, "service worker registered");
  },
  onOfflineReady() {
    log.info("offline-ready");
  },
});
