import type { HandoffEnvelope, ValidationRegistries } from "@/agents/handoff/envelope";
import { requiredDisclosures } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { HANDOFF_FENCE, extractHandoffs } from "@/agents/handoff/protocol";
import { validateDraft } from "@/agents/handoff/stamp";

export type RedeliveryDraft =
  | { ok: true; draftContent: string; envelope: Omit<HandoffEnvelope, "timestamp"> }
  | { ok: false; errors: string[] };

/**
 * Prepares a re-delivery of an existing, already-validated handoff without
 * asking Claude to regenerate it. Every envelope field is kept except the
 * timestamp, which is removed here: the draft is unstamped, and only
 * postWithTrustedTimestamp may stamp it, immediately before the BAND POST.
 * The visible text discloses that this is a re-delivery and of which message.
 */
export function buildRedelivery(options: {
  originalContent: string;
  originalMessageId: string;
  expect: { senderRole: HandoffEnvelope["senderRole"]; recipientRole: HandoffEnvelope["recipientRole"]; decision: HandoffEnvelope["decision"] };
  recipientMention: string;
  /** Registries the original handoff is revalidated against (for example, registered source frames). */
  registries?: ValidationRegistries;
}): RedeliveryDraft {
  const blocks = extractHandoffs(options.originalContent);
  if (blocks.length !== 1) return { ok: false, errors: ["Original message must contain exactly one handoff."] };
  const [block] = blocks;
  if (!block.ok) return { ok: false, errors: [block.error] };

  // The original timestamp is stale by design; validate everything else.
  const checked = validateDraft(block.value, new Date(), undefined, options.registries?.previews, options.registries?.frames);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const { timestamp: _discarded, ...envelope } = checked.value;
  void _discarded;
  const { expect } = options;
  if (envelope.senderRole !== expect.senderRole || envelope.recipientRole !== expect.recipientRole || envelope.decision !== expect.decision) {
    return {
      ok: false,
      errors: [`Original handoff is ${envelope.senderRole} "${envelope.decision}" → ${envelope.recipientRole}, not the expected handoff.`],
    };
  }

  // A placement plan's result must keep its source-media and unexecuted-prompt statements (output-rules.ts).
  const artifact = envelope.artifact;
  const planStatements =
    artifact?.kind === "placement-plan"
      ? ["Both generation prompts have not been executed.", artifact.sourceMedia.kind === "registered-source-frame" ? SOURCE_FRAME_DISCLOSURE : STAND_IN_DISCLOSURE]
      : [];
  const disclosure =
    `${options.recipientMention} Re-delivery of the ${envelope.senderRole} handoff from message ${options.originalMessageId}, ` +
    `unchanged except for a fresh runtime timestamp. Case ${envelope.caseId}, ${envelope.artifactId}, decision ${envelope.decision}.` +
    [...planStatements, ...requiredDisclosures(envelope)].map((sentence) => ` ${sentence}`).join("");
  const block_ = "```" + HANDOFF_FENCE + "\n" + JSON.stringify(envelope, null, 2) + "\n```";
  return { ok: true, draftContent: `${disclosure}\n\n${block_}`, envelope };
}
