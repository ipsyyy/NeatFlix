import { HUMAN_REVIEWER, isAgentRole, type AgentRole, type HandoffParty } from "@/agents/config/roles";

/**
 * Decisions each role may make. Advancing decisions move the case forward;
 * the rest stop it or send it back (PRODUCT_SOURCE_OF_TRUTH.md §4, §5).
 * No role can decide "release": only a human can approve release.
 */
export const ROLE_DECISIONS = {
  "content-curator": ["approve", "reject"],
  "scene-scout": ["select", "reject"],
  "campaign-matcher": ["recommend", "reject"],
  "placement-director": ["instructions-ready", "blocked"],
  "release-governor": ["approve-for-human-review", "revise", "stop"],
} as const satisfies Record<AgentRole, readonly string[]>;

export type HandoffDecision = (typeof ROLE_DECISIONS)[AgentRole][number];

export type EvidenceItem = {
  /** What was found. */
  claim: string;
  /** Where it came from: a catalogue field, timestamp, rule, or prior handoff. */
  source: string;
};

/** Shared handoff envelope carried in every BAND handoff message. */
export type HandoffEnvelope = {
  caseId: string;
  /** Shared artifact the handoff concerns (§5: "shared case and artifact ID"). */
  artifactId: string;
  senderRole: AgentRole;
  recipientRole: HandoffParty;
  decision: HandoffDecision;
  evidence: EvidenceItem[];
  /** 0–1. A statement of certainty, not a score that can offset a safety failure. */
  confidence: number;
  assumptions: string[];
  blockers: string[];
  nextAction: string;
  /** ISO 8601. */
  timestamp: string;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = 2000;

function isNonEmptyString(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => isNonEmptyString(v));
}

function isParty(value: unknown): value is HandoffParty {
  return value === HUMAN_REVIEWER || isAgentRole(value);
}

/**
 * Structural validation of an untrusted envelope. Checks every field's type and
 * range, that the decision belongs to the sender's role, and that blockers agree
 * with the decision. Role order is checked separately in protocol.ts.
 */
export function validateHandoff(input: unknown): ValidationResult<HandoffEnvelope> {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["Handoff must be a JSON object."] };
  }
  const h = input as Record<string, unknown>;

  const allowed = new Set([
    "caseId", "artifactId", "senderRole", "recipientRole", "decision", "evidence",
    "confidence", "assumptions", "blockers", "nextAction", "timestamp",
  ]);
  for (const key of Object.keys(h)) if (!allowed.has(key)) errors.push(`Unknown field: ${key}`);

  if (!isNonEmptyString(h.caseId, 100)) errors.push("caseId must be a non-empty string.");
  if (!isNonEmptyString(h.artifactId, 200)) errors.push("artifactId must be a non-empty string.");
  if (!isAgentRole(h.senderRole)) errors.push("senderRole must be a NativeFrame agent role.");
  if (!isParty(h.recipientRole)) errors.push("recipientRole must be an agent role or human-reviewer.");
  if (isAgentRole(h.senderRole) && h.senderRole === h.recipientRole) {
    errors.push("An agent cannot hand off to itself.");
  }

  if (isAgentRole(h.senderRole)) {
    const decisions: readonly string[] = ROLE_DECISIONS[h.senderRole];
    if (typeof h.decision !== "string" || !decisions.includes(h.decision)) {
      errors.push(`decision for ${h.senderRole} must be one of: ${decisions.join(", ")}.`);
    }
  }

  if (!Array.isArray(h.evidence) || h.evidence.length === 0) {
    errors.push("evidence must contain at least one item.");
  } else if (
    !h.evidence.every(
      (e) =>
        typeof e === "object" && e !== null &&
        isNonEmptyString((e as Record<string, unknown>).claim) &&
        isNonEmptyString((e as Record<string, unknown>).source, 500),
    )
  ) {
    errors.push("each evidence item needs a non-empty claim and source.");
  }

  if (typeof h.confidence !== "number" || !Number.isFinite(h.confidence) || h.confidence < 0 || h.confidence > 1) {
    errors.push("confidence must be a number from 0 to 1.");
  }
  if (!Array.isArray(h.assumptions) || !(h.assumptions.length === 0 || isStringArray(h.assumptions))) {
    errors.push("assumptions must be an array of non-empty strings.");
  }
  if (!Array.isArray(h.blockers) || !(h.blockers.length === 0 || isStringArray(h.blockers))) {
    errors.push("blockers must be an array of non-empty strings.");
  }
  if (!isNonEmptyString(h.nextAction)) errors.push("nextAction must be a non-empty string.");
  if (typeof h.timestamp !== "string" || !ISO_8601.test(h.timestamp) || Number.isNaN(Date.parse(h.timestamp))) {
    errors.push("timestamp must be an ISO 8601 date-time.");
  }

  if (errors.length > 0) return { ok: false, errors };

  const envelope = h as unknown as HandoffEnvelope;
  if (isAdvancing(envelope.decision) && envelope.blockers.length > 0) {
    errors.push(`decision "${envelope.decision}" cannot carry blockers.`);
  }
  if (!isAdvancing(envelope.decision) && envelope.blockers.length === 0) {
    errors.push(`decision "${envelope.decision}" must state at least one blocker.`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: envelope };
}

/** Decisions that move the case to the next specialist. */
const ADVANCING: ReadonlySet<string> = new Set([
  "approve",
  "select",
  "recommend",
  "instructions-ready",
  "approve-for-human-review",
]);

export function isAdvancing(decision: HandoffDecision): boolean {
  return ADVANCING.has(decision);
}
