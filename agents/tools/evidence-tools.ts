import type { CustomToolDef } from "@band-ai/sdk";
import { openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AgentRole } from "@/agents/config/roles";
import { NO_GENERATED_PREVIEWS, type PreviewRegistry } from "@/agents/handoff/governor-review";
import { validatePlacementPlan } from "@/agents/handoff/placement-plan";
import { NO_REGISTERED_SOURCE_FRAMES, SOURCE_FRAME_DISCLOSURE, type RefreshableSourceFrameRegistry, type SourceFrameRegistry } from "@/agents/handoff/source-frames";
import { validateDraft } from "@/agents/handoff/stamp";
import { NO_PREVIEW_DETAIL, type PreviewEvidence, type PreviewEvidenceSource } from "@/agents/media/preview-evidence";
import { inMemoryAcceptedPlans, type AcceptedPlanRegistry } from "@/agents/runtime/accepted-plans";
import { currentTurnScope } from "@/agents/runtime/turn-scope";
import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { matchCampaignToScene } from "@/lib/campaigns/matching";
import { canStartPlacementReview, getEligibility } from "@/lib/catalogue/eligibility";

/**
 * Read-only evidence tools backed by NativeFrame's typed fixtures. They give
 * agents real records to cite instead of asking Claude to recall facts.
 * Every result is labelled as a demo fixture (§3, §7.1 Honest).
 */

const SOURCE_NOTE = "Demo fixture from the NativeFrame catalogue. Fictional data, not real rights or viewer records.";

function findTitle(query: string) {
  const q = query.trim().toLowerCase();
  return catalogue.find((t) => t.id === q || t.title.toLowerCase() === q) ?? null;
}

const getTitleRecord: CustomToolDef = {
  name: "nativeframe_get_title_record",
  description:
    "Look up a catalogue title by ID or exact title. Returns rights, sensitivity, actor restrictions, rating, pipeline status, and the catalogue's eligibility result with reasons.",
  schema: z.object({ title: z.string().min(1).max(120).describe("Catalogue title ID or exact title") }),
  handler: (args) => {
    const title = findTitle(String(args.title));
    if (!title) return { found: false, message: "No catalogue title matches that ID or name." };
    const eligibility = getEligibility(title);
    return {
      found: true,
      source: SOURCE_NOTE,
      record: {
        id: title.id,
        title: title.title,
        genre: title.genre,
        tone: title.tone,
        rating: title.rating,
        rightsStatus: title.rightsStatus,
        actorRestriction: title.actorRestriction,
        contentSensitivity: title.contentSensitivity,
        processingStatus: title.processingStatus,
        durationSeconds: title.durationSeconds,
        pipelineEnabled: title.pipelineEnabled,
      },
      eligibility: {
        eligible: eligibility.eligible,
        reasons: eligibility.reasons,
        placementReviewAllowed: canStartPlacementReview(title),
      },
    };
  },
};

const getSceneCandidates: CustomToolDef = {
  name: "nativeframe_get_scene_candidates",
  description:
    "List the candidate scenes recorded for a title, with timestamps, tone, camera, surface, natural placement opportunities, and guardrail checks with evidence.",
  schema: z.object({ titleId: z.string().min(1).max(120).describe("Catalogue title ID, e.g. luv-hypothesis") }),
  handler: (args) => {
    const title = findTitle(String(args.titleId));
    const review = title ? getSceneReview(title.id) : undefined;
    if (!title || !review) return { found: false, message: "No scene candidates are recorded for that title." };
    return {
      found: true,
      source: `${SOURCE_NOTE} Scene records are hand-authored stand-ins until real scene analysis is connected.`,
      titleId: title.id,
      titleDurationSeconds: title.durationSeconds,
      scenes: review.scenes.map((s) => ({
        id: s.id,
        name: s.name,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        tone: s.tone,
        camera: s.camera,
        surface: s.surface,
        opportunities: s.opportunities,
        checks: s.checks,
      })),
    };
  },
};

/** Finds a recorded scene and its title across every scene review. */
function findScene(sceneId: string) {
  const id = sceneId.trim().toLowerCase();
  for (const title of catalogue) {
    const scene = getSceneReview(title.id)?.scenes.find((s) => s.id === id);
    if (scene) return { title, scene };
  }
  return null;
}

function findCampaign(campaignId: string) {
  const id = campaignId.trim().toLowerCase();
  return campaigns.find((c) => c.id === id || c.product.toLowerCase() === id) ?? null;
}

const AUDIENCE_NOTE =
  "Subscriber records are not connected. Audience eligibility is rule-based: these are the campaign's audience rules, not counted or targeted viewers.";

const getSelectedScene: CustomToolDef = {
  name: "nativeframe_get_selected_scene",
  description:
    "Look up the scene selected in the Scene Scout handoff by scene ID (for example luv-scene-1). Returns its title, timestamps, tone, camera, surface, natural placement objects, and guardrail checks.",
  schema: z.object({ sceneId: z.string().min(1).max(60).describe("Scene ID from the Scene Scout handoff artifactId") }),
  handler: (args) => {
    const found = findScene(String(args.sceneId));
    if (!found) return { found: false, message: "No recorded scene has that ID." };
    const { title, scene } = found;
    return {
      found: true,
      source: `${SOURCE_NOTE} Scene records are hand-authored stand-ins until real scene analysis is connected.`,
      titleId: title.id,
      title: title.title,
      scene: {
        id: scene.id,
        name: scene.name,
        startSeconds: scene.startSeconds,
        endSeconds: scene.endSeconds,
        durationSeconds: scene.endSeconds - scene.startSeconds,
        decision: scene.decision,
        tone: scene.tone,
        camera: scene.camera,
        surface: scene.surface,
        opportunities: scene.opportunities,
        checks: scene.checks,
      },
    };
  },
};

const getCampaign: CustomToolDef = {
  name: "nativeframe_get_campaign",
  description:
    "Look up an advertiser campaign by campaign ID or product name. Returns the brief, product format, category, market, audience rules, brand-safety risk, placement length, and the fixture's stated assumptions.",
  schema: z.object({ campaignId: z.string().min(1).max(120).describe("Campaign ID (e.g. daybreak-cold-brew) or product name") }),
  handler: (args) => {
    const campaign = findCampaign(String(args.campaignId));
    if (!campaign) return { found: false, message: "No campaign matches that ID or product.", available: campaigns.map((c) => c.id) };
    return { found: true, source: `${SOURCE_NOTE} ${AUDIENCE_NOTE}`, campaign };
  },
};

const evaluateCampaignMatch: CustomToolDef = {
  name: "nativeframe_evaluate_campaign_match",
  description:
    "Run NativeFrame's deterministic campaign-matching rules for a scene and campaign: audience (age, tier, premium and minor exclusions, market), scene-to-product fit (object, surface, tone, framing, faces, placement length), and brand safety. Returns every check with evidence and the rule decision.",
  schema: z.object({
    sceneId: z.string().min(1).max(60).describe("Scene ID, e.g. luv-scene-1"),
    campaignId: z.string().min(1).max(120).describe("Campaign ID, e.g. daybreak-cold-brew"),
  }),
  handler: (args) => {
    const found = findScene(String(args.sceneId));
    const campaign = findCampaign(String(args.campaignId));
    if (!found || !campaign) return { found: false, message: "Unknown scene or campaign ID." };
    const match = matchCampaignToScene(campaign, found.scene, found.title);
    return {
      found: true,
      source: `Deterministic NativeFrame matching rules over demo fixtures. ${AUDIENCE_NOTE}`,
      product: campaign.product,
      placementObject: campaign.placementObject,
      productFormat: campaign.productFormat,
      surface: found.scene.surface,
      ...match,
    };
  },
};

/** Reads width and height from a PNG file's IHDR header (no image decoding). */
function pngDimensions(file: string): { widthPx: number; heightPx: number } | null {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(24);
    readSync(fd, header, 0, 24, 0);
    if (header.toString("latin1", 1, 4) !== "PNG" || header.toString("latin1", 12, 16) !== "IHDR") return null;
    return { widthPx: header.readUInt32BE(16), heightPx: header.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

const getSourceArtwork: CustomToolDef = {
  name: "nativeframe_get_source_artwork",
  description:
    "Look up the approved source artwork for a title: its file path, real pixel dimensions, description, and framing hints. It is title artwork, not a frame from the selected scene.",
  schema: z.object({ titleId: z.string().min(1).max(120).describe("Catalogue title ID, e.g. luv-hypothesis") }),
  handler: (args) => {
    const title = findTitle(String(args.titleId));
    if (!title || title.artwork.kind !== "image") return { found: false, message: "No approved image artwork for that title." };
    const dims = pngDimensions(resolve(process.cwd(), "public", title.artwork.src.replace(/^\//, "")));
    return {
      found: true,
      source: "Approved original title artwork in the NativeFrame catalogue.",
      titleId: title.id,
      kind: "title-artwork-stand-in",
      isSceneFrame: false,
      src: title.artwork.src,
      alt: title.artwork.alt,
      ...(dims ?? {}),
      framing: title.artwork.position,
      note: "This is approved title artwork used as a stand-in. No frame from the selected scene has been extracted, and no video exists yet.",
    };
  },
};

function validateHandoffTool(previews: PreviewRegistry = NO_GENERATED_PREVIEWS, frames: SourceFrameRegistry = NO_REGISTERED_SOURCE_FRAMES): CustomToolDef {
  return {
    name: "nativeframe_validate_handoff",
    description:
      "Check a handoff envelope before sending it. Pass the exact JSON object you intend to put in the nativeframe-handoff block, without a timestamp; NativeFrame adds the timestamp when the message is sent. Also pass readableText, the exact text you will send outside the block, so required sentences are checked too. Returns ok or every problem to fix.",
    schema: z.object({
      handoffJson: z.string().min(2).max(20000).describe("The handoff envelope as a JSON string"),
      readableText: z.string().max(8000).optional().describe("The readable message text you will send outside the handoff block"),
    }),
    handler: (args) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(args.handoffJson));
      } catch {
        return { ok: false, errors: ["handoffJson is not valid JSON."] };
      }
      const readable = typeof args.readableText === "string" ? args.readableText.trim() : undefined;
      const result = validateDraft(parsed, new Date(), readable, previews, frames);
      return result.ok
        ? { ok: true, note: "Timestamp is attached by NativeFrame at send time." }
        : { ok: false, errors: result.errors };
    },
  };
}

/**
 * The preview technical check. Without a verified evidence source a registered
 * preview can never pass: it fails closed. Not-evaluated only without a preview.
 */
async function previewCheck(planId: string, previews: PreviewRegistry, evidence?: PreviewEvidenceSource): Promise<PreviewEvidence> {
  if (evidence) return evidence(planId);
  return previews.find(planId)
    ? { outcome: "fail", detail: "A generated preview is registered for this plan, but no verified evidence source is configured, so it is not evidence.", assetId: null, checksum: null, visualReviewId: null }
    : { outcome: "not-evaluated", detail: NO_PREVIEW_DETAIL, assetId: null, checksum: null, visualReviewId: null };
}

/**
 * Release Governor: re-runs NativeFrame's deterministic rules over the plan in
 * the Placement Director handoff, and reports the preview technical check from
 * verified evidence: the registered preview's revalidation and the human
 * owner's recorded visual review of its exact bytes.
 */
function checkPlacementPlanTool(plans: AcceptedPlanRegistry, frames: SourceFrameRegistry, previews: PreviewRegistry, evidence?: PreviewEvidenceSource): CustomToolDef {
  return {
    name: "nativeframe_check_placement_plan",
    description:
      "Run NativeFrame's deterministic checks over the placement plan you received from the authenticated Placement Director, looked up by its planId: plan schema and safety rules, title eligibility, scene guardrails, campaign match, and unexecuted prompts; plus the preview-visual-quality technical check, which passes only when the plan's registered generated preview revalidates and the human owner's recorded visual review of its exact bytes is approved, and is not-evaluated when no preview is registered.",
    schema: z.object({ planId: z.string().min(1).max(200).describe("The planId (handoff artifactId) from the Placement Director handoff") }),
    handler: async (args) => {
      const accepted = await plans.lookup(String(args.planId).trim());
      if (!accepted) return { found: false, message: "No authenticated Placement Director plan with that planId was received." };
      const plan = accepted as unknown as Record<string, unknown>;
      const get = (o: unknown, k: string) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined);
      const titleId = String(get(plan.sourceArtifacts, "titleId") ?? "");
      const sceneId = String(get(plan.scene, "sceneId") ?? "");
      const campaignId = String(get(plan.product, "campaignId") ?? "");
      const title = findTitle(titleId);
      const found = findScene(sceneId);
      const campaign = findCampaign(campaignId);
      const planErrors = validatePlacementPlan(plan, typeof plan.caseId === "string" ? plan.caseId : undefined, frames);
      const match = found && campaign ? matchCampaignToScene(campaign, found.scene, found.title) : null;
      const prompts = get(plan, "prompts");
      const unexecuted = ["stillImageEdit", "motion"].every((k) => get(get(prompts, k), "status") === "not-executed");
      const eligible = title ? getEligibility(title).eligible && canStartPlacementReview(title) : false;
      const outcome = (ok: boolean) => (ok ? "pass" : "fail");
      const preview = await previewCheck(String(plan.planId ?? ""), previews, evidence);
      return {
        found: true,
        source:
          "Deterministic NativeFrame rules over the authenticated Placement Director plan and demo fixtures, plus the media registry's revalidation of the plan's generated preview and the human owner's recorded visual review. The Release Governor does not view media itself.",
        subject: { titleId, sceneId, campaignId, planId: plan.planId ?? null },
        checks: [
          { id: "plan-rules", category: "policy", outcome: outcome(planErrors.length === 0), detail: planErrors.length === 0 ? "Plan meets every schema and safety rule." : planErrors.slice(0, 10).join(" ") },
          { id: "title-eligibility", category: "policy", outcome: outcome(eligible), detail: title ? (eligible ? "Title is eligible and pipeline-enabled." : getEligibility(title).reasons.join(" ") || "Title is not pipeline-enabled.") : "Unknown title." },
          { id: "scene-guardrails", category: "policy", outcome: outcome(Boolean(found?.scene.checks.every((c) => c.outcome === "pass"))), detail: found ? found.scene.checks.map((c) => `${c.id}: ${c.outcome}`).join("; ") : "Unknown scene." },
          { id: "campaign-match", category: "policy", outcome: outcome(match?.decision === "recommended"), detail: match ? `${match.decision}: ${match.summary}` : "Unknown scene or campaign." },
          { id: "prompts-not-executed", category: "policy", outcome: outcome(unexecuted), detail: unexecuted ? "Both generation prompts are labelled not-executed." : "A generation prompt is not labelled not-executed." },
          { id: "preview-visual-quality", category: "technical", outcome: preview.outcome, detail: preview.detail },
        ],
        preview: { assetId: preview.assetId, checksum: preview.checksum, visualReviewId: preview.visualReviewId },
      };
    },
  };
}

/** Release Governor: reports whether the media pipeline has recorded a generated preview for a plan. */
export function previewStatusTool(previews: PreviewRegistry = NO_GENERATED_PREVIEWS): CustomToolDef {
  return {
    name: "nativeframe_get_preview_status",
    description:
      "Look up the generated preview recorded for a placement plan ID: its asset reference, provenance, and generation metadata. Reports when no preview exists.",
    schema: z.object({ planId: z.string().min(1).max(200).describe("The planId from the Placement Director handoff") }),
    handler: (args) => {
      const record = previews.find(String(args.planId).trim());
      if (!record) {
        return {
          found: true,
          source: "NativeFrame preview registry.",
          planId: String(args.planId).trim(),
          previewExists: false,
          assetRef: null,
          provenance: null,
          generationMetadata: null,
          note: "No generated preview is registered for this plan, so there is nothing to evaluate.",
        };
      }
      return { found: true, source: "NativeFrame preview registry.", previewExists: true, ...record };
    },
  };
}

/**
 * Stores the Release Governor's tools read from: plans accepted at its gate, the
 * preview registry, and the verified preview evidence source. Defaults hold no
 * persisted data, no previews, and no evidence source.
 */
export type GovernorToolStores = { plans?: AcceptedPlanRegistry; previews?: PreviewRegistry; frames?: RefreshableSourceFrameRegistry; previewEvidence?: PreviewEvidenceSource };

/** The only answer for a case or scene outside the current authenticated handoff; it reveals nothing about them. */
export const FRAME_NOT_AVAILABLE = { found: false, status: "not-available", message: "Not available for this handoff." } as const;

/**
 * Placement Director: looks up the registered, revalidated source frame for
 * the scene of the authenticated handoff this turn is acting on (turn-scope.ts).
 * Arguments must name that same case and scene; they never select, refresh, or
 * reveal any other. Returns exact binding fields to copy into the plan, says
 * when none is registered (use the stand-in), and blocks when a registered
 * frame is invalid.
 */
function sourceFrameTool(frames: RefreshableSourceFrameRegistry | undefined): CustomToolDef {
  return {
    name: "nativeframe_get_source_frame",
    description:
      "Look up the registered source frame for the selected scene of the handoff you are acting on (pass its caseId and scene ID). If one is registered and valid, returns the exact sourceMedia fields to bind in the plan. If none is registered, use the approved title-artwork stand-in. If a registered frame fails validation, the plan must be blocked.",
    schema: z.object({
      caseId: z.string().min(1).max(100).describe("The caseId from the handoff"),
      sceneId: z.string().min(1).max(60).describe("The selected scene ID, e.g. luv-scene-1"),
    }),
    handler: async (args) => {
      const scope = currentTurnScope();
      if (!scope || String(args.caseId).trim() !== scope.caseId || String(args.sceneId).trim() !== scope.sceneId) return FRAME_NOT_AVAILABLE;
      if (!frames) return { found: false, status: "none", message: "No source-frame registry is configured; use the approved title-artwork stand-in." };
      const state = await frames.refreshScene(scope.caseId, scope.sceneId);
      if (state.invalid) {
        return { found: false, status: "invalid", message: "A registered source frame for this scene failed validation. Decide \"blocked\"; do not use the stand-in." };
      }
      if (!state.valid) return { found: false, status: "none", message: "No source frame is registered for this scene; use the approved title-artwork stand-in." };
      const f = state.valid;
      return {
        found: true,
        status: "registered",
        source: "NativeFrame media registry (revalidated: source video, case, title, scene window, private storage, checksum).",
        sourceMedia: {
          kind: "registered-source-frame",
          isSceneFrame: true,
          assetId: f.assetId,
          storageRef: f.storageRef,
          checksum: f.checksum,
          sourceAssetId: f.sourceAssetId,
          timestampSeconds: f.timestampSeconds,
          note: SOURCE_FRAME_DISCLOSURE,
        },
        mimeType: f.mimeType,
        note: "Copy sourceMedia into the plan exactly. The frame is unedited; no generation has been run on it.",
      };
    },
  };
}

/** Tools each role may use. Downstream roles get evidence for their own step only. */
export function toolsForRole(role: AgentRole, stores: GovernorToolStores = {}): CustomToolDef[] {
  switch (role) {
    case "content-curator":
      return [getTitleRecord, validateHandoffTool()];
    case "scene-scout":
      return [getSceneCandidates, validateHandoffTool()];
    case "campaign-matcher":
      return [getSelectedScene, getCampaign, evaluateCampaignMatch, validateHandoffTool()];
    case "placement-director":
      return [getSelectedScene, getCampaign, getSourceArtwork, sourceFrameTool(stores.frames), validateHandoffTool(NO_GENERATED_PREVIEWS, stores.frames)];
    case "release-governor": {
      const previews = stores.previews ?? NO_GENERATED_PREVIEWS;
      return [checkPlacementPlanTool(stores.plans ?? inMemoryAcceptedPlans, stores.frames ?? NO_REGISTERED_SOURCE_FRAMES, previews, stores.previewEvidence), previewStatusTool(previews), validateHandoffTool(previews)];
    }
    default:
      return [validateHandoffTool()];
  }
}
