import type { CustomToolDef } from "@band-ai/sdk";
import { z } from "zod";
import type { AgentRole } from "@/agents/config/roles";
import { validateDraft } from "@/agents/handoff/stamp";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
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
  schema: z.object({ titleId: z.string().min(1).max(120).describe("Catalogue title ID, e.g. hate-hypothesis") }),
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

const validateHandoffTool: CustomToolDef = {
  name: "nativeframe_validate_handoff",
  description:
    "Check a handoff envelope before sending it. Pass the exact JSON object you intend to put in the nativeframe-handoff block, without a timestamp; NativeFrame adds the timestamp when the message is sent. Returns ok or a list of problems to fix.",
  schema: z.object({ handoffJson: z.string().min(2).max(20000).describe("The handoff envelope as a JSON string") }),
  handler: (args) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(args.handoffJson));
    } catch {
      return { ok: false, errors: ["handoffJson is not valid JSON."] };
    }
    const result = validateDraft(parsed);
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
    default:
      return [validateHandoffTool];
  }
}
