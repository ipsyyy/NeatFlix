/**
 * Placement strategy for one demo campaign and scene: rebrand the two takeaway
 * cups already on the LUV café table as Daybreak Cold Brew, adding nothing.
 * The source frame holds exactly two cups for exactly two people, so a third
 * cup is contextually wrong (human contextual review of edited stills v1 and v2).
 *
 * Narrow by design: it applies only to daybreak-cold-brew in luv-scene-1, from
 * plan version 3 (or to any plan that declares this mode). Plans v1 and v2 were
 * made under the earlier insertion strategy and keep validating under it.
 * A plan can only declare the edit; whether the pixels obey it remains a human
 * visual review.
 */

export const REBRAND_MODE = "rebrand-existing-cups";

export type RebrandCup = {
  id: string;
  branded: true;
  position: "unchanged";
  size: "unchanged";
  shape: "unchanged";
  lid: "unchanged";
  straw: "unchanged" | "none";
};

export type RebrandSpec = {
  cupsBefore: number;
  cupsAfter: number;
  addedObjects: number;
  cups: RebrandCup[];
};

/** The LUV Daybreak rebrand: the two cups in the registered source frame. */
export const LUV_DAYBREAK_REBRAND = Object.freeze({
  campaignId: "daybreak-cold-brew",
  sceneId: "luv-scene-1",
  effectiveFromPlanVersion: 3,
  cups: Object.freeze([
    Object.freeze({ id: "man-cup", straw: "none" as const }),
    Object.freeze({ id: "woman-cup", straw: "unchanged" as const }),
  ]),
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether the rebrand strategy governs this plan (campaign, scene, and version or declared mode). */
export function rebrandApplies(plan: Record<string, unknown>): boolean {
  const product = isObj(plan.product) ? plan.product : {};
  const scene = isObj(plan.scene) ? plan.scene : {};
  const placement = isObj(plan.placement) ? plan.placement : {};
  if (product.campaignId !== LUV_DAYBREAK_REBRAND.campaignId || scene.sceneId !== LUV_DAYBREAK_REBRAND.sceneId) return false;
  const version = Number(/:v(\d+)$/.exec(String(plan.planId ?? ""))?.[1] ?? NaN);
  return placement.mode === REBRAND_MODE || version >= LUV_DAYBREAK_REBRAND.effectiveFromPlanVersion;
}

/** Affirmed requests to add, insert, or place an object, or to mention a third cup. Negated forms are allowed. */
export const INSERTION_REQUEST =
  /\b(add|adds|adding|insert|inserts|inserting|place|places|placing|put|puts|introduce|introduces)\b.{0,60}\b(cups?|objects?|products?|items?)\b|\bthird cup\b|\b(new|another|additional|extra) cup\b/i;
const INSERTION_VERB = /\b(add|adds|adding|insert|inserts|inserting|place|places|placing|put|puts|introduce|introduces|third|new|another|additional|extra)\b/i;
/** Affirmed requests to change an actor or their clothing. */
export const ACTOR_CHANGE =
  /\b(change|changes|alter|alters|modify|modifies|replace|replaces|edit|edits|retouch|reshape)\b.{0,50}\b(faces?|mouths?|lips|expressions?|hair|glasses|hands?|arms?|clothing|sweater|shirt|vest|identity|actors?)\b/i;
const ACTOR_VERB = /\b(change|changes|alter|alters|modify|modifies|replace|replaces|edit|edits|retouch|reshape)\b/i;
/** Affirmed requests to move, resize, remove, reshape, or duplicate a cup, lid, or straw. */
export const CUP_GEOMETRY_CHANGE =
  /\b(move|moves|moving|resize|resizes|resizing|enlarge|shrink|remove|removes|removing|reshape|duplicate|duplicates|reposition|shift)\b.{0,50}\b(cups?|lids?|straw)\b/i;
const GEOMETRY_VERB = /\b(move|moves|moving|resize|resizes|resizing|enlarge|shrink|remove|removes|removing|reshape|duplicate|duplicates|reposition|shift)\b/i;

type Affirmed = (text: string, pattern: RegExp, options?: { anchor?: RegExp }) => string[];

/**
 * Validates a plan under the LUV Daybreak rebrand strategy. `affirmed` is the
 * plan validator's negation-aware matcher, so "do not add a third cup" passes
 * and "add one more cup" does not.
 */
export function validateRebrand(p: Record<string, unknown>, affirmed: Affirmed): string[] {
  const e: string[] = [];
  const placement = isObj(p.placement) ? p.placement : {};
  if (placement.mode !== REBRAND_MODE) e.push(`For this campaign and scene, artifact.placement.mode must be "${REBRAND_MODE}": rebrand the two existing cups, never insert one.`);

  const r = isObj(p.rebrand) ? p.rebrand : {};
  if (r.cupsBefore !== 2 || r.cupsAfter !== 2) e.push("artifact.rebrand must keep exactly the two original cups before and after the edit.");
  if (r.addedObjects !== 0) e.push("artifact.rebrand.addedObjects must be 0: no cup or other object may be added.");
  const cups = Array.isArray(r.cups) ? r.cups.filter(isObj) : [];
  const ids = cups.map((c) => c.id);
  const expected = LUV_DAYBREAK_REBRAND.cups.map((c) => c.id);
  if (cups.length !== expected.length || new Set(ids).size !== ids.length || !expected.every((id) => ids.includes(id))) {
    e.push(`artifact.rebrand.cups must list exactly ${expected.join(" and ")}, each once.`);
  }
  for (const want of LUV_DAYBREAK_REBRAND.cups) {
    const c = cups.find((x) => x.id === want.id);
    if (!c) continue;
    if (c.branded !== true) e.push(`${want.id} must be rebranded; both existing cups carry the Daybreak Cold Brew branding.`);
    for (const k of ["position", "size", "shape", "lid"]) if (c[k] !== "unchanged") e.push(`${want.id}.${k} must be "unchanged": cups are never moved, resized, reshaped, or given new lids.`);
    if (c.straw !== want.straw) e.push(want.straw === "unchanged" ? "The woman's straw must stay exactly as it is." : `${want.id} has no straw; none may be added.`);
  }

  const prompts = isObj(p.prompts) ? p.prompts : {};
  const still = String((isObj(prompts.stillImageEdit) ? prompts.stillImageEdit.prompt : "") ?? "");
  const motion = String((isObj(prompts.motion) ? prompts.motion.prompt : "") ?? "");
  const guidance = isObj(p.guidance) ? Object.values(p.guidance).filter((v): v is string => typeof v === "string") : [];
  const instruction = [String(placement.description ?? ""), ...guidance, still, motion].join("\n");
  for (const s of affirmed(instruction, INSERTION_REQUEST, { anchor: INSERTION_VERB })) e.push(`Do not add any cup or object: "${s.slice(0, 120)}"`);
  for (const s of affirmed(instruction, ACTOR_CHANGE, { anchor: ACTOR_VERB })) e.push(`Actors and clothing must not change: "${s.slice(0, 120)}"`);
  for (const s of affirmed(instruction, CUP_GEOMETRY_CHANGE, { anchor: GEOMETRY_VERB })) e.push(`Cups, lids, and the straw must not move or change shape: "${s.slice(0, 120)}"`);
  if (!/\bexactly two\b/i.test(still) || !/\bboth\b/i.test(still) || !/\bstraw\b/i.test(still) || !/\bbrand/i.test(still)) {
    e.push('The still prompt must rebrand both existing cups, keep "exactly two" cups, and preserve the straw.');
  }
  if (!/\b(mouths?|expressions?)\b/i.test(still) || !/\bclothing\b/i.test(still)) e.push("The still prompt must forbid changes to faces, mouths, expressions, and clothing.");

  const negatives = Array.isArray(p.negativeConstraints) ? p.negativeConstraints.join(" ").toLowerCase() : "";
  if (!/\b(third|additional|added|new|extra) cups?\b|\bno (other )?objects?\b/.test(negatives)) e.push("artifact.negativeConstraints must forbid adding any cup or object.");
  if (!/\b(move|resize|reshape)\b/.test(negatives)) e.push("artifact.negativeConstraints must forbid moving, resizing, or reshaping the cups.");
  if (!/\bstraw\b/.test(negatives)) e.push("artifact.negativeConstraints must protect the woman's straw.");
  const pres = isObj(p.preservation) ? p.preservation : {};
  const list = (k: string) => (Array.isArray(pres[k]) ? (pres[k] as unknown[]).join(" ") : "");
  if (!/\b(mouths?|expressions?)\b/i.test(list("faces"))) e.push("artifact.preservation.faces must preserve mouths and expressions.");
  if (!/\bclothing\b/i.test(list("bodies")) || !/\b(hands?|arms?)\b/i.test(list("bodies"))) e.push("artifact.preservation.bodies must preserve hands, arms, and clothing.");
  return e;
}
