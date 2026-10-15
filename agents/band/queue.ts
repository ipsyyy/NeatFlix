import type { AgentRole } from "@/agents/config/roles";
import { screenIncomingMessage } from "@/agents/runtime/handoff-gate";

/** The BAND Agent API calls queue cleanup needs, for the agent whose queue it is. */
export type QueueClient = {
  agentApiContext: {
    getAgentChatContext(roomId: string, req: { page: number; page_size: number }): Promise<{
      data: { id: string; content: string; sender_id: string; sender_type: string; inserted_at?: string }[];
    }>;
  };
  agentApiMessages: {
    markAgentMessageProcessing(roomId: string, messageId: string): Promise<unknown>;
    markAgentMessageProcessed(roomId: string, messageId: string): Promise<unknown>;
  };
};

export type QueueCloseResult =
  | { closed: true; reasons: string[] }
  | { closed: false; reason: "not-found" | "acceptable-input" };

/**
 * Closes a message queued for `role` without passing it to Claude, but only if
 * that role's handoff gate would reject it (wrong recipient, upstream, self, or
 * plain text). A message the role would legitimately accept is never closed.
 * Content is screened in code only and is never logged or returned.
 */
export async function closeIfRejected(options: {
  client: QueueClient;
  roomId: string;
  messageId: string;
  role: AgentRole;
  roleByAgentId: ReadonlyMap<string, AgentRole>;
  now?: Date;
}): Promise<QueueCloseResult> {
  const { client, roomId, messageId, role } = options;
  const context = await client.agentApiContext.getAgentChatContext(roomId, { page: 1, page_size: 50 });
  const message = context.data.find((m) => m.id === messageId);
  if (!message) return { closed: false, reason: "not-found" };

  const screen = screenIncomingMessage(
    role,
    message.content,
    { role: options.roleByAgentId.get(message.sender_id) ?? null, type: message.sender_type },
    { now: options.now ?? new Date(), postedAt: message.inserted_at ? new Date(message.inserted_at) : null },
  );
  if (screen.consume) return { closed: false, reason: "acceptable-input" };

  await client.agentApiMessages.markAgentMessageProcessing(roomId, messageId);
  await client.agentApiMessages.markAgentMessageProcessed(roomId, messageId);
  return { closed: true, reasons: screen.reasons };
}
