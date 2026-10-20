import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFindings, envScanCandidates, KEY_PATTERNS, PUBLIC_CONFIG_NAMES } from "@/agents/security/secret-scan";

// Fake values assembled at runtime, so this file holds no key-shaped literal.
const fake = (prefix: string, n = 40) => `${prefix}${"0123456789abcdef".repeat(4).slice(0, n)}`;

describe("tracked-file secret scan", () => {
  it("skips only an active assignment of an allowlisted public setting", () => {
    const env = [
      "LANGSMITH_PROJECT=nativeframe-demo-case",
      "# LANGSMITH_PROJECT=nativeframe-old-case",
      "LANGSMITH_PROJECT_KEY=public-looking-but-not-listed",
      "X_LANGSMITH_PROJECT=another-unlisted-value",
      `LANGSMITH_API_KEY=${fake("lsv2_pt_")}`,
      `export SUPABASE_SECRET_KEY=${fake("sb_" + "secret_")}`,
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${fake("sb_publishable_")}`,
      `# OLD_ANTHROPIC_API_KEY=${fake("sk-" + "ant-")}`,
      "SUPABASE_URL=https://example.supabase.co",
      "LANGSMITH_TRACING=true",
      "SHORT=abc",
    ].join("\n");
    const names = envScanCandidates(env).map((c) => c.name);
    assert.deepEqual(names, ["LANGSMITH_PROJECT", "LANGSMITH_PROJECT_KEY", "X_LANGSMITH_PROJECT", "LANGSMITH_API_KEY", "SUPABASE_SECRET_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "OLD_ANTHROPIC_API_KEY"]);
    assert.ok(!envScanCandidates(env).some((c) => c.value === "nativeframe-demo-case"), "the active public project name is not treated as a secret");
    assert.ok(envScanCandidates(env).some((c) => c.value === "nativeframe-old-case"), "a commented-out line is still scanned");
  });

  it("allowlists no credential variable", () => {
    for (const name of PUBLIC_CONFIG_NAMES) assert.doesNotMatch(name, /KEY|SECRET|TOKEN|PASSWORD|API/i, name);
  });

  it("still recognises every credential shape", () => {
    const samples = [fake("sb_" + "secret_"), fake("sk-" + "ant-"), fake("AI" + "za", 35), fake("mky" + "_"), fake("lsv2" + "_pt_"), "-----BEGIN RSA PRIVATE " + "KEY-----"];
    for (const [i, k] of KEY_PATTERNS.entries()) assert.match(samples[i], new RegExp(k.pattern), k.category);
  });

  it("reports categories and paths, never values", () => {
    const value = fake("lsv2_pt_");
    const detail = describeFindings([{ kind: "configured-value", category: "configured LANGSMITH_API_KEY value", paths: ["lib/x.ts"] }]);
    assert.match(detail, /LANGSMITH_API_KEY value in lib\/x\.ts/);
    assert.ok(!detail.includes(value));
    assert.equal(describeFindings([]), "No key patterns outside test fixtures; no configured secret value is tracked");
  });
});
