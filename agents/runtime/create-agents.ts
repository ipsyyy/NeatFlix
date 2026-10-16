import { Agent } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { AGENT_MAX_TOKENS, AGENT_MODEL, turnLimitsFor } from "@/agents/config/model";
import type { BandUrls, RoleCredentials } from "@/agents/config/env";
import type { AgentRole } from "@/agents/config/roles";
import { bandClientFor } from "@/agents/band/case-room";
import { NO_GENERATED_PREVIEWS } from "@/agents/handoff/governor-review";
import type { PreviewEvidenceSource } from "@/agents/media/preview-evidence";
import { PersistentSourceFrameRegistry } from "@/agents/persistence/source-frames";
import { PersistentPreviewRegistry, type WorkflowRegistry } from "@/agents/persistence/workflow";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { AcceptedPlanRegistry, inMemoryAcceptedPlans } from "./accepted-plans";
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
  /**
   * Controlled verification only: agents may mention only the human, so a
   * downstream agent that is in the room but not running receives no work.
   */
  mentionHumanOnly?: boolean;
  /**
   * Persistent workflow registry (server-only). When set, the Release Governor
   * persists accepted plans and its reviews, and validates approvals against
   * revalidated persisted previews. Without it, nothing is persisted and the
   * preview registry is NO_GENERATED_PREVIEWS.
   */
  workflow?: WorkflowRegistry;
  /**
   * Verified preview evidence for the Release Governor's preview technical
   * check (server-only). Without it, a registered preview fails that check.
   */
  previewEvidence?: PreviewEvidenceSource;
  /**
   * Replaces how the Release Governor's posted review is persisted (requires
   * `workflow`), for a bounded run that saves only under its own guard.
   */
  persistGovernorReview?: (envelope: unknown) => Promise<{ ok: true } | { ok: false; errors: string[] }>;
}): NativeFrameAgent[] {
  const roleByAgentId = new Map(options.credentials.map((c) => [c.agentId, c.role] as const));
  const wanted = options.roles ?? options.credentials.map((c) => c.role);

  return options.credentials
    .filter((c) => wanted.includes(c.role))
    .map(({ role, agentId, apiKey }) => {
      const logger = options.loggerFor(role);
      const governor = role === "release-governor";
      const plans = governor && options.workflow ? new AcceptedPlanRegistry(options.workflow) : inMemoryAcceptedPlans;
      const previews = governor && options.workflow ? new PersistentPreviewRegistry(options.workflow) : NO_GENERATED_PREVIEWS;
      const workflow = options.workflow;
      // Placement Director binds, and Release Governor checks, registered source frames from storage.
      const frames = workflow && (governor || role === "placement-director") ? new PersistentSourceFrameRegistry(workflow) : undefined;
      const save = options.persistGovernorReview ?? ((envelope: unknown) => workflow!.saveGovernorReview(envelope));
      const persistReview =
        governor && workflow
          ? async (envelope: unknown) => {
              const saved = await save(envelope);
              if (!saved.ok) logger.warn("Governor review was not persisted", { problems: saved.errors.length });
              else logger.info("Governor review persisted", {});
            }
          : undefined;
      const adapter = new StampingAnthropicAdapter({
        anthropicModel: AGENT_MODEL,
        apiKey: options.anthropicApiKey,
        maxTokens: AGENT_MAX_TOKENS,
        ...turnLimitsFor(role),
        systemPrompt: buildSystemPrompt(role, { humanOnlyMentions: options.mentionHumanOnly === true }),
        // Audit which evidence tools the model used (tool name only, never arguments or results).
        customTools: toolsForRole(role, { plans, previews, frames, ...(governor && options.previewEvidence ? { previewEvidence: options.previewEvidence } : {}) }).map((tool) => ({
          ...tool,
          handler: (args: Record<string, unknown>) => {
            logger.info("Evidence tool called", { tool: tool.name });
            return tool.handler(args);
          },
        })),
        logger,
        mentionPolicy: { role, roleByAgentId, humanOnly: options.mentionHumanOnly === true },
        sendBoundary: { previews, frames, ...(persistReview ? { onPosted: persistReview } : {}) },
        ...(options.onClaudeCall ? { clientFactory: instrumentedClaudeFactory(role, options.onClaudeCall) } : {}),
      });
      const agent = Agent.create({
        adapter,
        config: { agentId, apiKey, ...options.urls },
        preprocessor: new HandoffGate(
          role,
          roleByAgentId,
          logger,
          closeRejectedVia(bandClientFor({ role, agentId, apiKey }, options.urls)),
          {
            ...(governor ? { plans, ...(previews instanceof PersistentPreviewRegistry ? { previews } : {}) } : {}),
            ...(frames ? { frames } : {}),
          },
        ),
        // The SDK default (false) joins only rooms added while the agent is
        // running. Case rooms outlive agent restarts, so rejoin them on start;
        // BAND then delivers their pending messages through the handoff gate.
        agentConfig: { autoSubscribeExistingRooms: true },
        logger,
      });
      return { role, agent };
    });
}
