# @emdzej/nfsx-web

Browser SPA for **nfsx** — BMW ECU flashing. Two scopes:

- **OEM** — the dealer flow. Point at an SP-Daten install (folder-pick
  or bundled zip or remote HTTP-VFS), pick a target ECU, back up, plan,
  flash, verify. Uses the IPO-driven flash runtime layered on top of
  `IEdiabas` (local cable / remote server / dongle).
- **Flashing** — lower-level tools: image checksum / hex-view (Tune),
  direct DS2 read-write for E36 / E38 / E39 / E46 ECUs, and C167 BSL
  bootmode for bench-pulled MS42 / MS43 / similar.

Deploys to [nfsx.bimmerz.app](https://nfsx.bimmerz.app) as a PWA.

## Run locally

```bash
pnpm --filter @emdzej/nfsx-web dev            # http://localhost:5176
pnpm --filter @emdzej/nfsx-web build          # → apps/web/dist/
pnpm --filter @emdzej/nfsx-web preview        # serve dist/ on :4173
pnpm --filter @emdzej/nfsx-web typecheck
pnpm --filter @emdzej/nfsx-web test           # RpcUartTransport tests
```

## Embedded build (dongle-hosted)

The `embedded` mode targets the [Bimmerz Box](https://github.com/emdzej/bimmerz-box)
dongle scenario, where this SPA is served by the dongle itself at
`http://172.16.7.1/nfsx/` alongside the `ediabasx-server` process and
the K-line transceiver. The build differs from the default browser
build in five ways:

- **OEM connection is locked to the dongle** — `mode: client`,
  `connectionMethod: direct`, `serverUrl: ${origin}/rpc/ediabasx`, and
  the install auto-mounts from `${origin}/data` on boot. No install
  picker, no mode toggle.
- **OEM auto-connect on open** — the `useEmbeddedAutoConnect` hook
  from `@emdzej/bimmerz-ui` opens the RPC session once the install has
  mounted (readiness gate: `app.install !== null`), retries with
  exponential backoff on transient drops, and disconnects cleanly on
  `beforeunload` / `pagehide`.
- **Direct DS2 / bootmode use `/rpc/uart/0`** — the Flashing scope's
  Directmode and Bootmode subviews swap `navigator.serial.requestPort()`
  for `RpcUartTransport` (a JSON-RPC-over-WebSocket client for the
  dongle's raw K-line endpoint — see
  [`lib/rpc-uart-transport.ts`](src/lib/rpc-uart-transport.ts) for the
  wire protocol). Same DS2 / BSL protocol code above; only the byte
  pipe changes. `/rpc/uart/0` is arbitrated against the ediabasx VM's
  own K-line access — while a flash session holds the wire, OEM `job`
  calls fail with a transport error.
- **No PWA / service worker** — the dongle has no internet, precache
  + autoUpdate flows are noise on hardware the user doesn't manage.
- **Bimmerz Box `manifest.json`** — a small Vite plugin emits
  `dist-embedded/manifest.json` (name, description, version from
  `package.json`, icon, `requires: ["kline"]`) so the dongle
  dashboard auto-discovers the app and renders a tile. Schema
  documented in [bimmerz-box's App manifest section](https://github.com/emdzej/bimmerz-box#app-manifest).

```bash
pnpm build:web:embedded          # → apps/web/dist-embedded/
pnpm preview:web:embedded        # serve dist-embedded/ locally on :4173
# → http://localhost:4173/nfsx/  (note the /nfsx/ prefix)
```

Ship `dist-embedded/` to the dongle's HTTP root under `/nfsx/`. The
Bimmerz Box firmware picks it up from `/sdcard/apps/nfsx/`.

Release builds attach `nfsx-web-embedded-<version>.zip` to the GitHub
Release so dongle packagers can drop the zip straight onto the SD
card without cloning + building the monorepo.
