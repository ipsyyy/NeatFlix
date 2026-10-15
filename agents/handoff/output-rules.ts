import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "./envelope";
import { generationClaims, misleadingFrameTerms, STAND_IN_DISCLOSURE } from "./placement-plan";

/**
 * Role-specific rules every posted result must meet, enforced at the send
 * boundary in code (not only by prompt).
 */

/** Exact sentence a Campaign Matcher result must contain while Placement Director has not acted. */
export const PLACEMENT_DIRECTOR_DISCLOSURE = "Placement Director has not consumed this handoff yet.";

/** Exact sentence a Placement Director result must contain while Release Governor has not acted. */
export const RELEASE_GOVERNOR_DISCLOSURE = "Release Governor has not consumed this handoff yet.";

/** Disclosure sentences required in the readable text of a handoff, by sender and recipient. */
export function requiredDisclosures(envelope: Pick<HandoffEnvelope, "senderRole" | "recipientRole">): string[] {
  if (envelope.senderRole === "campaign-matcher" && envelope.recipientRole === "placement-director") return [PLACEMENT_DIRECTOR_DISCLOSURE];
  if (envelope.senderRole === "placement-director" && envelope.recipientRole === "release-governor") return [RELEASE_GOVERNOR_DISCLOSURE];
  return [];
}

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
  "placement-director": [
    "handoff",
    "nativeframe_get_selected_scene",
    "nativeframe_get_campaign",
    "nativeframe_get_source_artwork",
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
    const cited = [
      ...envelope.evidence.map((item, i) => ({ item, at: `evidence[${i}]` })),
      ...(envelope.artifact?.evidence ?? []).map((item, i) => ({ item, at: `artifact.evidence[${i}]` })),
    ];
    cited.forEach(({ item, at }) => {
      const source = item.source.trim().toLowerCase();
      if (!approved.some((prefix) => source.startsWith(prefix.toLowerCase()))) {
        errors.push(`${at}.source must cite the structured handoff or one of: ${approved.filter((p) => p !== "handoff").join(", ")}.`);
      }
      if (ROOM_HISTORY_REFERENCE.test(item.claim) || ROOM_HISTORY_REFERENCE.test(item.source)) {
        errors.push(`${at} relies on room history or another agent's message; use only the handoff and tool results.`);
      }
    });
    envelope.assumptions.forEach((a, i) => {
      if (ROOM_HISTORY_REFERENCE.test(a)) errors.push(`assumptions[${i}] relies on room history or another agent's message.`);
    });
    if (readable !== undefined && ROOM_HISTORY_REFERENCE.test(readable)) {
      errors.push("The readable result relies on room history or another agent's message.");
    }
  }

  if (readable !== undefined) {
    for (const sentence of requiredDisclosures(envelope)) {
      if (!readable.includes(sentence)) errors.push(`The readable result must contain exactly: "${sentence}"`);
    }
  }

  if (envelope.senderRole === "placement-director") {
    const text = [readable ?? "", envelope.nextAction, ...envelope.assumptions, ...envelope.evidence.map((x) => x.claim)].join("\n");
    for (const s of generationClaims(text)) errors.push(`No generation has run; remove the claim: "${s.slice(0, 120)}"`);
    if (readable !== undefined && envelope.artifact && !/\bnot (yet )?(been )?executed\b/i.test(readable)) {
      errors.push("The readable result must state that the generation prompts have not been executed.");
    }
    if (readable !== undefined && envelope.artifact && !readable.includes(STAND_IN_DISCLOSURE)) {
      errors.push(`The readable result must contain exactly: "${STAND_IN_DISCLOSURE}"`);
    }
    for (const term of misleadingFrameTerms(text)) {
      errors.push(`Do not call the stand-in a "${term}"; it is approved title artwork, not footage.`);
    }
  }
  return errors;
}
