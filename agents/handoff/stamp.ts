import type { HandoffEnvelope } from "./envelope";
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
export function stampOutgoingContent(content: string, now: Date = new Date()): StampResult {
  const timestamp = runtimeTimestamp(now);
  const errors: string[] = [];
  const envelopes: HandoffEnvelope[] = [];
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
    const result = validateOutgoing(envelope);
    if (!result.ok) {
      errors.push(...result.errors);
      return block;
    }
    envelopes.push(result.value);
    return formatHandoffBlock(result.value);
  });

  const readable = content.replace(BLOCK, "").trim();
  for (const envelope of envelopes) errors.push(...validateResult(envelope, readable));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, content: stamped, handoffs, timestamp: handoffs > 0 ? timestamp : null };
}

/**
 * Validates a model-drafted envelope the way the send boundary will: any
 * timestamp in the draft is ignored and replaced by the runtime.
 */
export function validateDraft(draft: unknown, now: Date = new Date()) {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    return validateOutgoing(draft);
  }
  const envelope: Record<string, unknown> = { ...(draft as Record<string, unknown>) };
  delete envelope.timestamp;
  envelope.timestamp = runtimeTimestamp(now);
  const result = validateOutgoing(envelope);
  if (!result.ok) return result;
  const errors = validateResult(result.value);
  return errors.length > 0 ? { ok: false as const, errors } : result;
}
