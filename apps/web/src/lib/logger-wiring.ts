import { configureLogger, type LogLevel } from "@emdzej/bimmerz-logger";
import type { WebLoggerConfig } from "./config";

const VALID_LEVELS = new Set<LogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

function sanitizeLevel(value: unknown): LogLevel | undefined {
  return typeof value === "string" && VALID_LEVELS.has(value as LogLevel)
    ? (value as LogLevel)
    : undefined;
}

function sanitizeCategories(
  raw: WebLoggerConfig["categories"],
): Record<string, LogLevel> | undefined {
  if (!raw) return undefined;
  const out: Record<string, LogLevel> = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    const level = sanitizeLevel(value);
    if (level) out[trimmedKey] = level;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function applyLoggerConfig(logging?: WebLoggerConfig): void {
  configureLogger({
    level: sanitizeLevel(logging?.level) ?? "info",
    categories: sanitizeCategories(logging?.categories) ?? {},
  });
}
