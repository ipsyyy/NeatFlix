import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectSecrets } from "@/agents/config/env";
import { createRedactingLogger, REDACTED, redactSecrets, safeErrorMessage } from "@/agents/security/redact";
import { buildSystemPrompt } from "@/agents/runtime/prompts";
import { AGENT_ROLES } from "@/agents/config/roles";

const FAKE_BAND_KEY = "band_fake_test_key_9f8e7d6c5b4a";
const FAKE_ANTHROPIC_KEY = "sk-ant-api03-FAKEtestKEY0123456789abcdef";

describe("accidental secret redaction", () => {
  it("removes known secret values wherever they appear", () => {
    const out = redactSecrets(`connecting with ${FAKE_BAND_KEY} then ${FAKE_BAND_KEY}`, [FAKE_BAND_KEY]);
    assert.ok(!out.includes(FAKE_BAND_KEY));
    assert.equal(out.split(REDACTED).length - 1, 2);
  });

  it("removes credential-shaped values even when the exact secret is unknown", () => {
    const samples = [
      "Authorization: Bearer abc.def.ghi-123",
      '{"authorization":"Bearer token-xyz-123"}',
      "x-api-key: some-unknown-key-123",
      "wss://band.example/socket?api_key=unknownkey123&vsn=2.0.0",
      `failure from ${FAKE_ANTHROPIC_KEY}`,
      '{"apiKey":"anything-here"}',
    ];
    for (const s of samples) {
      const out = redactSecrets(s);
      assert.ok(out.includes(REDACTED), `not redacted: ${s}`);
      assert.ok(!/abc\.def|token-xyz|some-unknown|unknownkey123|FAKEtestKEY|anything-here/.test(out), out);
    }
  });

  it("produces safe single-line error messages without stacks", () => {
    const err = new Error(`401 for key ${FAKE_BAND_KEY}\n    at secretFrame (file.ts:1:1)`);
    const msg = safeErrorMessage(err, [FAKE_BAND_KEY]);
    assert.equal(msg, `Error: 401 for key ${REDACTED}`);
  });

  it("redacts the logger's message and structured context before writing", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger("test", [FAKE_BAND_KEY], { write: (l) => lines.push(l) });
    logger.error(`ws failed for ${FAKE_BAND_KEY}`, { url: `wss://x/socket?api_key=${FAKE_BAND_KEY}`, err: new Error(FAKE_BAND_KEY) });
    logger.debug(`debug ${FAKE_BAND_KEY}`);
    assert.equal(lines.length, 1, "debug lines are off by default");
    assert.ok(!lines[0].includes(FAKE_BAND_KEY));
  });

  it("collects configured secrets for redaction and ignores agent IDs", () => {
    const secrets = collectSecrets({
      BAND_SCENE_SCOUT_API_KEY: FAKE_BAND_KEY,
      BAND_SCENE_SCOUT_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
    });
    assert.deepEqual(secrets.sort(), [FAKE_ANTHROPIC_KEY, FAKE_BAND_KEY].sort());
  });

  it("redacts a configured Supabase secret key, but not the project URL", () => {
    // Shaped like a Supabase secret key; not a real credential.
    const fakeSupabaseKey = "sb_secret_TEST0000notarealkey0000";
    const secrets = collectSecrets({ SUPABASE_SECRET_KEY: fakeSupabaseKey, SUPABASE_URL: "https://x.supabase.co" });
    assert.deepEqual(secrets, [fakeSupabaseKey]);
    assert.ok(!redactSecrets(`request failed for ${fakeSupabaseKey}`, secrets).includes(fakeSupabaseKey));
  });

  it("never places environment values into system prompts", () => {
    process.env.BAND_SCENE_SCOUT_API_KEY = FAKE_BAND_KEY;
    try {
      for (const role of AGENT_ROLES) {
        const prompt = buildSystemPrompt(role);
        assert.ok(!prompt.includes(FAKE_BAND_KEY));
        assert.ok(prompt.includes("@mention"), `${role} prompt must require direct mentions`);
      }
    } finally {
      delete process.env.BAND_SCENE_SCOUT_API_KEY;
    }
  });
});
