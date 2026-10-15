import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "./envelope";

/**
 * Role-specific rules every posted result must meet, enforced at the send
 * boundary in code (not only by prompt).
 */

/** Exact sentence a Campaign Matcher result must contain while Placement Director has not acted. */
export const PLACEMENT_DIRECTOR_DISCLOSURE = "Placement Director has not consumed this handoff yet.";

/**
 * Evidence a role may cite. A source must start with one of these: the
 * authenticated upstream structured handoff ("handoff") or a named tool result.
 */
export const APPROVED_EVIDENCE_SOURCES: Partial<Record<AgentRole, readonly string[]>> = {
  "campaign-matcher": [
    "handoff",
    "nativeframe_get_selected_scene",
    "nativeframe_get_campaign",
    "nativeframe_evaluate_campaign_match",
  ],
};

/** References to evidence outside the authenticated handoff and tool results. */
const ROOM_HISTORY_REFERENCE =
  /\b(content curator|room history|chat history|conversation history|earlier (message|handoff|post)|previous (message|handoff|run|post)|prior (message|handoff|run))\b/i;

/**
 * Checks a result before it is posted. `readable` is the message text outside
 * the handoff block; omit it to check only the envelope (e.g. a draft).
 * Returns problems to fix, or an empty list.
 */
export function validateResult(envelope: HandoffEnvelope, readable?: string): string[] {
  const errors: string[] = [];
  const approved = APPROVED_EVIDENCE_SOURCES[envelope.senderRole];

  if (approved) {
    envelope.evidence.forEach((item, i) => {
      const source = item.source.trim().toLowerCase();
      if (!approved.some((prefix) => source.startsWith(prefix.toLowerCase()))) {
        errors.push(`evidence[${i}].source must cite the structured handoff or one of: ${approved.filter((p) => p !== "handoff").join(", ")}.`);
      }
      if (ROOM_HISTORY_REFERENCE.test(item.claim) || ROOM_HISTORY_REFERENCE.test(item.source)) {
        errors.push(`evidence[${i}] relies on room history or another agent's message; use only the handoff and tool results.`);
      }
    });
    envelope.assumptions.forEach((a, i) => {
      if (ROOM_HISTORY_REFERENCE.test(a)) errors.push(`assumptions[${i}] relies on room history or another agent's message.`);
    });
    if (readable !== undefined && ROOM_HISTORY_REFERENCE.test(readable)) {
      errors.push("The readable result relies on room history or another agent's message.");
    }
  }

  if (envelope.senderRole === "campaign-matcher" && envelope.recipientRole === "placement-director" && readable !== undefined) {
    if (!readable.includes(PLACEMENT_DIRECTOR_DISCLOSURE)) {
      errors.push(`The readable result must contain exactly: "${PLACEMENT_DIRECTOR_DISCLOSURE}"`);
    }
  }
  return errors;
}
