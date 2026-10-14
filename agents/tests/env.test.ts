import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigError,
  findMissingVariables,
  readAllCredentials,
  readAnthropicKey,
  readBandUrls,
  readRoleCredentials,
  type Env,
} from "@/agents/config/env";
import { AGENT_REGISTRY, AGENT_ROLES } from "@/agents/config/roles";
import { FAKE_UUIDS } from "./fixtures";

function fullEnv(): Env {
  const env: Env = {};
  AGENT_ROLES.forEach((role, i) => {
    env[AGENT_REGISTRY[role].env.agentId] = FAKE_UUIDS[i];
    env[AGENT_REGISTRY[role].env.apiKey] = `fake-test-key-${role}-0123456789`;
  });
  return env;
}

describe("environment validation", () => {
  it("maps every role to the agreed variable names", () => {
    assert.deepEqual(
      AGENT_ROLES.map((r) => AGENT_REGISTRY[r].env),
      [
        { agentId: "BAND_CONTENT_CURATOR_AGENT_ID", apiKey: "BAND_CONTENT_CURATOR_API_KEY" },
        { agentId: "BAND_SCENE_SCOUT_AGENT_ID", apiKey: "BAND_SCENE_SCOUT_API_KEY" },
        { agentId: "BAND_CAMPAIGN_MATCHER_AGENT_ID", apiKey: "BAND_CAMPAIGN_MATCHER_API_KEY" },
        { agentId: "BAND_PLACEMENT_DIRECTOR_AGENT_ID", apiKey: "BAND_PLACEMENT_DIRECTOR_API_KEY" },
        { agentId: "BAND_RELEASE_GOVERNOR_AGENT_ID", apiKey: "BAND_RELEASE_GOVERNOR_API_KEY" },
      ],
    );
  });

  it("reads all five credentials from a complete environment", () => {
    const creds = readAllCredentials(fullEnv());
    assert.equal(creds.length, 5);
    assert.deepEqual(creds.map((c) => c.role), [...AGENT_ROLES]);
  });

  it("names only the missing variable, never any value", () => {
    const env = fullEnv();
    const leakedKey = env.BAND_SCENE_SCOUT_API_KEY as string;
    delete env.BAND_SCENE_SCOUT_AGENT_ID;
    assert.throws(
      () => readRoleCredentials(env, "scene-scout"),
      (err: unknown) =>
        err instanceof ConfigError &&
        err.message === "Missing required environment variable: BAND_SCENE_SCOUT_AGENT_ID" &&
        !err.message.includes(leakedKey),
    );
  });

  it("treats blank values as missing and reports every missing name at once", () => {
    const env = fullEnv();
    env.BAND_CONTENT_CURATOR_API_KEY = "   ";
    delete env.BAND_RELEASE_GOVERNOR_AGENT_ID;
    assert.deepEqual(findMissingVariables(env), [
      "BAND_CONTENT_CURATOR_API_KEY",
      "BAND_RELEASE_GOVERNOR_AGENT_ID",
    ]);
    assert.throws(() => readAllCredentials(env), /BAND_CONTENT_CURATOR_API_KEY, BAND_RELEASE_GOVERNOR_AGENT_ID/);
  });

  it("rejects a malformed agent ID without echoing it", () => {
    const env = fullEnv();
    env.BAND_CAMPAIGN_MATCHER_AGENT_ID = "not-a-uuid-secretish-value";
    assert.throws(
      () => readRoleCredentials(env, "campaign-matcher"),
      (err: unknown) =>
        err instanceof ConfigError &&
        err.message === "BAND_CAMPAIGN_MATCHER_AGENT_ID is not a valid agent UUID",
    );
  });

  it("treats BAND URLs as optional and validates them by name", () => {
    assert.deepEqual(readBandUrls({}), {});
    assert.deepEqual(readBandUrls({ BAND_REST_URL: "https://example.test" }), { restUrl: "https://example.test" });
    assert.throws(() => readBandUrls({ BAND_WS_URL: "::not a url::" }), /^ConfigError: BAND_WS_URL is not a valid URL$/);
  });

  it("requires the Anthropic key by name", () => {
    assert.throws(() => readAnthropicKey({}), /Missing required environment variable: ANTHROPIC_API_KEY/);
  });
});
