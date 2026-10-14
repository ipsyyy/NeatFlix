import { Agent, AnthropicAdapter } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { AGENT_MAX_TOKENS, AGENT_MAX_TOOL_ROUNDS, AGENT_MODEL } from "@/agents/config/model";
import type { BandUrls, RoleCredentials } from "@/agents/config/env";
import type { AgentRole } from "@/agents/config/roles";
import { HandoffGate } from "./handoff-gate";
import { buildSystemPrompt } from "./prompts";

export type NativeFrameAgent = { role: AgentRole; agent: Agent };

/**
 * Builds one BAND agent per role: its own credentials, its own Claude adapter
 * and system prompt, and a handoff gate in front of the adapter.
 */
export function createNativeFrameAgents(options: {
  credentials: RoleCredentials[];
  urls: BandUrls;
  anthropicApiKey: string;
  loggerFor: (role: AgentRole) => Logger;
}): NativeFrameAgent[] {
  const roleByAgentId = new Map(options.credentials.map((c) => [c.agentId, c.role] as const));

  return options.credentials.map(({ role, agentId, apiKey }) => {
    const logger = options.loggerFor(role);
    const adapter = new AnthropicAdapter({
      anthropicModel: AGENT_MODEL,
      apiKey: options.anthropicApiKey,
      maxTokens: AGENT_MAX_TOKENS,
      maxToolRounds: AGENT_MAX_TOOL_ROUNDS,
      systemPrompt: buildSystemPrompt(role),
      logger,
    });
    const agent = Agent.create({
      adapter,
      config: { agentId, apiKey, ...options.urls },
      preprocessor: new HandoffGate(role, roleByAgentId, logger),
      logger,
    });
    return { role, agent };
  });
}
