import type { CustomToolDef } from "@band-ai/sdk";
import { openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AgentRole } from "@/agents/config/roles";
import { validateDraft } from "@/agents/handoff/stamp";
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

const validateHandoffTool: CustomToolDef = {
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
    const result = validateDraft(parsed, new Date(), readable);
    return result.ok
      ? { ok: true, note: "Timestamp is attached by NativeFrame at send time." }
      : { ok: false, errors: result.errors };
  },
};

/** Tools each role may use. Downstream roles get evidence for their own step only. */
export function toolsForRole(role: AgentRole): CustomToolDef[] {
  switch (role) {
    case "content-curator":
      return [getTitleRecord, validateHandoffTool];
    case "scene-scout":
      return [getSceneCandidates, validateHandoffTool];
    case "campaign-matcher":
      return [getSelectedScene, getCampaign, evaluateCampaignMatch, validateHandoffTool];
    case "placement-director":
      return [getSelectedScene, getCampaign, getSourceArtwork, validateHandoffTool];
    default:
      return [validateHandoffTool];
  }
}
