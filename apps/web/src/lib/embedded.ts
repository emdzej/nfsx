/**
 * Embedded build helpers — when nfsx-web is hosted by the dongle
 * itself (`vite --mode embedded` → `/nfsx/` base on the Bimmerz Box's
 * ESP32-P4), connection + install paths lock onto the dongle's HTTP
 * origin instead of letting the user pick. See `vite.config.ts` for
 * the build-mode contract.
 *
 * Three endpoints, all at the dongle's HTTP root (siblings of the
 * `/nfsx/` SPA prefix):
 *
 *   • `ws://<origin>/rpc/ediabasx` — JSON-RPC IEdiabas server the
 *     dongle exposes. `EdiabasClient` opens this socket for the OEM
 *     scope's SGBD-driven flows (backup, plan, verify).
 *   • `ws://<origin>/rpc/uart/0` — raw K-line UART socket. The
 *     Flashing scope's directmode + bootmode transports open this
 *     instead of `navigator.serial.requestPort()` when running
 *     embedded, so the dongle's L9637D drives the wire on our
 *     behalf. See `rpc-uart-transport.ts` for the wire protocol.
 *   • `http://<origin>/data` — VFS root (a tree of `index.json`
 *     listings, same shape `bimmerz data index` produces). The
 *     install layer mounts an `HttpDirectory` here on boot.
 *
 * The constant `isEmbedded` is a `define` substitution — every
 * `if (!isEmbedded)` block tree-shakes out of the embedded build,
 * and vice versa, so there's no runtime cost in either bundle.
 *
 * Same shape as `apps/web/src/lib/embedded.ts` in ediabasx / inpax /
 * ncsx; kept separate per app so each can evolve its own endpoint
 * conventions.
 */

/** Set to `true` by `vite --mode embedded`; `false` otherwise. */
export const isEmbedded: boolean = __EMBEDDED__;

/**
 * Endpoints the dongle serves alongside the SPA. Computed lazily so
 * the origin is read fresh on every call — handy if the dongle's
 * IP/host changes between sessions (different AP, LAN IP change); the
 * persisted SPA artefact still picks up the right URLs on next open.
 */
export function embeddedEndpoints(): {
  serverWsUrl: string;
  uartWsUrl: string;
  installHttpBase: string;
} {
  const origin = window.location.origin;
  /* `replace(/^http/, 'ws')` upgrades both http→ws and https→wss
     (regex anchored on the start so the trailing `s` survives).
     Dongle default is plain `http:` (TLS provisioning on ESP32
     SoftAP is awkward); a reverse-proxied deploy might front it
     with TLS. */
  const wsOrigin = origin.replace(/^http/, "ws");
  return {
    serverWsUrl: `${wsOrigin}/rpc/ediabasx`,
    uartWsUrl: `${wsOrigin}/rpc/uart/0`,
    installHttpBase: `${origin}/data`,
  };
}
