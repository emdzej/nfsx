/**
 * EDIABAS-X transport config for the `nfsx` CLI.
 *
 * Mirrors the convention of `@emdzej/ediabasx-cli`:
 *
 *   - Config lives at `~/.config/ediabasx/config.json` (or `--ediabas-config <path>`)
 *   - Shape: `{ interface: string, options: InterfaceOptions, logging?: any }`
 *   - `interface` names are factory-level (`simulation` | `serial` | `kdcan` |
 *     `enet` | `gateway`) — broader than the lib-level `EdiabasConfigFile`
 *     schema (which is a strict discriminated union over `kline|dcan|isotp|tp20`).
 *
 * Today this is a small duplicate of `apps/cli/src/utils/{config,interface}.ts`
 * from the ediabasx repo. When a third caller appears (likely ncsx-cli),
 * extract the shared bits into `@emdzej/ediabasx-host-config` and have both
 * CLIs import from there.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { InterfaceOptions } from '@emdzej/ediabasx-interfaces';

export interface EdiabasHostConfig {
  /** Interface name as understood by `createInterface` from `@emdzej/ediabasx-interfaces`. */
  interface: string;
  /** Free-form per-interface options bag. */
  options: InterfaceOptions;
}

export const DEFAULT_EDIABASX_CONFIG_PATH = join(
  homedir(),
  '.config',
  'ediabasx',
  'config.json',
);

export function loadEdiabasxConfig(configPath?: string): EdiabasHostConfig | undefined {
  const path = configPath ?? DEFAULT_EDIABASX_CONFIG_PATH;
  if (!configPath && !existsSync(path)) return undefined;

  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new EdiabasConfigError(`EDIABAS-X config file not found: ${resolved}`);
  }

  const raw = readFileSync(resolved, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EdiabasConfigError(
      `Invalid JSON in ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new EdiabasConfigError(`Invalid EDIABAS-X config in ${resolved}: expected an object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.interface !== 'string' || obj.interface.length === 0) {
    throw new EdiabasConfigError(`Invalid EDIABAS-X config in ${resolved}: "interface" must be a non-empty string`);
  }
  if (obj.options !== undefined && (typeof obj.options !== 'object' || obj.options === null)) {
    throw new EdiabasConfigError(`Invalid EDIABAS-X config in ${resolved}: "options" must be an object`);
  }

  return {
    interface: obj.interface,
    options: (obj.options as InterfaceOptions | undefined) ?? {},
  };
}

/**
 * CLI-level overrides — narrow subset of `apps/cli/src/utils/interface.ts`'s
 * full flag surface. Add to this on demand; for everything else, edit the
 * config file directly.
 *
 * Intentionally NO real-vs-simulation toggle here — that's ediabasx's
 * responsibility (set `interface: "simulation"` in the config, or pass
 * `--interface simulation`). See [[feedback-ediabasx-responsibility]].
 */
export interface EdiabasOverrides {
  /** Override `interface` (e.g. switch from `kdcan` to `gateway` without editing config). */
  interfaceName?: string;
  /** Override `options.port` (serial device path). */
  serialPort?: string;
  /** Override `options.baudRate`. */
  serialBaud?: number;
  /** Convenience: parse `host:port` and set both. */
  gateway?: string;
  /** Override `options.host` (enet/gateway). */
  host?: string;
  /** Override `options.port` (when used for enet/gateway, this is a network port). */
  networkPort?: number;
}

export function resolveEdiabasSelection(
  fileConfig: EdiabasHostConfig | undefined,
  overrides: EdiabasOverrides,
): EdiabasHostConfig {
  const name =
    overrides.interfaceName ??
    (overrides.gateway ? 'gateway' : undefined) ??
    fileConfig?.interface ??
    'simulation';

  const options: InterfaceOptions = { ...(fileConfig?.options ?? {}) };

  if (overrides.serialPort !== undefined) options.port = overrides.serialPort;
  if (overrides.serialBaud !== undefined) options.baudRate = overrides.serialBaud;
  if (overrides.host !== undefined) options.host = overrides.host;
  if (overrides.networkPort !== undefined) options.port = overrides.networkPort;

  if (overrides.gateway) {
    const { host, port } = parseGatewayAddress(overrides.gateway);
    options.host = host;
    options.port = port;
  }

  return { interface: name, options };
}

export function summariseEdiabasSelection(selection: EdiabasHostConfig): string {
  const opts = selection.options;
  const port = opts.port;
  const host = opts.host;
  const baud = opts.baudRate;
  switch (selection.interface) {
    case 'simulation':
      return 'simulation (no hardware)';
    case 'serial':
    case 'kdcan': {
      const baudStr = baud !== undefined ? ` @ ${baud}` : '';
      return `${selection.interface} · ${port ?? 'unknown'}${baudStr}`;
    }
    case 'enet':
      return `enet · ${host ?? 'unknown'}:${port ?? '6801'}`;
    case 'gateway':
      return `gateway · ${host ?? '127.0.0.1'}:${port ?? '6801'}`;
    default:
      return `${selection.interface} · ${JSON.stringify(opts)}`;
  }
}

const DEFAULT_GATEWAY_PORT = 6801;

function parseGatewayAddress(value: string): { host: string; port: number } {
  const trimmed = value.trim();
  if (!trimmed) throw new EdiabasConfigError('--gateway value cannot be empty');

  // IPv6 in brackets: [::1]:6801
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) throw new EdiabasConfigError(`Invalid gateway address: ${value}`);
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : DEFAULT_GATEWAY_PORT;
    if (!Number.isFinite(port) || port <= 0) {
      throw new EdiabasConfigError(`Invalid gateway port in ${value}`);
    }
    return { host, port };
  }

  // host:port or host
  const idx = trimmed.lastIndexOf(':');
  if (idx < 0) return { host: trimmed, port: DEFAULT_GATEWAY_PORT };
  const host = trimmed.slice(0, idx);
  const port = Number.parseInt(trimmed.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new EdiabasConfigError(`Invalid gateway address: ${value}`);
  }
  return { host, port };
}

export class EdiabasConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdiabasConfigError';
  }
}
