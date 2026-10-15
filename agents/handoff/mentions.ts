import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "./envelope";

/** A room participant as BAND reports it. */
export type RoomMember = { id: string; type: string; handle?: string | null; name?: string | null };

/** A mention as passed to band_send_message: a handle string or a reference. */
export type MentionArg = string | { id?: string; handle?: string | null; name?: string | null };

const normalize = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/** Agent-style handles written inline in text, e.g. "@owner/agent-name". */
const INLINE_AGENT_HANDLE = /@([a-z0-9._-]+\/[a-z0-9._-]+)/gi;

function resolve(mention: MentionArg, members: RoomMember[]): RoomMember | null {
  if (typeof mention !== "string") {
    if (mention.id) return members.find((m) => m.id === mention.id) ?? null;
    if (mention.handle) return resolve(mention.handle, members);
    return null;
  }
  const key = normalize(mention);
  return members.find((m) => (m.handle && normalize(m.handle) === key) || (m.name && m.name.toLowerCase() === key)) ?? null;
}

/**
 * Who a workflow agent may mention when posting a handoff:
 * - the human BAND User, for visibility;
 * - its immediate downstream agent (the envelope's recipientRole), only when
 *   that agent is actually a participant in the room.
 * Never itself, an upstream or unrelated agent, an unregistered agent, or an
 * agent that is not in the room. Inline @agent handles in the text are checked
 * the same way. Returns problems to fix, or an empty list.
 */
export function checkMentions(options: {
  sender: AgentRole;
  envelope: Pick<HandoffEnvelope, "recipientRole">;
  mentions: MentionArg[];
  readable: string;
  members: RoomMember[];
  roleByAgentId: ReadonlyMap<string, AgentRole>;
}): string[] {
  const { sender, envelope, members, roleByAgentId } = options;
  const errors: string[] = [];
  let allowed = 0;

  const judge = (member: RoomMember | null, label: string) => {
    if (!member) {
      errors.push(`Mention ${label} is not a participant in this room; address the human instead.`);
      return;
    }
    if (member.type === "User") {
      allowed++;
      return;
    }
    const role = roleByAgentId.get(member.id);
    if (!role) errors.push(`Mention ${label} is not a NativeFrame agent.`);
    else if (role === sender) errors.push("An agent must not mention itself.");
    else if (role !== envelope.recipientRole) errors.push(`Mention ${label} is not this handoff's downstream recipient (${envelope.recipientRole}).`);
    else allowed++;
  };

  for (const mention of options.mentions) {
    const label = typeof mention === "string" ? mention : mention.handle ?? mention.id ?? "(unknown)";
    judge(resolve(mention, members), String(label).slice(0, 80));
  }
  for (const match of options.readable.matchAll(INLINE_AGENT_HANDLE)) {
    const member = resolve(match[1], members);
    if (!member || member.type !== "User") judge(member, `@${match[1].slice(0, 80)}`);
  }
  if (allowed === 0) errors.push("Mention the human User, or the downstream agent if it is in the room.");
  return [...new Set(errors)];
}
