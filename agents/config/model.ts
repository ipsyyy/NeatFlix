/**
 * Central model settings for every NativeFrame agent. Change the model here only.
 * PRODUCT_SOURCE_OF_TRUTH.md §10: Anthropic Claude handles agent reasoning.
 */
export const AGENT_MODEL = "claude-sonnet-4-6";

/** Per-response output ceiling for the BAND Anthropic adapter. Handoffs are compact JSON. */
export const AGENT_MAX_TOKENS = 8000;

/** Upper bound on tool-call rounds in one turn, so a confused agent cannot loop. */
export const AGENT_MAX_TOOL_ROUNDS = 8;

/**
 * Time budget for one whole turn, across its tool rounds. The SDK default is
 * five minutes, but a Placement Director round that drafts the full placement
 * plan takes about a minute, so validate-then-send with one revision needs
 * more. Ten minutes still ends a stuck turn; AGENT_MAX_TOOL_ROUNDS bounds loops.
 */
export const AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
