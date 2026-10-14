/**
 * Typed registry of the five NativeFrame BAND agents (PRODUCT_SOURCE_OF_TRUTH.md §4).
 * Each role maps to the names of its environment variables, never their values.
 */

export const AGENT_ROLES = [
  "content-curator",
  "scene-scout",
  "campaign-matcher",
  "placement-director",
  "release-governor",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/** The human release gate. Not a BAND agent, but a valid handoff recipient. */
export const HUMAN_REVIEWER = "human-reviewer" as const;
export type HandoffParty = AgentRole | typeof HUMAN_REVIEWER;

export type AgentDefinition = {
  role: AgentRole;
  displayName: string;
  /** One-line description used in the agent's system prompt. */
  description: string;
  env: { agentId: string; apiKey: string };
};

export const AGENT_REGISTRY: Readonly<Record<AgentRole, AgentDefinition>> = Object.freeze({
  "content-curator": {
    role: "content-curator",
    displayName: "Content Curator",
    description:
      "the NativeFrame agent that verifies title ownership, rights, sensitivity, actor restrictions, and pipeline eligibility",
    env: { agentId: "BAND_CONTENT_CURATOR_AGENT_ID", apiKey: "BAND_CONTENT_CURATOR_API_KEY" },
  },
  "scene-scout": {
    role: "scene-scout",
    displayName: "Scene Scout",
    description:
      "the NativeFrame agent that evaluates candidate scenes for tone, framing, movement, surfaces, duration, and actor restrictions",
    env: { agentId: "BAND_SCENE_SCOUT_AGENT_ID", apiKey: "BAND_SCENE_SCOUT_API_KEY" },
  },
  "campaign-matcher": {
    role: "campaign-matcher",
    displayName: "Campaign Matcher",
    description:
      "the NativeFrame agent that matches an approved scene with an advertiser, product, and eligible audience",
    env: { agentId: "BAND_CAMPAIGN_MATCHER_AGENT_ID", apiKey: "BAND_CAMPAIGN_MATCHER_API_KEY" },
  },
  "placement-director": {
    role: "placement-director",
    displayName: "Placement Director",
    description:
      "the NativeFrame agent that writes placement instructions for an approved campaign and scene",
    env: { agentId: "BAND_PLACEMENT_DIRECTOR_AGENT_ID", apiKey: "BAND_PLACEMENT_DIRECTOR_API_KEY" },
  },
  "release-governor": {
    role: "release-governor",
    displayName: "Release Governor",
    description:
      "the NativeFrame agent that evaluates helpfulness, honesty, and harmlessness and enforces the human release gate",
    env: { agentId: "BAND_RELEASE_GOVERNOR_AGENT_ID", apiKey: "BAND_RELEASE_GOVERNOR_API_KEY" },
  },
});

/** Shared, optional connection settings. The BAND SDK supplies defaults when unset. */
export const BAND_URL_ENV = { restUrl: "BAND_REST_URL", wsUrl: "BAND_WS_URL" } as const;

/** Credential for the Claude reasoning model used by every agent. */
export const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY" as const;

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}
