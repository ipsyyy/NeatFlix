/**
 * The demo's secret scan of tracked files (agents/scripts/demo-verify.ts):
 * credential-shaped patterns outside the test fixtures, and any configured
 * .env.local value that appears verbatim in a tracked file. Findings name only
 * a category, a variable name, and file paths: never a value.
 */

/** Credential shapes that must not appear in tracked files outside agents/tests. */
export const KEY_PATTERNS: readonly { category: string; pattern: string }[] = Object.freeze([
  { category: "Supabase secret key", pattern: "sb_secret_[A-Za-z0-9_-]{16,}" },
  { category: "Anthropic API key", pattern: "sk-ant-[A-Za-z0-9_-]{10,}" },
  { category: "Google API key", pattern: "AIza[0-9A-Za-z_-]{30,}" },
  { category: "Masky API key", pattern: "mky_[A-Za-z0-9_-]{16,}" },
  { category: "LangSmith API key", pattern: "lsv2_[A-Za-z0-9_]{20,}" },
  { category: "Private key", pattern: "-----BEGIN [A-Z ]*PRIVATE KEY" },
]);

/**
 * Configuration variables whose values are public identifiers, committed on
 * purpose, and never credentials. Listed by exact name only: every other value,
 * including commented-out lines and publishable keys, is still scanned.
 */
export const PUBLIC_CONFIG_NAMES: ReadonlySet<string> = new Set([
  // The LangSmith project name, published with the case trace (agents/observability/published.ts).
  "LANGSMITH_PROJECT",
]);

const MIN_VALUE_LENGTH = 12;

/** The .env.local values to look for in tracked files, each with the name it is reported under. */
export function envScanCandidates(envText: string): { name: string; value: string }[] {
  return envText.split("\n").flatMap((line, i) => {
    const eq = line.indexOf("=");
    const name = eq >= 0 ? line.slice(0, eq).replace(/^\s*#?\s*(export\s+)?/, "").trim() : `line ${i + 1}`;
    const value = line.slice(eq + 1).trim();
    if (value.length < MIN_VALUE_LENGTH || /^https?:\/\/|^(true|false)$/.test(value)) return [];
    // Only an active assignment of an allowlisted public setting is skipped.
    if (PUBLIC_CONFIG_NAMES.has(name) && !line.trimStart().startsWith("#")) return [];
    return [{ name, value }];
  });
}

export type ScanFinding = { kind: "key-pattern" | "configured-value"; category: string; paths: string[] };

/** A one-line, value-free summary of the findings for .demo/checks.json. */
export function describeFindings(findings: readonly ScanFinding[]): string {
  if (findings.length === 0) return "No key patterns outside test fixtures; no configured secret value is tracked";
  return `Secret material found in tracked files: ${findings.map((f) => `${f.category} in ${f.paths.join(", ")}`).join("; ")}`;
}
