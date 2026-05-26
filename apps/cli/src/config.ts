/**
 * Persistent config for the `nfsx` CLI.
 *
 * Lives at `~/.config/nfsx/config.json` by default; `--config <path>`
 * on any subcommand overrides. Pattern mirrors `@emdzej/ediabasx-cli`:
 *
 *   - `loadConfig(path)` — read + validate
 *   - `saveConfig(config, path)` — write (creates dir if needed)
 *   - `getConfigPath(override?)` — resolve the effective config path
 *   - `resolveSpDaten(opts)` — priority chain for the SP-Daten dir
 *
 * Lookup priority for `spDaten`, highest wins:
 *
 *   1. `--sp-daten <dir>` CLI flag
 *   2. `--config <path>`-pointed config file's `spDaten`
 *   3. `~/.config/nfsx/config.json` (default location)
 *   4. `NFSX_SP_DATEN` env var
 *   5. error (no implicit fallback — user must configure)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface NfsxConfig {
  /**
   * Path to the SP-Daten chassis drop (the directory containing
   * `DATA/`, `SGDAT/`, etc.). Required for any command that reads
   * SP-Daten — plan, browse, and flash's precheck stage.
   */
  spDaten?: string;
}

export const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'nfsx');
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json');

/**
 * Pre-fill value for first-run `nfsx configure` — the SP-Daten drop
 * we know the developer has unpacked locally. Pure UI hint; users
 * who unpacked elsewhere just type-over it.
 */
export const SUGGESTED_SP_DATEN = join(homedir(), 'Downloads', 'E46_v74');

/**
 * Best-effort seed value for the configure form. Existing config
 * wins, then `NFSX_SP_DATEN` env var, then the developer-known
 * default. Pure UI suggestion — never auto-persisted.
 */
export function suggestSpDaten(existing: NfsxConfig | undefined = undefined): string {
  if (existing?.spDaten) return existing.spDaten;
  if (process.env.NFSX_SP_DATEN) return process.env.NFSX_SP_DATEN;
  return SUGGESTED_SP_DATEN;
}

/** Resolve the effective config path — explicit override wins. */
export function getConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_CONFIG_PATH;
}

/**
 * Read + validate the config at `configPath`. Throws on missing file
 * or invalid JSON; returns `{}` for an empty-but-readable file so the
 * caller can layer defaults on top.
 */
export function loadConfig(configPath: string): NfsxConfig {
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = readFileSync(resolved, 'utf-8').trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid config in ${resolved}: expected an object`);
  }
  return validate(parsed as Record<string, unknown>);
}

/** Try to load the config file; return `{}` if missing or unreadable. */
export function loadConfigSoft(configPath: string): NfsxConfig {
  try {
    return loadConfig(configPath);
  } catch {
    return {};
  }
}

export function saveConfig(config: NfsxConfig, configPath: string): void {
  const resolved = resolve(configPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function validate(parsed: Record<string, unknown>): NfsxConfig {
  const out: NfsxConfig = {};
  if (parsed.spDaten !== undefined) {
    if (typeof parsed.spDaten !== 'string') {
      throw new Error('Invalid config: "spDaten" must be a string');
    }
    out.spDaten = parsed.spDaten;
  }
  return out;
}

/**
 * Resolve the effective SP-Daten directory using the standard
 * priority chain. Returns the path; throws when no source provides
 * a value (the caller's command can then surface a clean error
 * pointing the user at `nfsx configure`).
 */
export function resolveSpDaten(opts: {
  /** Per-command `--sp-daten` flag, if set. Wins over everything. */
  spDaten?: string;
  /** Per-command `--config` flag, if set. Picks which config file to read. */
  configPath?: string;
}): string {
  if (opts.spDaten) return opts.spDaten;
  const cfgPath = getConfigPath(opts.configPath);
  const fromFile = loadConfigSoft(cfgPath).spDaten;
  if (fromFile) return fromFile;
  const env = process.env.NFSX_SP_DATEN;
  if (env) return env;
  throw new NfsxConfigError(
    'no SP-Daten directory configured.\n' +
      `  Pass --sp-daten <dir>, set NFSX_SP_DATEN, or run \`nfsx configure\`\n` +
      `  to write ${DEFAULT_CONFIG_PATH}.`,
  );
}

/** Thrown by `resolveSpDaten` when nothing in the chain supplies a path. */
export class NfsxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NfsxConfigError';
  }
}
