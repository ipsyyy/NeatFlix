import type { Logger } from "@band-ai/sdk/core";
import { DefaultPreprocessor } from "@band-ai/sdk/runtime";
import type { AgentRole } from "@/agents/config/roles";
import { canConsume, extractHandoffs } from "@/agents/handoff/protocol";

type DefaultProcess = DefaultPreprocessor["process"];

export type ScreenResult = { consume: true } | { consume: false; reasons: string[] };

/**
 * Decides whether `consumer` may see a message.
 * - Messages from other NativeFrame agents must carry valid handoffs addressed
 *   to the consumer, on an allowed route, from the sender's real identity.
 * - Messages from humans pass through; role prompts still forbid acting
 *   without the required upstream handoff.
 * - Any handoff block that fails validation blocks the whole message.
 */
export function screenIncomingMessage(
  consumer: AgentRole,
  content: string,
  actualSenderRole: AgentRole | null,
): ScreenResult {
  const blocks = extractHandoffs(content);
  if (blocks.length === 0) {
    return actualSenderRole === null
      ? { consume: true }
      : { consume: false, reasons: [`Message from ${actualSenderRole} has no handoff envelope.`] };
  }
  const reasons: string[] = [];
  for (const block of blocks) {
    if (!block.ok) {
      reasons.push(block.error);
      continue;
    }
    const result = canConsume(consumer, block.value, actualSenderRole);
    if (!result.ok) reasons.push(...result.errors);
  }
  return reasons.length > 0 ? { consume: false, reasons } : { consume: true };
}

/**
 * BAND preprocessor that runs the SDK's default processing, then screens the
 * resulting message before the adapter (and Claude) can consume it.
 */
export class HandoffGate {
  private readonly inner = new DefaultPreprocessor();

  constructor(
    private readonly consumer: AgentRole,
    private readonly roleByAgentId: ReadonlyMap<string, AgentRole>,
    private readonly logger: Logger,
  ) {}

  process: DefaultProcess = async (context, event, agentId) => {
    const input = await this.inner.process(context, event, agentId);
    if (!input) return input;
    const { message } = input;
    const senderRole = this.roleByAgentId.get(message.senderId) ?? null;
    const screen = screenIncomingMessage(this.consumer, message.content, senderRole);
    if (!screen.consume) {
      this.logger.warn("Discarded message that failed handoff validation", {
        room: message.roomId,
        message: message.id,
        from: senderRole ?? message.senderType,
        reasons: screen.reasons,
      });
      return null;
    }
    return input;
  };
}
