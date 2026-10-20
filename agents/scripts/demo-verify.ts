/**
 * Runs the repository checks once and records their results for the demo's
 * reliability section (.demo/checks.json): the test suite, lint, typecheck,
 * the production dependency audit, and a secret scan of tracked files. No
 * external provider is called; npm audit queries the npm advisory service.
 *
 * Run: npm run demo:verify
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { describeFindings, envScanCandidates, KEY_PATTERNS, type ScanFinding } from "@/agents/security/secret-scan";

const DIR = resolve(process.cwd(), ".demo");

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

loadLocalEnv();
const results: { label: string; ok: boolean; detail: string }[] = [];
const tests = run("npm", ["test"]);
const pass = /ℹ pass (\d+)/.exec(tests.out)?.[1] ?? "?";
const fail = /ℹ fail (\d+)/.exec(tests.out)?.[1] ?? "?";
results.push({ label: "Automated test suite", ok: tests.ok && fail === "0", detail: `${pass} passed, ${fail} failed` });
results.push({ label: "Lint", ok: run("npm", ["run", "lint"]).ok, detail: "eslint, including the rule that keeps server-only agent code out of the browser" });
results.push({ label: "Typecheck", ok: run("npm", ["run", "typecheck"]).ok, detail: "tsc --noEmit" });
const audit = run("npm", ["audit", "--omit=dev", "--audit-level=high"]);
results.push({ label: "Production dependency audit", ok: audit.ok, detail: /found 0 vulnerabilities/.test(audit.out) ? "0 production vulnerabilities" : "npm audit reported production findings" });
// Value-free findings: categories, variable names, and paths only.
const findings: ScanFinding[] = [];
for (const k of KEY_PATTERNS) {
  const hits = run("git", ["grep", "-lIE", "-e", k.pattern, "--", ".", ":!agents/tests", ":!package-lock.json"]);
  if (hits.out.trim()) findings.push({ kind: "key-pattern", category: k.category, paths: hits.out.trim().split("\n") });
}
const envCandidates = (() => {
  try {
    return envScanCandidates(readFileSync(".env.local", "utf8"));
  } catch {
    return collectSecrets(process.env).map((value) => ({ name: "configured secret", value }));
  }
})();
for (const c of envCandidates) {
  const hits = run("git", ["grep", "-lF", "-e", c.value, "--"]);
  if (hits.ok) findings.push({ kind: "configured-value", category: `configured ${c.name} value`, paths: hits.out.trim().split("\n") });
}
results.push({ label: "Secret scan of tracked files", ok: findings.length === 0, detail: describeFindings(findings) });
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
writeFileSync(join(DIR, "checks.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), commit, results }, null, 2)}\n`, { mode: 0o600 });
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}: ${r.detail}`);
console.log("Recorded in .demo/checks.json; run npm run demo:snapshot (or npm run demo) to include them.");
process.exit(results.every((r) => r.ok) ? 0 : 1);
