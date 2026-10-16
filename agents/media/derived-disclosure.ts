import { REBRAND_MODE } from "@/agents/handoff/placement-strategy";
import type { VisualDisclosureRegistry, VisualDisclosureState } from "@/agents/handoff/source-frames";
import type { WorkflowStore } from "@/agents/persistence/store";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";
import { campaigns } from "@/data/campaigns";
import { EDITED_STILL_ORIGIN, GEMINI_GENERATOR, loadVerifiedEditedStill } from "./edited-still";
import { FALLBACK_GENERATOR, FALLBACK_ORIGIN } from "./fallback-preview";
import type { PreviewEvidenceSource } from "./preview-evidence";

/**
 * The visual disclosure for a plan whose registered source frame has derived
 * media, built only from registered provenance. A plan with no edited still and
 * no generated preview is "unedited": the historical frame disclosure stays
 * truthful. A plan with derived media gets a disclosure only when every element
 * agrees exactly (plan, source-frame binding, one verified Gemini edited still
 * of that frame with an approved human visual review, a rebrand that adds no
 * object, and one verified local FFmpeg fallback preview of that still with an
 * approved review); anything absent, mismatched, or unsupported is "invalid".
 * Read-only.
 */

export type DisclosureState =
  | { status: "unedited" }
  | { status: "derived"; disclosure: string; facts: DisclosureFacts }
  | { status: "invalid"; errors: string[] };

export type DisclosureFacts = {
  planId: string;
  sourceFrameAssetId: string;
  editedStill: { assetId: string; checksum: string; visualReviewId: string };
  preview: { assetId: string; checksum: string; visualReviewId: string };
  cups: number;
  brand: string;
};

/** Short names used in disclosures, per catalogue title. A title without one is unsupported. */
const TITLE_SHORT_NAMES: Readonly<Record<string, string>> = Object.freeze({ "luv-hypothesis": "LUV" });
/** How a supported generator is named in a disclosure. */
const EDITOR_NAMES: Readonly<Record<string, string>> = Object.freeze({ [GEMINI_GENERATOR]: "Gemini" });
const NUMBER_WORDS: Readonly<Record<number, string>> = Object.freeze({ 1: "one", 2: "two", 3: "three" });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const invalid = (...errors: string[]): DisclosureState => ({ status: "invalid", errors });

export async function deriveVisualDisclosure(
  deps: { workflow: WorkflowRegistry; store: WorkflowStore; evidence?: PreviewEvidenceSource },
  planId: string,
): Promise<DisclosureState> {
  const loaded = await deps.workflow.loadPlan(planId);
  if (!loaded.ok) return invalid(`Plan ${planId} does not revalidate.`, ...loaded.errors);
  const plan = loaded.value;
  const stills = await deps.store.listMediaAssetsForPlan(planId, "edited-still", 2);
  const previews = await deps.store.listMediaAssetsForPlan(planId, "generated-preview", 2);
  if (stills.length === 0 && previews.length === 0) return { status: "unedited" };

  // The registered source frame the plan is bound to.
  const media = plan.sourceMedia;
  if (media.kind !== "registered-source-frame") return invalid("Derived media exists for a plan that is not bound to a registered source frame.");
  const frame = await deps.workflow.loadSourceFrame(media.assetId);
  if (!frame.ok) return invalid("The plan's source frame does not revalidate.", ...frame.errors);
  if (frame.value.storageRef !== media.storageRef || frame.value.checksum !== media.checksum || frame.value.caseId !== plan.caseId) {
    return invalid("The plan's source-frame binding does not match the registry.");
  }
  const short = TITLE_SHORT_NAMES[plan.sourceArtifacts.titleId];
  if (!short) return invalid(`No disclosure name is defined for title ${plan.sourceArtifacts.titleId}.`);

  // The plan's strategy: rebrand every existing cup, add nothing.
  const placement = plan.placement as Record<string, unknown>;
  const rebrand = isObj(plan.rebrand) ? plan.rebrand : null;
  const cups = rebrand && Array.isArray(rebrand.cups) ? rebrand.cups.filter(isObj) : [];
  if (
    placement.mode !== REBRAND_MODE ||
    !rebrand ||
    rebrand.addedObjects !== 0 ||
    rebrand.cupsBefore !== rebrand.cupsAfter ||
    cups.length !== rebrand.cupsBefore ||
    !cups.every((c) => c.branded === true && c.position === "unchanged" && c.size === "unchanged" && c.shape === "unchanged")
  ) {
    return invalid("The plan is not a rebrand of the existing cups that adds no object.");
  }
  const cupWord = NUMBER_WORDS[cups.length];
  if (!cupWord) return invalid(`Unsupported cup count ${cups.length}.`);
  const brand = campaigns.find((c) => c.id === plan.product.campaignId)?.product;
  if (!brand || brand !== plan.product.product) return invalid("The plan's product does not match its approved campaign.");

  // One verified edited still of that frame, by a supported editor, with an approved review of its exact bytes.
  if (stills.length !== 1) return invalid(`Expected exactly one edited still for ${planId}, found ${stills.length >= 2 ? "several" : stills.length}.`);
  const still = await loadVerifiedEditedStill(deps.workflow, deps.store, stills[0].asset_id);
  if (!still.ok) return invalid("The edited still does not revalidate.", ...still.errors);
  const stillProv = isObj(still.row.provenance) ? still.row.provenance : {};
  const editor = EDITOR_NAMES[String(still.row.generator)];
  if (!editor || stillProv.origin !== EDITED_STILL_ORIGIN) return invalid("The edited still is not a supported Gemini edit.");
  if (still.context.sourceFrame.assetId !== media.assetId || still.context.sourceFrame.checksum !== media.checksum) return invalid("The edited still is not an edit of the plan's source frame.");
  const stillReview = await deps.store.getVisualReview(still.row.asset_id);
  if (!stillReview || stillReview.decision !== "approved" || stillReview.asset_checksum !== still.row.checksum || stillReview.case_id !== plan.caseId) {
    return invalid("The edited still has no approved human visual review of its exact bytes.");
  }

  // One verified local FFmpeg fallback preview of that still, with an approved review of its exact bytes.
  if (previews.length !== 1) return invalid(`Expected exactly one generated preview for ${planId}, found ${previews.length >= 2 ? "several" : previews.length}.`);
  if (!deps.evidence) return invalid("No verified preview evidence source is configured.");
  const evidence = await deps.evidence(planId);
  if (evidence.outcome !== "pass" || !evidence.assetId || !evidence.checksum || !evidence.visualReviewId) return invalid(`The preview is not verified evidence: ${evidence.detail}`);
  const preview = await deps.store.getMediaAsset(evidence.assetId);
  const prov = isObj(preview?.provenance) ? preview!.provenance : {};
  const source = isObj(prov.sourceEditedStill) ? prov.sourceEditedStill : {};
  if (preview?.generator !== FALLBACK_GENERATOR || prov.origin !== FALLBACK_ORIGIN || prov.fallback !== true) return invalid("Only a disclosed local FFmpeg fallback preview is supported by this disclosure.");
  if (source.assetId !== still.row.asset_id || source.checksum !== still.row.checksum) return invalid("The preview is not derived from the plan's edited still.");

  return {
    status: "derived",
    disclosure:
      `The current visual is derived from the registered ${short} source frame. ` +
      `${editor} edited only the ${cupWord} existing cup surfaces to apply ${brand} branding, and the approved local FFmpeg fallback generated a deterministic motion preview. ` +
      "No new cup or product object was inserted.",
    facts: {
      planId,
      sourceFrameAssetId: media.assetId,
      editedStill: { assetId: still.row.asset_id, checksum: still.row.checksum, visualReviewId: stillReview.review_id },
      preview: { assetId: evidence.assetId, checksum: evidence.checksum, visualReviewId: evidence.visualReviewId },
      cups: cups.length,
      brand,
    },
  };
}

/** A read-only disclosure registry holding one plan's already-derived state. */
export function staticDisclosureRegistry(planId: string, state: VisualDisclosureState): VisualDisclosureRegistry {
  const frozen = structuredClone(state);
  return Object.freeze({ find: (id: string) => (id === planId ? structuredClone(frozen) : null) });
}
