import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import type { EvidenceItem } from "./envelope";
import { affirmed, generationClaims, misleadingFrameTerms } from "./placement-plan";

/**
 * Typed review artifact produced by the Release Governor
 * (PRODUCT_SOURCE_OF_TRUTH.md §4.5, §5, §7). It records an honest decision about
 * a Placement Director plan. "approve-for-human-review" needs a real generated
 * preview confirmed by the preview registry; no agent can record human approval.
 */

export type ReviewDecision = "revise" | "approve-for-human-review" | "stop";
export type Outcome = "pass" | "fail" | "not-evaluated";
export type CorrectionKind = "generate-preview" | "provide-provenance" | "provide-evaluation-evidence" | "plan-change";

export type GovernorReview = {
  kind: "governor-review";
  version: 1;
  reviewId: string;
  caseId: string;
  subject: { titleId: string; sceneId: string; campaignId: string; planId: string };
  decision: ReviewDecision;
  hhh: Record<"helpful" | "honest" | "harmless", { outcome: Outcome; rationale: string }>;
  checks: { id: string; category: "policy" | "technical"; outcome: Outcome; detail: string; source: string }[];
  evidence: EvidenceItem[];
  blockers: string[];
  corrections: { kind: CorrectionKind; issue: string; requiredAction: string }[];
  assumptions: string[];
  uncertainty: string;
  preview: {
    status: "missing" | "provided";
    assetRef: string | null;
    provenance: { generator: string; generatedAt: string; inputPlanId: string } | null;
    generationMetadata: { model: string; latencyMs: number; costUsd: number } | null;
  };
  /** An agent can only say approval is not requested yet or is pending. A human records approval elsewhere. */
  humanApproval: { status: "not-requested" | "pending" };
};

/** A generated preview as the media pipeline records it. Agents cannot create these. */
export type PreviewRecord = {
  planId: string;
  assetRef: string;
  provenance: { generator: string; generatedAt: string; inputPlanId: string };
  generationMetadata: { model: string; latencyMs: number; costUsd: number };
};

/** Source of truth for generated previews, looked up by plan ID. */
export type PreviewRegistry = { find(planId: string): PreviewRecord | null };

/**
 * The preview registry in use today. No media-generation pipeline is connected,
 * so no plan has a generated preview and no review can be approved.
 */
export const NO_GENERATED_PREVIEWS: PreviewRegistry = Object.freeze({ find: () => null });

/** Exact sentence a review must state while no generated preview exists. */
export const NO_PREVIEW_DISCLOSURE =
  "No generated preview exists yet, so nothing has been visually evaluated or approved for release or experimentation.";

/** Corrections a revise must request while the preview is missing. */
export const MISSING_PREVIEW_CORRECTIONS: readonly CorrectionKind[] = ["generate-preview", "provide-provenance", "provide-evaluation-evidence"];

const OUTCOMES: readonly string[] = ["pass", "fail", "not-evaluated"];
const CORRECTION_KINDS: readonly string[] = ["generate-preview", "provide-provenance", "provide-evaluation-evidence", "plan-change"];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ASSET_REF = /^(https:\/\/\S+|storage:\/\/\S+)$/;
const MAX = 2000;

const str = (v: unknown, max = MAX): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => str(s));
const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Claims that a preview was inspected, compared or approved, which no review can make without one. */
export const VISUAL_CLAIM =
  /\b(inspected|reviewed|viewed|watched|examined|checked)\b.{0,40}\b(preview|generated (image|video|still|clip|media))\b|\bcompared\b.{0,60}\b(preview|generated|source frame|original scene)\b|\bvisual (quality|evaluation|check)s?\b.{0,30}\b(passed|is good|looks good|acceptable|complete[d]?)\b|\b(approved|cleared)\b.{0,30}\b(for )?(release|experiment(ation)?|a\/b test|viewers)\b|\b(is|has been|was) released\b/i;
const VISUAL_VERB = /\b(inspected|reviewed|viewed|watched|examined|checked|compared|passed|is good|looks good|acceptable|completed?|approved|cleared|released)\b/i;

/** Statements that a preview was inspected or work was approved for release. Negated statements are allowed. */
export function visualClaims(text: string): string[] {
  return affirmed(text, VISUAL_CLAIM, { anchor: VISUAL_VERB });
}

/** Every string inside a value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isObj(value)) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * Validates a Release Governor review against its handoff and the approved
 * fixtures. `previews` is the preview registry; approval is only possible for
 * a preview it confirms.
 */
export function validateGovernorReview(
  input: unknown,
  context: { caseId?: string; decision?: string; artifactId?: string } = {},
  previews: PreviewRegistry = NO_GENERATED_PREVIEWS,
): string[] {
  if (!isObj(input)) return ["artifact must be a governor-review object."];
  const r = input;
  const e: string[] = [];

  if (r.kind !== "governor-review" || r.version !== 1) e.push('artifact.kind must be "governor-review" and version 1.');
  if (!str(r.reviewId, 200)) e.push("artifact.reviewId is required.");
  if (!str(r.caseId, 100)) e.push("artifact.caseId is required.");
  else if (context.caseId && r.caseId !== context.caseId) e.push("artifact.caseId must match the handoff caseId.");
  const decision = r.decision;
  if (decision !== "revise" && decision !== "approve-for-human-review" && decision !== "stop") {
    e.push('artifact.decision must be "revise", "approve-for-human-review", or "stop".');
  } else if (context.decision && decision !== context.decision) {
    e.push("artifact.decision must match the handoff decision.");
  }

  // Subject: the reviewed plan must name a real title, recorded scene, and approved campaign.
  const subject = isObj(r.subject) ? r.subject : {};
  const title = catalogue.find((t) => t.id === subject.titleId);
  const scene = title ? getSceneReview(title.id)?.scenes.find((s) => s.id === subject.sceneId) : undefined;
  if (!title) e.push("artifact.subject.titleId must be a catalogue title.");
  else if (!scene) e.push("artifact.subject.sceneId must be a recorded scene of that title.");
  if (!campaigns.some((c) => c.id === subject.campaignId)) e.push("artifact.subject.campaignId must be an approved campaign.");
  const planId = subject.planId;
  if (!str(planId, 200) || planId.replace(/:v\d+$/, "") !== `plan:${subject.campaignId}:${subject.sceneId}`) {
    e.push("artifact.subject.planId must be plan:<campaignId>:<sceneId>:v<n>.");
  } else if (context.artifactId && context.artifactId !== planId) {
    e.push("The handoff artifactId must be the reviewed planId.");
  }

  const hhh = isObj(r.hhh) ? r.hhh : {};
  const hhhOutcomes: string[] = [];
  for (const k of ["helpful", "honest", "harmless"]) {
    const item = isObj(hhh[k]) ? hhh[k] : {};
    if (!OUTCOMES.includes(String(item.outcome)) || !str(item.rationale)) {
      e.push(`artifact.hhh.${k} needs an outcome (pass, fail, or not-evaluated) and a rationale.`);
    }
    hhhOutcomes.push(String(item.outcome));
  }

  const checks = Array.isArray(r.checks) ? r.checks : [];
  if (
    checks.length === 0 ||
    !checks.every(
      (c) => isObj(c) && str(c.id, 100) && (c.category === "policy" || c.category === "technical") && OUTCOMES.includes(String(c.outcome)) && str(c.detail) && str(c.source, 500),
    )
  ) {
    e.push("artifact.checks must list at least one policy or technical check, each with an id, category, outcome, detail, and source.");
  }
  const typedChecks = checks.filter(isObj);

  if (!Array.isArray(r.evidence) || r.evidence.length === 0 || !r.evidence.every((x) => isObj(x) && str(x.claim) && str(x.source, 500))) {
    e.push("artifact.evidence must cite at least one source.");
  }
  if (!strArray(r.blockers)) e.push("artifact.blockers must be a list of strings.");
  if (!strArray(r.assumptions)) e.push("artifact.assumptions must be a list of strings.");
  if (!str(r.uncertainty)) e.push("artifact.uncertainty must state what is unknown.");
  const corrections = Array.isArray(r.corrections) ? r.corrections : null;
  if (!corrections || !corrections.every((c) => isObj(c) && CORRECTION_KINDS.includes(String(c.kind)) && str(c.issue) && str(c.requiredAction))) {
    e.push(`artifact.corrections must be a list of { kind (${CORRECTION_KINDS.join(", ")}), issue, requiredAction }.`);
  }
  const blockers = strArray(r.blockers) ? r.blockers : [];
  const correctionKinds = (corrections ?? []).filter(isObj).map((c) => String(c.kind));

  // Human approval can never be recorded by an agent.
  const approval = isObj(r.humanApproval) ? r.humanApproval : {};
  if (approval.status !== "not-requested" && approval.status !== "pending") {
    e.push('artifact.humanApproval.status must be "not-requested" or "pending"; only a human can record approval.');
  }

  // Preview and provenance.
  const preview = isObj(r.preview) ? r.preview : {};
  const missing = preview.status === "missing";
  const confirmed = str(planId, 200) ? previews.find(planId) : null;
  if (preview.status !== "missing" && preview.status !== "provided") {
    e.push('artifact.preview.status must be "missing" or "provided".');
  } else if (missing) {
    if (preview.assetRef !== null || preview.provenance !== null || preview.generationMetadata !== null) {
      e.push("A missing preview must have null assetRef, provenance, and generationMetadata.");
    }
    if (confirmed) e.push("The preview registry has a generated preview for this plan; report it as provided.");
    if (typedChecks.some((c) => c.category === "technical" && c.outcome === "pass")) {
      e.push('Without a generated preview, technical checks must be "not-evaluated" or "fail", never "pass".');
    }
  } else {
    const prov = isObj(preview.provenance) ? preview.provenance : {};
    const meta = isObj(preview.generationMetadata) ? preview.generationMetadata : {};
    if (!str(preview.assetRef, 500) || !ASSET_REF.test(preview.assetRef)) e.push("artifact.preview.assetRef must be an https:// or storage:// reference.");
    if (!str(prov.generator, 120) || !str(prov.generatedAt, 40) || !ISO_UTC.test(prov.generatedAt) || prov.inputPlanId !== planId) {
      e.push("artifact.preview.provenance needs generator, an ISO UTC generatedAt, and inputPlanId equal to the planId.");
    }
    if (!str(meta.model, 120) || !nonNegative(meta.latencyMs) || !nonNegative(meta.costUsd)) {
      e.push("artifact.preview.generationMetadata needs model, latencyMs, and costUsd.");
    }
    if (!confirmed) {
      e.push("No generated preview is recorded for this plan; a provided preview must come from the media pipeline.");
    } else if (
      confirmed.assetRef !== preview.assetRef ||
      confirmed.provenance.generator !== prov.generator ||
      confirmed.provenance.generatedAt !== prov.generatedAt ||
      confirmed.generationMetadata.model !== meta.model
    ) {
      e.push("artifact.preview does not match the recorded generated preview.");
    }
  }

  // Decision rules.
  if (decision === "approve-for-human-review") {
    if (missing || !confirmed) e.push("approve-for-human-review requires a recorded generated preview with provenance and generation metadata.");
    if (hhhOutcomes.some((o) => o !== "pass")) e.push("approve-for-human-review requires helpful, honest, and harmless to pass.");
    if (!typedChecks.some((c) => c.category === "technical") || typedChecks.some((c) => c.outcome !== "pass")) {
      e.push("approve-for-human-review requires every check, including at least one technical check, to pass.");
    }
    if (blockers.length > 0 || correctionKinds.length > 0) e.push("approve-for-human-review cannot carry blockers or corrections.");
    if (approval.status !== "pending") e.push('approve-for-human-review must set humanApproval.status to "pending".');
  } else if (decision === "revise") {
    if (correctionKinds.length === 0) e.push("revise must list at least one actionable correction.");
    if (blockers.length === 0) e.push("revise must state at least one blocker.");
    if (missing) {
      for (const kind of MISSING_PREVIEW_CORRECTIONS) {
        if (!correctionKinds.includes(kind)) e.push(`Without a generated preview, revise must request a "${kind}" correction.`);
      }
    }
  } else if (decision === "stop") {
    if (blockers.length === 0) e.push("stop must state at least one blocker.");
    if (hhhOutcomes[2] !== "fail" && !typedChecks.some((c) => c.category === "policy" && c.outcome === "fail")) {
      e.push("stop requires blocking evidence: a failed harmlessness assessment or a failed policy check.");
    }
  }

  // Truthfulness over every string in the review.
  const text = strings(r).join("\n");
  for (const s of visualClaims(text)) e.push(`The review cannot claim visual inspection or approval: "${s.slice(0, 120)}"`);
  // A preview confirmed by the registry really was generated; otherwise no generation claim is true.
  if (!(preview.status === "provided" && confirmed)) {
    for (const s of generationClaims(text)) e.push(`The review cannot claim generation happened: "${s.slice(0, 120)}"`);
  }
  for (const term of misleadingFrameTerms(text)) e.push(`Do not call the stand-in a "${term}"; it is approved title artwork, not footage.`);
  return e;
}
