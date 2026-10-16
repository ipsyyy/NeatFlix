import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope, ValidationRegistries } from "./envelope";
import { NO_PREVIEW_DISCLOSURE, visualClaims } from "./governor-review";
import { generationClaims, misleadingFrameTerms, STAND_IN_DISCLOSURE } from "./placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "./source-frames";

/**
 * Role-specific rules every posted result must meet, enforced at the send
 * boundary in code (not only by prompt).
 */

/** Exact sentence a Campaign Matcher result must contain while Placement Director has not acted. */
export const PLACEMENT_DIRECTOR_DISCLOSURE = "Placement Director has not consumed this handoff yet.";

/** Exact sentence a Placement Director result must contain while Release Governor has not acted. */
export const RELEASE_GOVERNOR_DISCLOSURE = "Release Governor has not consumed this handoff yet.";

/** Disclosure sentences required in the readable text of a handoff, by sender and recipient. */
export function requiredDisclosures(envelope: Pick<HandoffEnvelope, "senderRole" | "recipientRole" | "artifact">): string[] {
  const out: string[] = [];
  if (envelope.recipientRole === "placement-director" && (envelope.senderRole === "campaign-matcher" || envelope.senderRole === "release-governor")) {
    out.push(PLACEMENT_DIRECTOR_DISCLOSURE);
  }
  if (envelope.senderRole === "placement-director" && envelope.recipientRole === "release-governor") out.push(RELEASE_GOVERNOR_DISCLOSURE);
  if (envelope.artifact?.kind === "governor-review" && envelope.artifact.preview?.status === "missing") out.push(NO_PREVIEW_DISCLOSURE);
  return out;
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
    "nativeframe_get_source_frame",
  ],
  "release-governor": ["handoff", "nativeframe_check_placement_plan", "nativeframe_get_preview_status"],
};

/** References to evidence outside the authenticated handoff and tool results. */
const ROOM_HISTORY_REFERENCE =
  /\b(content curator|room history|chat history|conversation history|earlier (message|handoff|post)|previous (message|handoff|run|post)|prior (message|handoff|run))\b/i;

/**
 * Checks a result before it is posted. `readable` is the message text outside
 * the handoff block; omit it to check only the envelope (e.g. a draft).
 * Returns problems to fix, or an empty list.
 */
export function validateResult(envelope: HandoffEnvelope, readable?: string, registries: Pick<ValidationRegistries, "disclosures"> = {}): string[] {
  const errors: string[] = [];
  const approved = APPROVED_EVIDENCE_SOURCES[envelope.senderRole];

  if (approved) {
    const cited = [
      ...envelope.evidence.map((item, i) => ({ item, at: `evidence[${i}]` })),
      ...(envelope.artifact?.evidence ?? []).map((item, i) => ({ item, at: `artifact.evidence[${i}]` })),
      ...(envelope.artifact?.kind === "governor-review" ? envelope.artifact.checks : []).map((c, i) => ({
        item: { claim: c.detail, source: c.source },
        at: `artifact.checks[${i}]`,
      })),
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

  if (envelope.senderRole === "release-governor") {
    const text = [readable ?? "", envelope.nextAction, ...envelope.assumptions, ...envelope.blockers, ...envelope.evidence.map((x) => x.claim)].join("\n");
    for (const s of visualClaims(text)) errors.push(`No preview has been inspected or approved; remove the claim: "${s.slice(0, 120)}"`);
    // A "provided" preview has already been confirmed against the preview registry by envelope validation.
    const previewRecorded = envelope.artifact?.kind === "governor-review" && envelope.artifact.preview.status === "provided";
    if (!previewRecorded) {
      for (const s of generationClaims(text)) errors.push(`No generation has run; remove the claim: "${s.slice(0, 120)}"`);
    }
    for (const term of misleadingFrameTerms(text)) {
      errors.push(`Do not call the stand-in a "${term}"; it is approved title artwork, not footage.`);
    }
  }

  if (envelope.senderRole === "placement-director") {
    // A plan bound to a registered source frame states that; a stand-in plan states the stand-in. When the
    // frame has derived media, its provenance-derived disclosure replaces the historical frame sentence.
    const plan = envelope.artifact?.kind === "placement-plan" ? envelope.artifact : null;
    const usesFrame = plan?.sourceMedia.kind === "registered-source-frame";
    const state = plan && usesFrame ? (registries.disclosures?.find(plan.planId) ?? null) : null;
    if (state?.status === "invalid") errors.push("The plan's derived media provenance does not validate, so no visual disclosure can be made.");
    const derived = state?.status === "derived" ? state.disclosure : null;
    const disclosure = derived ?? (usesFrame ? SOURCE_FRAME_DISCLOSURE : STAND_IN_DISCLOSURE);
    if (readable !== undefined && envelope.artifact && !readable.includes(disclosure)) {
      errors.push(`The readable result must contain exactly: "${disclosure}"`);
    }
    if (derived && readable?.includes(SOURCE_FRAME_DISCLOSURE)) errors.push("The frame has derived media; do not state that no edit or generation has been run on it.");
    // Only the exact, provenance-derived disclosure may describe generation that happened.
    const raw = [readable ?? "", envelope.nextAction, ...envelope.assumptions, ...envelope.evidence.map((x) => x.claim)].join("\n");
    const text = derived ? raw.split(derived).join("\n") : raw;
    for (const s of generationClaims(text)) errors.push(`No generation has run; remove the claim: "${s.slice(0, 120)}"`);
    if (readable !== undefined && envelope.artifact && !/\bnot (yet )?(been )?executed\b/i.test(readable)) {
      errors.push("The readable result must state that the generation prompts have not been executed.");
    }
    if (!usesFrame) {
      for (const term of misleadingFrameTerms(text)) {
        errors.push(`Do not call the stand-in a "${term}"; it is approved title artwork, not footage.`);
      }
    }
  }
  return errors;
}
