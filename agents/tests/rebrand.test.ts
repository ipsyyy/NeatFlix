import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { loadVerifiedEditedStill, sha256Hex } from "@/agents/media/edited-still";
import type { ImageEditProvider, ProviderEditResult } from "@/agents/media/gemini-provider";
import { buildLuvRebrandPlanV3, buildRevisedPlan, LUV_PLAN_V2, LUV_PLAN_V3 } from "@/agents/media/plan-revisions";
import { executeStillEdit, type StillEditRequest } from "@/agents/media/still-edit";
import { currentVisualDecision, recordVisualReview } from "@/agents/media/visual-review";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { IntegrityError } from "@/agents/persistence/store";
import { canonical, WorkflowRegistry } from "@/agents/persistence/workflow";
import { validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const v1Plan = () => validPlacementPlan();
const v3Plan = () => buildLuvRebrandPlanV3(buildRevisedPlan(v1Plan(), LUV_PLAN_V2));
const errors = (plan: PlacementPlan) => validatePlacementPlan(plan, "NF-DEMO-0001");
const withRebrand = (patch: (p: PlacementPlan) => void) => {
  const p = v3Plan();
  patch(p);
  return errors(p);
};
const withStill = (prompt: string) => withRebrand((p) => (p.prompts.stillImageEdit.prompt = `${LUV_PLAN_V3.stillPrompt} ${prompt}`));

describe("LUV Daybreak rebrand strategy (plan v3)", () => {
  it("accepts exactly the original two cups with only their surface branding changed", () => {
    assert.deepEqual(errors(v3Plan()), []);
    const p = v3Plan();
    assert.equal(p.placement.mode, "rebrand-existing-cups");
    assert.deepEqual(p.rebrand && { b: p.rebrand.cupsBefore, a: p.rebrand.cupsAfter, add: p.rebrand.addedObjects, ids: p.rebrand.cups.map((c) => c.id) }, { b: 2, a: 2, add: 0, ids: ["man-cup", "woman-cup"] });
    assert.equal(p.prompts.stillImageEdit.status, "not-executed");
  });

  it("rejects a third inserted cup, in the specification or the prompt", () => {
    assert.ok(withRebrand((p) => (p.rebrand!.addedObjects = 1)).some((e) => /addedObjects must be 0/.test(e)));
    assert.ok(withRebrand((p) => (p.rebrand!.cupsAfter = 3)).some((e) => /exactly the two original cups/.test(e)));
    assert.ok(withStill("Then add one more Daybreak Cold Brew cup at the front-right corner.").some((e) => /Do not add any cup/.test(e)));
    assert.ok(withStill("Include a third cup for brand prominence.").some((e) => /Do not add any cup/.test(e)));
    assert.ok(withRebrand((p) => (p.placement.description = "Place a new branded cup near the edge of the table.")).some((e) => /Do not add any cup/.test(e)));
  });

  it("rejects branding only one of the existing cups", () => {
    assert.ok(withRebrand((p) => ((p.rebrand!.cups[1] as { branded: boolean }).branded = false)).some((e) => /woman-cup must be rebranded/.test(e)));
    assert.ok(withRebrand((p) => (p.rebrand!.cups = [p.rebrand!.cups[0]])).some((e) => /exactly man-cup and woman-cup/.test(e)));
  });

  it("rejects a cup that is moved, resized, removed, reshaped, or duplicated", () => {
    for (const [k, v] of [["position", "moved"], ["size", "larger"], ["shape", "taller"], ["lid", "new"]] as const) {
      assert.ok(withRebrand((p) => ((p.rebrand!.cups[0] as unknown as Record<string, string>)[k] = v)).some((e) => e.includes(`man-cup.${k}`)), k);
    }
    assert.ok(withRebrand((p) => (p.rebrand!.cups = [p.rebrand!.cups[0], { ...p.rebrand!.cups[0] }])).some((e) => /each once/.test(e)), "duplicated");
    assert.ok(withStill("Move the man's cup slightly toward the plate.").some((e) => /must not move or change shape/.test(e)));
    assert.ok(withStill("Resize both cups so the logo is larger.").some((e) => /must not move or change shape/.test(e)));
    assert.ok(withStill("Remove the woman's cup.").some((e) => /must not move or change shape/.test(e)));
  });

  it("rejects a straw that disappears or moves", () => {
    assert.ok(withRebrand((p) => ((p.rebrand!.cups[1] as unknown as Record<string, string>).straw = "removed")).some((e) => /straw must stay/.test(e)));
    assert.ok(withRebrand((p) => ((p.rebrand!.cups[0] as unknown as Record<string, string>).straw = "unchanged")).some((e) => /no straw/.test(e)), "no straw may be added");
    assert.ok(withStill("Remove the straw from the woman's cup.").some((e) => /must not move or change shape/.test(e)));
    assert.ok(withRebrand((p) => (p.negativeConstraints = p.negativeConstraints.filter((c) => !/straw/i.test(c)))).some((e) => /protect the woman's straw/.test(e)));
  });

  it("rejects actor or clothing changes", () => {
    assert.ok(withStill("Change the man's expression to a smile.").some((e) => /Actors and clothing must not change/.test(e)));
    assert.ok(withStill("Alter the woman's sweater colour to match the brand.").some((e) => /Actors and clothing must not change/.test(e)));
    assert.ok(withRebrand((p) => (p.preservation.faces = ["Keep both faces."])).some((e) => /mouths and expressions/.test(e)));
    assert.ok(withRebrand((p) => (p.preservation.bodies = ["Keep both poses."])).some((e) => /hands, arms, and clothing/.test(e)));
  });

  it("applies narrowly: v3+ for this campaign and scene must rebrand; v1/v2 keep their rules; other plans cannot claim it", () => {
    const insertV3 = v1Plan();
    insertV3.planId = "plan:daybreak-cold-brew:luv-scene-1:v3";
    assert.ok(errors(insertV3).some((e) => /must be "rebrand-existing-cups"/.test(e)), "an insertion plan at v3 is refused");
    assert.deepEqual(errors(v1Plan()), [], "v1 insertion plan still validates");
    assert.deepEqual(errors(buildRevisedPlan(v1Plan(), LUV_PLAN_V2)), [], "v2 insertion plan still validates");
    const otherScene = v3Plan();
    otherScene.scene = { ...otherScene.scene, sceneId: "luv-scene-2" };
    assert.ok(errors(otherScene).some((e) => /Only the LUV Daybreak/.test(e)));
  });
});

describe("v1, v2, and v3 isolation and immutability", () => {
  const CASE = "NF-DEMO-0001";
  const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
  const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
  const VIDEO_SUM = `sha256:${"1".repeat(64)}`;
  const FRAME_ID = "asset:luv-hypothesis:source-frame:luv-scene-1:v1";
  const FRAME_REF = "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png";
  const target = (v: string): StillEditRequest => ({
    planId: `plan:daybreak-cold-brew:luv-scene-1:${v}`, sourceFrameAssetId: FRAME_ID, sourceFrameStorageRef: FRAME_REF,
    outputAssetId: `asset:luv-hypothesis:edited-still:luv-scene-1:${v}`, outputStorageRef: `storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-${v}/edited-still-${v}.png`,
  });
  const image = (w: number, h: number, shade: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: shade, g: 90, b: 60 } } }).png().toBuffer();
  const storage = (): PrivateStorage & { objects: Map<string, Uint8Array> } => {
    const objects = new Map<string, Uint8Array>();
    return { objects, download: async (r) => objects.get(r) ?? null, uploadNew: async (r, b) => (objects.has(r) ? "exists" : (objects.set(r, new Uint8Array(b)), "created")) };
  };
  const provider = (shade: number): ImageEditProvider & { prompts: string[] } => {
    const prompts: string[] = [];
    return { provider: "google-gemini", model: "gemini-nano-banana-2.1", prompts, edit: async (i): Promise<ProviderEditResult> => (prompts.push(i.prompt), { responseId: `r-${shade}`, images: [{ mimeType: "image/png", data: await image(1376, 768, shade) }], text: null, usage: null }) };
  };
  const OWNER = { id: "owner-user", type: "User", role: null, name: "NativeFrame project owner" };

  it("keeps each version's plan, prompt, still, and review separate and immutable", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = new WorkflowRegistry(store);
    const s = storage();
    const frame = await image(1280, 720, 120);
    const frameSum = `sha256:${sha256Hex(frame)}`;
    await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
    await store.insertMediaAsset({ asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4", duration_seconds: 20.064, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: VIDEO_SUM, provenance: { titleId: "luv-hypothesis" } });
    await store.insertMediaAsset({ asset_id: FRAME_ID, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: FRAME_REF, mime_type: "image/png", duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: frameSum, provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: VIDEO_SUM, sceneId: "luv-scene-1", timestampSeconds: 8 } });
    s.objects.set(FRAME_REF, frame);
    const v1 = validPlacementPlan({ sourceMedia: { kind: "registered-source-frame", isSceneFrame: true, assetId: FRAME_ID, storageRef: FRAME_REF, checksum: frameSum, sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE } as PlacementPlan["sourceMedia"] });
    const v2 = buildRevisedPlan(v1, LUV_PLAN_V2);
    const v3 = buildLuvRebrandPlanV3(v2);
    for (const p of [v1, v2, v3]) assert.equal((await workflow.savePlan(p)).ok, true, p.planId);
    const shades: Record<string, number> = { v1: 150, v2: 60, v3: 200 };
    for (const v of ["v1", "v2", "v3"]) {
      const p = provider(shades[v]);
      const r = await executeStillEdit(target(v), { workflow, store, storage: s, provider: p });
      assert.ok(r.ok, `${v}: ${JSON.stringify(r)}`);
    }
    for (const v of ["v1", "v2"]) {
      const r = await recordVisualReview({ workflow, store, assetId: target(v).outputAssetId, decision: "rejected", reasons: [`${v} rejected`], reviewer: OWNER, ownerUserId: OWNER.id });
      assert.ok(r.ok);
    }
    const hashes = new Set<string>();
    for (const [v, plan] of [["v1", v1], ["v2", v2], ["v3", v3]] as const) {
      const loaded = await workflow.loadPlan(plan.planId);
      assert.ok(loaded.ok && canonical(loaded.value) === canonical(plan), `${v} plan unchanged`);
      const still = await loadVerifiedEditedStill(workflow, store, target(v).outputAssetId);
      assert.ok(still.ok && still.row.plan_id === plan.planId, `${v} still bound to its own plan`);
      const promptHash = (still as Extract<typeof still, { ok: true }>).context.promptSha256;
      assert.equal(promptHash, sha256Hex(plan.prompts.stillImageEdit.prompt));
      hashes.add(promptHash);
    }
    assert.equal(hashes.size, 3, "three distinct prompts");
    assert.equal(await currentVisualDecision(store, target("v1").outputAssetId), "rejected");
    assert.equal(await currentVisualDecision(store, target("v2").outputAssetId), "rejected");
    assert.equal(await currentVisualDecision(store, target("v3").outputAssetId), "pending");
    for (const v of ["v1", "v2"]) await assert.rejects(store.updateMediaAsset(target(v).outputAssetId, { mime_type: "image/png" }), IntegrityError, `${v} immutable`);
    assert.equal((await workflow.savePlan({ ...v3, assumptions: [] })).ok, false, "a different v3 cannot replace the stored v3");
  });
});
