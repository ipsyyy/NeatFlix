import { Agent } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { AGENT_MAX_TOKENS, AGENT_MAX_TOOL_ROUNDS, AGENT_MODEL, AGENT_TURN_TIMEOUT_MS } from "@/agents/config/model";
import type { BandUrls, RoleCredentials } from "@/agents/config/env";
import type { AgentRole } from "@/agents/config/roles";
import { bandClientFor } from "@/agents/band/case-room";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { instrumentedClaudeFactory, type ClaudeCallListener } from "./claude-client";
import { HandoffGate } from "./handoff-gate";
import { buildSystemPrompt } from "./prompts";
import { StampingAnthropicAdapter } from "./stamping-adapter";

export type NativeFrameAgent = { role: AgentRole; agent: Agent };

/** Closes a rejected message for this agent: BAND requires /processing before /processed. */
function closeRejectedVia(client: ReturnType<typeof bandClientFor>) {
  return async (roomId: string, messageId: string) => {
    await client.agentApiMessages.markAgentMessageProcessing(roomId, messageId);
    await client.agentApiMessages.markAgentMessageProcessed(roomId, messageId);
  };
}

/**
 * Builds one BAND agent per requested role: its own credentials, Claude
 * adapter (with runtime-owned handoff timestamps), system prompt, read-only
 * evidence tools, and a handoff gate in front of the adapter. `credentials` is
 * always the full five-role set so the gate can authenticate senders; `roles`
 * limits which agents are created.
 */
export function createNativeFrameAgents(options: {
  credentials: RoleCredentials[];
  roles?: readonly AgentRole[];
  urls: BandUrls;
  anthropicApiKey: string;
  loggerFor: (role: AgentRole) => Logger;
  onClaudeCall?: ClaudeCallListener;
}): NativeFrameAgent[] {
  const roleByAgentId = new Map(options.credentials.map((c) => [c.agentId, c.role] as const));
  const wanted = options.roles ?? options.credentials.map((c) => c.role);

  return options.credentials
    .filter((c) => wanted.includes(c.role))
    .map(({ role, agentId, apiKey }) => {
      const logger = options.loggerFor(role);
      const adapter = new StampingAnthropicAdapter({
        anthropicModel: AGENT_MODEL,
        apiKey: options.anthropicApiKey,
        maxTokens: AGENT_MAX_TOKENS,
        maxToolRounds: AGENT_MAX_TOOL_ROUNDS,
        turnTimeoutMs: AGENT_TURN_TIMEOUT_MS,
        systemPrompt: buildSystemPrompt(role),
        // Audit which evidence tools the model used (tool name only, never arguments or results).
        customTools: toolsForRole(role).map((tool) => ({
          ...tool,
          handler: (args: Record<string, unknown>) => {
            logger.info("Evidence tool called", { tool: tool.name });
            return tool.handler(args);
          },
        })),
        logger,
        mentionPolicy: { role, roleByAgentId },
        ...(options.onClaudeCall ? { clientFactory: instrumentedClaudeFactory(role, options.onClaudeCall) } : {}),
      });
      const agent = Agent.create({
        adapter,
        config: { agentId, apiKey, ...options.urls },
        preprocessor: new HandoffGate(role, roleByAgentId, logger, closeRejectedVia(bandClientFor({ role, agentId, apiKey }, options.urls))),
        // The SDK default (false) joins only rooms added while the agent is
        // running. Case rooms outlive agent restarts, so rejoin them on start;
        // BAND then delivers their pending messages through the handoff gate.
        agentConfig: { autoSubscribeExistingRooms: true },
        logger,
      });
      return { role, agent };
    });
}
