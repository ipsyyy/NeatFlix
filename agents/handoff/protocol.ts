import { HUMAN_REVIEWER, type AgentRole, type HandoffParty } from "@/agents/config/roles";
import { validateHandoff, type HandoffDecision, type HandoffEnvelope, type ValidationResult } from "./envelope";
import type { PreviewRegistry } from "./governor-review";

/**
 * Allowed handoffs: sender + decision → the only valid recipient
 * (PRODUCT_SOURCE_OF_TRUTH.md §5). Advancing decisions go to the next specialist;
 * rejections go to the human reviewer; the Release Governor's "revise" returns
 * work to the Placement Director for the one correction loop.
 */
export const ROUTES: Readonly<Record<AgentRole, Partial<Record<HandoffDecision, HandoffParty>>>> = {
  "content-curator": { approve: "scene-scout", reject: HUMAN_REVIEWER },
  "scene-scout": { select: "campaign-matcher", reject: HUMAN_REVIEWER },
  "campaign-matcher": { recommend: "placement-director", reject: HUMAN_REVIEWER },
  "placement-director": { "instructions-ready": "release-governor", blocked: HUMAN_REVIEWER },
  "release-governor": {
    "approve-for-human-review": HUMAN_REVIEWER,
    revise: "placement-director",
    stop: HUMAN_REVIEWER,
  },
};

export function expectedRecipient(sender: AgentRole, decision: HandoffDecision): HandoffParty | null {
  return ROUTES[sender][decision] ?? null;
}

/** Full check for an envelope about to be sent: structure plus role order. */
export function validateOutgoing(input: unknown, options: { previews?: PreviewRegistry } = {}): ValidationResult<HandoffEnvelope> {
  const result = validateHandoff(input, options);
  if (!result.ok) return result;
  const { senderRole, decision, recipientRole } = result.value;
  const expected = expectedRecipient(senderRole, decision);
  if (expected !== recipientRole) {
    return {
      ok: false,
      errors: [`${senderRole} "${decision}" must go to ${expected ?? "nobody"}, not ${recipientRole}.`],
    };
  }
  return result;
}

/**
 * The only inputs each role may consume. Content Curator starts a case from a
 * plain-text request by a BAND `User`; every other role accepts only structured
 * handoffs from its upstream role. The Placement Director also accepts the
 * Release Governor's "revise" handoff for the §5 correction loop.
 */
export const ACCEPTED_INPUTS: Readonly<
  Record<AgentRole, { humanRequest: boolean; handoffs: readonly { from: AgentRole; decision: HandoffDecision }[] }>
> = {
  "content-curator": { humanRequest: true, handoffs: [] },
  "scene-scout": { humanRequest: false, handoffs: [{ from: "content-curator", decision: "approve" }] },
  "campaign-matcher": { humanRequest: false, handoffs: [{ from: "scene-scout", decision: "select" }] },
  "placement-director": {
    humanRequest: false,
    handoffs: [
      { from: "campaign-matcher", decision: "recommend" },
      { from: "release-governor", decision: "revise" },
    ],
  },
  "release-governor": { humanRequest: false, handoffs: [{ from: "placement-director", decision: "instructions-ready" }] },
};

/**
 * Whether `consumer` may act on this handoff. It must be valid, addressed to the
 * consumer, an accepted upstream input for the consumer, and come from the BAND
 * identity registered for its claimed sender role (no spoofed roles).
 */
export function canConsume(
  consumer: AgentRole,
  input: unknown,
  actualSenderRole: AgentRole | null,
): ValidationResult<HandoffEnvelope> {
  const result = validateOutgoing(input);
  if (!result.ok) return result;
  const env = result.value;
  if (env.recipientRole !== consumer) {
    return { ok: false, errors: [`Handoff is addressed to ${env.recipientRole}, not ${consumer}.`] };
  }
  if (actualSenderRole !== env.senderRole) {
    return {
      ok: false,
      errors: [`Handoff claims to come from ${env.senderRole} but was sent by ${actualSenderRole ?? "a non-NativeFrame participant"}.`],
    };
  }
  const accepted = ACCEPTED_INPUTS[consumer].handoffs.some(
    (a) => a.from === env.senderRole && a.decision === env.decision,
  );
  if (!accepted) {
    return { ok: false, errors: [`${consumer} does not accept "${env.decision}" handoffs from ${env.senderRole}.`] };
  }
  return result;
}

/** Fenced block that carries an envelope inside a BAND chat message. */
export const HANDOFF_FENCE = "nativeframe-handoff";

const BLOCK = new RegExp("```" + HANDOFF_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");

export type ExtractedHandoff = { ok: true; value: unknown } | { ok: false; error: string };

/** Pulls every handoff block out of a message body. Malformed JSON is reported, not thrown. */
export function extractHandoffs(content: string): ExtractedHandoff[] {
  const found: ExtractedHandoff[] = [];
  for (const match of content.matchAll(BLOCK)) {
    try {
      found.push({ ok: true, value: JSON.parse(match[1]) });
    } catch {
      found.push({ ok: false, error: "Handoff block is not valid JSON." });
    }
  }
  return found;
}

export function formatHandoffBlock(envelope: HandoffEnvelope): string {
  return "```" + HANDOFF_FENCE + "\n" + JSON.stringify(envelope, null, 2) + "\n```";
}
