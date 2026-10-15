import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "./envelope";

/** A room participant as BAND reports it. */
export type RoomMember = { id: string; type: string; handle?: string | null; name?: string | null };

/** A mention as passed to band_send_message: a handle string or a reference. */
export type MentionArg = string | { id?: string; handle?: string | null; name?: string | null };

const normalize = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/** Agent-style handles written inline in text, e.g. "@owner/agent-name". */
const INLINE_AGENT_HANDLE = /@([a-z0-9._-]+\/[a-z0-9._-]+)/gi;

/** A mention resolved to exactly one room member, or why it cannot be. */
type Resolution = { member: RoomMember } | { member: null; conflict: boolean };

const byHandle = (key: string, members: RoomMember[]) => members.filter((m) => m.handle && normalize(m.handle) === normalize(key));
const byName = (key: string, members: RoomMember[]) => members.filter((m) => m.name && normalize(m.name) === normalize(key));

/**
 * Resolves a mention to one room member. Every identity it carries must name
 * the same member: an object whose id, handle, and name point at different
 * members (or at anyone outside the room) is rejected, never resolved by one
 * field while BAND might route by another.
 */
function resolve(mention: unknown, members: RoomMember[]): Resolution {
  const candidates: RoomMember[][] = [];
  if (typeof mention === "string") {
    candidates.push([...byHandle(mention, members), ...byName(mention, members)]);
  } else if (typeof mention === "object" && mention !== null && !Array.isArray(mention)) {
    const { id, handle, name } = mention as Record<string, unknown>;
    if (id != null) candidates.push(typeof id === "string" ? members.filter((m) => m.id === id) : []);
    if (handle != null) candidates.push(typeof handle === "string" ? byHandle(handle, members) : []);
    if (name != null) candidates.push(typeof name === "string" ? byName(name, members) : []);
  }
  if (candidates.length === 0 || candidates.some((c) => c.length === 0)) return { member: null, conflict: false };
  const ids = new Set(candidates.flat().map((m) => m.id));
  if (ids.size !== 1) return { member: null, conflict: true };
  return { member: candidates[0][0] };
}

/**
 * The mention list to send to BAND, rebuilt from the room roster: one
 * reference per resolved member, never the model's own fields. Call only after
 * checkMentions has passed, so every mention resolves.
 */
export function canonicalMentions(mentions: unknown[], members: RoomMember[]): { id: string; handle?: string; name?: string }[] {
  const seen = new Set<string>();
  const out: { id: string; handle?: string; name?: string }[] = [];
  for (const mention of mentions) {
    const { member } = resolve(mention, members);
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    out.push({ id: member.id, ...(member.handle ? { handle: member.handle } : {}), ...(member.name ? { name: member.name } : {}) });
  }
  return out;
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
  /** When set, the downstream agent may not be mentioned either: it is present but must not receive work. */
  humanOnly?: boolean;
}): string[] {
  const { sender, envelope, members, roleByAgentId } = options;
  const errors: string[] = [];
  let allowed = 0;

  const judge = (resolution: Resolution, label: string) => {
    const { member } = resolution;
    if (!member) {
      errors.push(
        "conflict" in resolution && resolution.conflict
          ? `Mention ${label} names more than one participant; use one participant's exact handle.`
          : `Mention ${label} is not a participant in this room; address the human instead.`,
      );
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
    else if (options.humanOnly) errors.push(`Mention only the human User; ${role} must not receive this handoff yet.`);
    else allowed++;
  };

  for (const mention of options.mentions as unknown[]) {
    const ref = typeof mention === "object" && mention !== null ? (mention as Record<string, unknown>) : {};
    const label = typeof mention === "string" ? mention : ref.handle ?? ref.id ?? ref.name ?? "(unknown)";
    judge(resolve(mention, members), String(label).slice(0, 80));
  }
  for (const match of options.readable.matchAll(INLINE_AGENT_HANDLE)) {
    const resolution = resolve(match[1], members);
    if (resolution.member?.type !== "User") judge(resolution, `@${match[1].slice(0, 80)}`);
  }
  if (allowed === 0) errors.push(options.humanOnly ? "Mention the human User." : "Mention the human User, or the downstream agent if it is in the room.");
  return [...new Set(errors)];
}
