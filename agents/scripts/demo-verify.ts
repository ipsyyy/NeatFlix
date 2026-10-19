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
const patterns = run("git", ["grep", "-nIE", "sb_secret_[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|mky_[A-Za-z0-9_-]{16,}|lsv2_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY", "--", ".", ":!agents/tests", ":!package-lock.json"]);
const envValues = (() => {
  try {
    return readFileSync(".env.local", "utf8").split("\n").map((l) => l.slice(l.indexOf("=") + 1).trim()).filter((v) => v.length >= 12 && !/^https?:\/\/|^(true|false)$/.test(v));
  } catch {
    return collectSecrets(process.env);
  }
})();
const leaked = envValues.filter((v) => run("git", ["grep", "-qF", "--", v]).ok).length;
results.push({ label: "Secret scan of tracked files", ok: patterns.out.trim() === "" && leaked === 0, detail: leaked === 0 && patterns.out.trim() === "" ? "No key patterns outside test fixtures; no configured secret value is tracked" : "Secret material found in tracked files" });
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
writeFileSync(join(DIR, "checks.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), commit, results }, null, 2)}\n`, { mode: 0o600 });
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}: ${r.detail}`);
console.log("Recorded in .demo/checks.json; run npm run demo:snapshot (or npm run demo) to include them.");
process.exit(results.every((r) => r.ok) ? 0 : 1);
