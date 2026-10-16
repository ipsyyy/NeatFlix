import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import type { EvidenceItem } from "./envelope";

/**
 * Typed placement-plan artifact produced by Placement Director
 * (PRODUCT_SOURCE_OF_TRUTH.md §4.4, §11). It describes a future edit; it is not
 * evidence that any generation happened. Both prompts are instructions that have
 * not been executed.
 */

export const PLACEMENT_REGION = "visible café table";
export const PROMPT_NOT_EXECUTED_LABEL = "Generation instruction — not yet executed";
export const MOTION_MIN_SECONDS = 3;
export const MOTION_MAX_SECONDS = 5;

/** Exact disclosure about the current visual: approved title artwork, not footage. */
export const STAND_IN_DISCLOSURE =
  "The current visual is approved title artwork used as a stand-in, not a frame from the selected scene.";

/**
 * Misleading terms for the current visual. It is title artwork, not a source,
 * scene, or extracted video frame, and no video has been analyzed.
 */
export const MISLEADING_FRAME_TERMS = /\b(source|scene|video|extracted|selected[- ]scene) frames?\b|\banaly[sz]ed (the )?(video|footage)\b|\bextracted (from )?(the )?(video|footage)\b/i;

/** Every string inside a value, for whole-plan text checks. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/**
 * A negation that denies the term itself: "not a scene frame", "no source frame",
 * "rather than a video frame", or "do not present the artwork as a scene frame or
 * video frame".
 * A negation of some other verb ("do not alter the source frame") still treats
 * the artwork as a frame, so it does not excuse the term.
 */
const NEGATED_BEFORE =
  /\b(?:not|never|no|isn't|aren't|wasn't)\b(?:[^.;:!?\n]{0,40}\bas)?\s+(?:(?:an?|the|any)\s+)?(?:(?:real|actual|genuine)\s+)?(?:[\w-]+\s+frames?,?\s+(?:or|nor)\s+(?:(?:an?|the)\s+)?)*$|\b(?:rather than|instead of)\s+(?:(?:an?|the)\s+)?$/i;

/**
 * Text that calls the stand-in a frame or implies analyzed footage. Reports the
 * offending snippets. Directly negated terms are allowed: the prompt and tools
 * ask for statements such as "it is not a scene frame".
 */
export function misleadingFrameTerms(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(MISLEADING_FRAME_TERMS.source, "gi");
  for (const m of text.matchAll(re)) {
    if (!NEGATED_BEFORE.test(text.slice(0, m.index))) found.push(m[0]);
  }
  return [...new Set(found)];
}

export type PlacementPlan = {
  kind: "placement-plan";
  version: 1;
  planId: string;
  caseId: string;
  sourceArtifacts: { matchArtifactId: string; sceneArtifactId: string; titleId: string };
  scene: { sceneId: string; name: string; startSeconds: number; endSeconds: number };
  product: { campaignId: string; product: string; format: string };
  placement: { region: string; motion: "stationary"; handInteraction: "none"; description: string };
  guidance: { scale: string; perspective: string; lighting: string; shadow: string; colorMatch: string };
  preservation: { faces: string[]; bodies: string[]; background: string[]; composition: string[] };
  brandLegibility: string[];
  negativeConstraints: string[];
  prompts: {
    stillImageEdit: { target: "gemini-nano-banana"; status: "not-executed"; label: string; prompt: string };
    motion: { target: "reactor"; status: "not-executed"; label: string; durationSeconds: number; prompt: string };
  };
  sourceMedia: { kind: "title-artwork-stand-in"; isSceneFrame: false; src: string; note: string };
  assumptions: string[];
  blockers: string[];
  evidence: EvidenceItem[];
};

const MAX = 2000;
const str = (v: unknown, max = MAX): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => str(s));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Words that negate what follows them. */
const NEGATOR = /(?:\b(?:no|not|never|nothing|none|nobody|neither|nor|without|avoid|avoids|cannot)\b|n't\b)/i;
/** Ends a clause: punctuation, or a conjunction that starts another claim. */
const CLAUSE_BREAK = /[,;:.!?\n]|\b(?:and|but|while|whereas|although|though|however)\b/i;
/** How far back a negation may sit and still apply to the matched term. */
const NEGATION_REACH = 60;
/** A future or modal verb directly before a generation verb: "will be rendered", "to be generated". */
const FUTURE_BEFORE = /\b(?:will|would|should|must|can|could|may|might|to)\s+(?:not\s+)?(?:be\s+|have\s+been\s+)?$|\bfuture\s+$/i;

/** The part of `before`'s last clause within NEGATION_REACH characters, starting at a whole word. */
function clauseTail(before: string): string {
  const window = before.length > NEGATION_REACH ? before.slice(before.length - NEGATION_REACH).replace(/^\S*\s/, "") : before;
  const parts = window.split(CLAUSE_BREAK);
  return parts[parts.length - 1];
}

/**
 * Sentences in which `pattern` is affirmed. A match is excused only when a
 * negation applies to it directly: earlier in the same clause, close before
 * the matched term (or before its `anchor` word, for patterns whose key word
 * comes last). A negation elsewhere in the sentence ("…with no artifacts")
 * never excuses it. `allowFuture` also excuses a modal directly before the
 * anchor ("will be rendered").
 */
export function affirmed(text: string, pattern: RegExp, options: { anchor?: RegExp; allowFuture?: boolean } = {}): string[] {
  const found: string[] = [];
  const sentences = text.split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const sentence of sentences) {
    const claims = [...sentence.matchAll(new RegExp(pattern.source, "gi"))].some((m) => {
      const offset = options.anchor ? Math.max(0, m[0].search(options.anchor)) : 0;
      const before = sentence.slice(0, m.index + offset);
      if (NEGATOR.test(clauseTail(before))) return false;
      return !(options.allowFuture && FUTURE_BEFORE.test(before));
    });
    if (claims) found.push(sentence);
  }
  return found;
}

export const HAND_INTERACTION =
  /\b(hand|hands|finger|fingers)\b.{0,40}\b(cup|product)\b|\b(holding|holds|hold|grab|grabs|grabbing|picks? up|picking up|lift|lifts|lifting|sip|sips|sipping|drinks? from|reach(es|ing)? for)\b/i;
export const FACE_OBSTRUCTION =
  /\b(in front of|over|covering|covers|cover|obstruct(s|ing)?|block(s|ing)?|overlap(s|ping)?|occlud(e|es|ing))\b.{0,40}\bfaces?\b|\bfaces?\b.{0,40}\b(covered|obstructed|blocked|occluded|hidden)\b/i;
/** The verb a generation claim turns on, so "Masky has not run" is judged at "run". */
const GENERATION_VERB = /\b(generated|rendered|edited|composited|produced|created|inserted|ran|run|returned|output)\b/i;
/** The verb in "faces … covered" claims, so "faces are not covered" is judged at "covered". */
const FACE_OBSTRUCTION_VERB = /\b(covered|obstructed|blocked|occluded|hidden)\b/i;
export const GENERATION_CLAIM =
  /\b(generated|rendered|edited|composited|produced|created|inserted)\b.{0,60}\b(image|frame|video|preview|still|clip|placement)\b|\b(gemini|nano banana|reactor|masky)\b.{0,40}\b(ran|run|has run|generated|produced|rendered|returned|output)\b|\b(the|this) (generated|rendered) (image|frame|video|preview|clip)\b/i;

/** Claims that a generation step has already happened. Negated statements are allowed. */
export function generationClaims(text: string): string[] {
  return affirmed(text, GENERATION_CLAIM, { anchor: GENERATION_VERB, allowFuture: true });
}

/** Validates a placement plan's schema and safety rules against the approved fixtures. */
export function validatePlacementPlan(input: unknown, expectedCaseId?: string): string[] {
  if (!isObj(input)) return ["artifact must be a placement-plan object."];
  const p = input as Record<string, unknown>;
  const e: string[] = [];

  if (p.kind !== "placement-plan" || p.version !== 1) e.push('artifact.kind must be "placement-plan" and version 1.');
  if (!str(p.planId, 200)) e.push("artifact.planId is required.");
  if (!str(p.caseId, 100)) e.push("artifact.caseId is required.");
  else if (expectedCaseId && p.caseId !== expectedCaseId) e.push("artifact.caseId must match the handoff caseId.");

  const src = isObj(p.sourceArtifacts) ? p.sourceArtifacts : {};
  if (!str(src.matchArtifactId, 200) || !str(src.sceneArtifactId, 200) || !str(src.titleId, 120)) {
    e.push("artifact.sourceArtifacts needs matchArtifactId, sceneArtifactId, and titleId.");
  }

  // Scene must be a recorded scene with its recorded window.
  const scene = isObj(p.scene) ? p.scene : {};
  const title = catalogue.find((t) => t.id === src.titleId);
  const recorded = title ? getSceneReview(title.id)?.scenes.find((s) => s.id === scene.sceneId) : undefined;
  if (!recorded) e.push("artifact.scene must reference a recorded scene of the source title.");
  else {
    if (scene.startSeconds !== recorded.startSeconds || scene.endSeconds !== recorded.endSeconds) {
      e.push(`artifact.scene window must be the recorded ${recorded.startSeconds}–${recorded.endSeconds} s.`);
    }
    if (!/caf[eé] table/i.test(recorded.surface)) e.push("The recorded scene has no café table surface.");
  }

  // Product must be the recorded campaign product and format.
  const product = isObj(p.product) ? p.product : {};
  const campaign = campaigns.find((c) => c.id === product.campaignId);
  if (!campaign) e.push("artifact.product.campaignId must reference an approved campaign.");
  else if (product.product !== campaign.product || product.format !== campaign.productFormat) {
    e.push("artifact.product must match the approved campaign product and format.");
  }

  const placement = isObj(p.placement) ? p.placement : {};
  if (typeof placement.region !== "string" || placement.region.trim().toLowerCase() !== PLACEMENT_REGION) {
    e.push(`artifact.placement.region must be "${PLACEMENT_REGION}".`);
  }
  if (placement.motion !== "stationary") e.push('artifact.placement.motion must be "stationary".');
  if (placement.handInteraction !== "none") e.push('artifact.placement.handInteraction must be "none".');
  if (!str(placement.description)) e.push("artifact.placement.description is required.");

  const guidance = isObj(p.guidance) ? p.guidance : {};
  for (const k of ["scale", "perspective", "lighting", "shadow", "colorMatch"]) {
    if (!str(guidance[k])) e.push(`artifact.guidance.${k} is required.`);
  }

  const pres = isObj(p.preservation) ? p.preservation : {};
  for (const k of ["faces", "bodies", "background", "composition"]) {
    if (!strList(pres[k])) e.push(`artifact.preservation.${k} must list at least one preservation requirement.`);
  }

  if (!strList(p.brandLegibility)) e.push("artifact.brandLegibility must list at least one legibility limit.");

  if (!strList(p.negativeConstraints)) e.push("artifact.negativeConstraints must list the forbidden changes.");
  else {
    const all = (p.negativeConstraints as string[]).join(" ").toLowerCase();
    if (!/hand/.test(all)) e.push("artifact.negativeConstraints must forbid hand interaction.");
    if (!/face/.test(all)) e.push("artifact.negativeConstraints must forbid face obstruction or alteration.");
    if (!/(text|logo|watermark|label)/.test(all)) e.push("artifact.negativeConstraints must forbid added text or extra logos.");
  }

  const prompts = isObj(p.prompts) ? p.prompts : {};
  const still = isObj(prompts.stillImageEdit) ? prompts.stillImageEdit : {};
  const motion = isObj(prompts.motion) ? prompts.motion : {};
  if (still.target !== "gemini-nano-banana" || still.status !== "not-executed" || still.label !== PROMPT_NOT_EXECUTED_LABEL || !str(still.prompt)) {
    e.push(`artifact.prompts.stillImageEdit must target gemini-nano-banana, have status "not-executed", label "${PROMPT_NOT_EXECUTED_LABEL}", and a prompt.`);
  }
  if (motion.target !== "reactor" || motion.status !== "not-executed" || motion.label !== PROMPT_NOT_EXECUTED_LABEL || !str(motion.prompt)) {
    e.push(`artifact.prompts.motion must target reactor, have status "not-executed", label "${PROMPT_NOT_EXECUTED_LABEL}", and a prompt.`);
  }
  const duration = motion.durationSeconds;
  const window = recorded ? recorded.endSeconds - recorded.startSeconds : MOTION_MAX_SECONDS;
  if (typeof duration !== "number" || duration < MOTION_MIN_SECONDS || duration > Math.min(MOTION_MAX_SECONDS, window)) {
    e.push(`artifact.prompts.motion.durationSeconds must be ${MOTION_MIN_SECONDS}–${Math.min(MOTION_MAX_SECONDS, window)} seconds.`);
  }

  const media = isObj(p.sourceMedia) ? p.sourceMedia : {};
  if (media.kind !== "title-artwork-stand-in" || media.isSceneFrame !== false || !str(media.src, 300) || !str(media.note)) {
    e.push("artifact.sourceMedia must be the title-artwork stand-in with isSceneFrame false, its src, and a note.");
  } else if (title && title.artwork.kind === "image" && media.src !== title.artwork.src) {
    e.push("artifact.sourceMedia.src must be the approved title artwork.");
  } else if (media.note !== STAND_IN_DISCLOSURE) {
    e.push(`artifact.sourceMedia.note must be exactly: "${STAND_IN_DISCLOSURE}"`);
  }
  for (const term of misleadingFrameTerms(strings(p).join("\n"))) {
    e.push(`Do not call the stand-in a "${term}"; it is approved title artwork, not footage.`);
  }

  if (!Array.isArray(p.assumptions) || !p.assumptions.every((s) => str(s))) e.push("artifact.assumptions must be a list of strings.");
  if (!Array.isArray(p.blockers) || !p.blockers.every((s) => str(s))) e.push("artifact.blockers must be a list of strings.");
  if (
    !Array.isArray(p.evidence) ||
    p.evidence.length === 0 ||
    !p.evidence.every((x) => isObj(x) && str(x.claim) && str(x.source, 500))
  ) {
    e.push("artifact.evidence must cite at least one source for its facts.");
  }

  // Safety rules over all instruction text.
  const text = [
    placement.description,
    ...Object.values(guidance),
    still.prompt,
    motion.prompt,
  ]
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  for (const s of affirmed(text, HAND_INTERACTION)) e.push(`Hand interaction is not allowed: "${s.slice(0, 120)}"`);
  for (const s of affirmed(text, FACE_OBSTRUCTION, { anchor: FACE_OBSTRUCTION_VERB })) e.push(`Face obstruction is not allowed: "${s.slice(0, 120)}"`);
  if (!/no hand interaction/i.test(String(still.prompt ?? "")) || !/no hand interaction/i.test(String(motion.prompt ?? ""))) {
    e.push('Both prompts must state "no hand interaction".');
  }
  if (!/stationary/i.test(String(motion.prompt ?? ""))) e.push("The motion prompt must keep the product stationary.");
  for (const s of generationClaims(text)) e.push(`The plan must not claim generation happened: "${s.slice(0, 120)}"`);
  return e;
}
