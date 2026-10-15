import type { AgentRole } from "./roles";

/**
 * Central model settings for every NativeFrame agent. Change the model here only.
 * PRODUCT_SOURCE_OF_TRUTH.md §10: Anthropic Claude handles agent reasoning.
 */
export const AGENT_MODEL = "claude-sonnet-4-6";

/** Per-response output ceiling for the BAND Anthropic adapter. Handoffs are compact JSON. */
export const AGENT_MAX_TOKENS = 8000;

/** Upper bound on tool-call rounds in one turn, so a confused agent cannot loop. */
export const AGENT_MAX_TOOL_ROUNDS = 8;

/** The SDK's default turn budget, kept for every role that drafts compact handoffs. */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * Placement Director's turn budget. One full placement-plan draft takes about a
 * minute per tool round, so a validate-then-send turn with revisions needs more
 * than the default. AGENT_MAX_TOOL_ROUNDS still bounds repair loops.
 */
export const PLACEMENT_DIRECTOR_TURN_TIMEOUT_MS = 12 * 60_000;

/**
 * Release Governor's turn budget. A full typed review draft took about 40–56 s
 * per tool round live, and one turn used 3 min 58 s of the default, so the
 * Governor gets more room. AGENT_MAX_TOOL_ROUNDS still bounds repair loops.
 */
export const RELEASE_GOVERNOR_TURN_TIMEOUT_MS = 10 * 60_000;

/** Per-role turn limits. Only Placement Director and Release Governor get longer budgets. */
export function turnLimitsFor(role: AgentRole): { turnTimeoutMs: number; maxToolRounds: number } {
  const turnTimeoutMs =
    role === "placement-director" ? PLACEMENT_DIRECTOR_TURN_TIMEOUT_MS : role === "release-governor" ? RELEASE_GOVERNOR_TURN_TIMEOUT_MS : DEFAULT_TURN_TIMEOUT_MS;
  return { turnTimeoutMs, maxToolRounds: AGENT_MAX_TOOL_ROUNDS };
}
