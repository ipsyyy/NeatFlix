/**
 * Central model settings for every NativeFrame agent. Change the model here only.
 * PRODUCT_SOURCE_OF_TRUTH.md §10: Anthropic Claude handles agent reasoning.
 */
export const AGENT_MODEL = "claude-sonnet-4-6";

/** Per-response output ceiling for the BAND Anthropic adapter. Handoffs are compact JSON. */
export const AGENT_MAX_TOKENS = 8000;

/** Upper bound on tool-call rounds in one turn, so a confused agent cannot loop. */
export const AGENT_MAX_TOOL_ROUNDS = 8;
