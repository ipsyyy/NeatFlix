import type { HandoffEnvelope, ValidationResult } from "./envelope";
import type { PreviewRegistry } from "./governor-review";
import { validateResult } from "./output-rules";
import { HANDOFF_FENCE, formatHandoffBlock, validateOutgoing } from "./protocol";
import { runtimeTimestamp } from "./timestamps";

const BLOCK = new RegExp("```" + HANDOFF_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");

export type StampResult =
  | { ok: true; content: string; handoffs: number; timestamp: string | null }
  | { ok: false; errors: string[] };

/**
 * Prepares an outgoing BAND message at the send boundary. Every handoff block
 * gets the runtime timestamp (replacing anything the model wrote) and must then
 * pass full validation and the role's output rules (output-rules.ts), or nothing
 * is sent. Text outside the blocks is untouched.
 *
 * Call this immediately before the BAND POST: `now` is the trusted send time.
 */
export function stampOutgoingContent(content: string, now: Date = new Date(), options: { previews?: PreviewRegistry } = {}): StampResult {
  const timestamp = runtimeTimestamp(now);
  const errors: string[] = [];
  const readable = content.replace(BLOCK, "").trim();
  let handoffs = 0;

  const stamped = content.replace(BLOCK, (block, json: string) => {
    handoffs++;
    let draft: unknown;
    try {
      draft = JSON.parse(json);
    } catch {
      errors.push("Handoff block is not valid JSON.");
      return block;
    }
    if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
      errors.push("Handoff must be a JSON object.");
      return block;
    }
    // Any model-written timestamp is discarded; the runtime's value always wins.
    const envelope: Record<string, unknown> = { ...(draft as Record<string, unknown>) };
    delete envelope.timestamp;
    envelope.timestamp = timestamp;
    const result = checkEnvelope(envelope, readable, options.previews);
    if (!result.ok) {
      errors.push(...result.errors);
      return block;
    }
    return formatHandoffBlock(result.value);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, content: stamped, handoffs, timestamp: handoffs > 0 ? timestamp : null };
}

/**
 * Validates a model-drafted envelope the way the send boundary will: any
 * timestamp in the draft is ignored and replaced by the runtime.
 */
export function validateDraft(draft: unknown, now: Date = new Date(), readable?: string, previews?: PreviewRegistry) {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    return validateOutgoing(draft);
  }
  const envelope: Record<string, unknown> = { ...(draft as Record<string, unknown>) };
  delete envelope.timestamp;
  envelope.timestamp = runtimeTimestamp(now);
  return checkEnvelope(envelope, readable, previews);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEvidenceList = (v: unknown) =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.claim === "string" && typeof x.source === "string");

/**
 * Full validation plus the role's output rules, reporting every problem in one
 * pass. A Placement Director redraft costs about a minute, so problems must not
 * surface one stage at a time.
 */
function checkEnvelope(envelope: Record<string, unknown>, readable?: string, previews?: PreviewRegistry): ValidationResult<HandoffEnvelope> {
  const result = validateOutgoing(envelope, { previews });
  const errors = result.ok ? validateResult(result.value, readable) : [...result.errors, ...ruleErrorsForInvalid(envelope, readable)];
  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : result;
}

/** Output rules for an envelope that failed validation, run when the fields they read are well formed. */
function ruleErrorsForInvalid(envelope: Record<string, unknown>, readable?: string): string[] {
  const { senderRole, evidence, assumptions, nextAction, artifact } = envelope;
  if (typeof senderRole !== "string" || !isEvidenceList(evidence)) return [];
  if (!Array.isArray(assumptions) || !assumptions.every((a) => typeof a === "string")) return [];
  return validateResult(
    {
      ...envelope,
      nextAction: typeof nextAction === "string" ? nextAction : "",
      artifact: isObj(artifact) && isEvidenceList(artifact.evidence) ? artifact : undefined,
    } as unknown as HandoffEnvelope,
    readable,
  );
}
