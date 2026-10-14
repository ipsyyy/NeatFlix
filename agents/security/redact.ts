import type { Logger } from "@band-ai/sdk/core";

export const REDACTED = "[REDACTED]";

/** Secrets shorter than this are not substring-redacted, to avoid mangling ordinary words. */
const MIN_SECRET_LENGTH = 8;

/**
 * Credential shapes that must never appear in output even when the exact value
 * is unknown: auth headers, key-bearing query parameters, Anthropic keys.
 */
const PATTERNS: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, `$1$2${REDACTED}`],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTED}`],
  [/([?&](?:api_key|apikey|token|access_token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/("?(?:api_?key|apiKey|secret|password)"?\s*[:=]\s*")[^"]+/gi, `$1${REDACTED}`],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes known secret values and credential-shaped substrings from text. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  const known = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** A safe, single-line description of an error: name and redacted message, no stack or request objects. */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode;
    const prefix = typeof status === "number" ? `${error.name} (HTTP ${status})` : error.name;
    return redactSecrets(`${prefix}: ${error.message}`, secrets).split("\n")[0];
  }
  return redactSecrets(String(error), secrets).split("\n")[0];
}

function safeContext(context: Record<string, unknown> | undefined, secrets: readonly string[]): string {
  if (!context || Object.keys(context).length === 0) return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(context, (_key, value) =>
      value instanceof Error ? safeErrorMessage(value, secrets) : value,
    );
  } catch {
    return " [context omitted]";
  }
  return ` ${redactSecrets(serialized, secrets)}`;
}

/**
 * Logger for the BAND SDK and NativeFrame runtime. Every line is redacted
 * before it is written, so SDK diagnostics cannot leak credentials.
 */
export function createRedactingLogger(
  label: string,
  secrets: readonly string[],
  options: { debug?: boolean; write?: (line: string) => void } = {},
): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: string, message: string, context?: Record<string, unknown>) => {
    write(`[${level}] [${label}] ${redactSecrets(message, secrets)}${safeContext(context, secrets)}`);
  };
  return {
    debug: (m, c) => {
      if (options.debug) emit("debug", m, c);
    },
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
  };
}
