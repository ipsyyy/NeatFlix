import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRedelivery } from "@/agents/band/redeliver";
import { validateHandoff } from "@/agents/handoff/envelope";
import { RELEASE_GOVERNOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE, validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { formatHandoffBlock } from "@/agents/handoff/protocol";
import { NO_REGISTERED_SOURCE_FRAMES, SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { stampOutgoingContent } from "@/agents/handoff/stamp";
import type { NewMediaAsset } from "@/agents/persistence/store";
import { PersistentSourceFrameRegistry } from "@/agents/persistence/source-frames";
import { staticFrameRegistry, WorkflowRegistry } from "@/agents/persistence/workflow";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { curatorApproval, validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const CASE = "NF-DEMO-0001";
const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
const FRAME_ID = "asset:luv-hypothesis:source-frame:luv-scene-1:v1";
const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
const FRAME_REF = "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png";
const VIDEO_SUM = `sha256:${"1".repeat(64)}`;
const FRAME_SUM = `sha256:${"2".repeat(64)}`;

const video = (over: Partial<NewMediaAsset> = {}): NewMediaAsset => ({
  asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4",
  duration_seconds: 20.064, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: VIDEO_SUM,
  provenance: { origin: "original-synthetic-source-clip", titleId: "luv-hypothesis" }, ...over,
});
const frame = (prov: Record<string, unknown> = {}, over: Partial<NewMediaAsset> = {}): NewMediaAsset => ({
  asset_id: FRAME_ID, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: FRAME_REF, mime_type: "image/png",
  duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: FRAME_SUM,
  provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: VIDEO_SUM, sceneId: "luv-scene-1", timestampSeconds: 8, ...prov },
  ...over,
});

/** A registry seeded the way production is: case, source video, and frame rows in storage. */
async function setup(frameRow: NewMediaAsset | null = frame(), videoRow: NewMediaAsset = video()) {
  const store = new MemoryWorkflowStore();
  await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
  await store.insertMediaAsset(videoRow);
  if (frameRow) await store.insertMediaAsset(frameRow);
  const workflow = new WorkflowRegistry(store);
  const frames = new PersistentSourceFrameRegistry(workflow);
  await frames.refreshScene(CASE, "luv-scene-1");
  return { store, workflow, frames };
}

const binding = (over: Record<string, unknown> = {}) => ({
  kind: "registered-source-frame", isSceneFrame: true, assetId: FRAME_ID, storageRef: FRAME_REF, checksum: FRAME_SUM,
  sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE, ...over,
});
const framePlan = (over: Record<string, unknown> = {}) => validPlacementPlan({ sourceMedia: binding(over) as PlacementPlan["sourceMedia"] });
const errorsFor = (plan: unknown, frames: Parameters<typeof validatePlacementPlan>[2]) => validatePlacementPlan(plan, CASE, frames);

describe("registered source frames in placement plans", () => {
  it("accepts a plan bound to a registered, revalidated source frame", async () => {
    const { workflow, frames } = await setup();
    assert.deepEqual(errorsFor(framePlan(), frames), []);
    const env = curatorApproval({ senderRole: "placement-director", recipientRole: "release-governor", decision: "instructions-ready", artifactId: framePlan().planId, evidence: [{ claim: "Frame is registered.", source: "nativeframe_get_source_frame.sourceMedia" }], artifact: framePlan() });
    assert.equal(validateHandoff(env, { frames }).ok, true);
    const readable = `@demo-user Plan ready; both generation prompts have not been executed. ${SOURCE_FRAME_DISCLOSURE} ${RELEASE_GOVERNOR_DISCLOSURE}`;
    assert.deepEqual(validateResult(env, readable), []);
    assert.ok(validateResult(env, readable.replace(SOURCE_FRAME_DISCLOSURE, STAND_IN_DISCLOSURE)).some((e) => e.includes(SOURCE_FRAME_DISCLOSURE)));
    assert.equal(stampOutgoingContent(`${readable}\n\n${formatHandoffBlock(env)}`, new Date(), { frames }).ok, true);
    // Storage revalidates the frame binding on save and load, with its own lookup.
    assert.equal((await workflow.savePlan(framePlan())).ok, true);
    assert.equal((await workflow.loadPlan(framePlan().planId)).ok, true);
    // Re-delivery keeps the frame statement and revalidates against the registry.
    const draft = buildRedelivery({ originalContent: `${readable}\n\n${formatHandoffBlock(env)}`, originalMessageId: "m1", expect: { senderRole: "placement-director", recipientRole: "release-governor", decision: "instructions-ready" }, recipientMention: "@rg", registries: { frames } });
    assert.ok(draft.ok && draft.draftContent.includes(SOURCE_FRAME_DISCLOSURE));
  });

  it("fails closed without a registry: a named frame is never accepted, and nothing falls back silently", () => {
    assert.ok(errorsFor(framePlan(), NO_REGISTERED_SOURCE_FRAMES).some((e) => /not a registered/.test(e)));
    assert.ok(errorsFor(framePlan(), undefined).some((e) => /not a registered/.test(e)));
  });

  it("refuses a frame from another case", async () => {
    const { frames } = await setup();
    const other = staticFrameRegistry(CASE, "luv-scene-1", { valid: { ...frames.find(FRAME_ID)!, caseId: "NF-DEMO-0002" }, invalid: false });
    assert.ok(errorsFor(framePlan(), other).some((e) => /another case/.test(e)));
  });

  it("refuses a frame from another title, in the registry and through its provenance chain", async () => {
    const { frames } = await setup();
    const other = staticFrameRegistry(CASE, "luv-scene-1", { valid: { ...frames.find(FRAME_ID)!, titleId: "not-suitable-for-professionals" }, invalid: false });
    assert.ok(errorsFor(framePlan(), other).some((e) => /another title/.test(e)));
    const wrongTitleVideo = await setup(frame(), video({ provenance: { titleId: "not-suitable-for-professionals" } }));
    assert.deepEqual(wrongTitleVideo.frames.forScene(CASE, "luv-scene-1"), { valid: null, invalid: true });
  });

  it("refuses a frame from another scene", async () => {
    const { workflow } = await setup(frame({ sceneId: "luv-scene-2", timestampSeconds: 5 }, { asset_id: "asset:luv-hypothesis:source-frame:luv-scene-2:v1", storage_ref: "storage://nf-media/frames/luv-hypothesis/luv-scene-2-5s.png" }));
    const frames = new PersistentSourceFrameRegistry(workflow);
    await frames.refreshScene(CASE, "luv-scene-2");
    await frames.refreshScene(CASE, "luv-scene-1");
    const plan = framePlan({ assetId: "asset:luv-hypothesis:source-frame:luv-scene-2:v1", storageRef: "storage://nf-media/frames/luv-hypothesis/luv-scene-2-5s.png", timestampSeconds: 5 });
    assert.ok(errorsFor(plan, frames).some((e) => /not extracted from the selected scene/.test(e)));
  });

  it("treats a frame timestamped outside the scene window as invalid, blocking both the frame and the stand-in", async () => {
    const { frames } = await setup(frame({ timestampSeconds: 12 }));
    assert.deepEqual(frames.forScene(CASE, "luv-scene-1"), { valid: null, invalid: true });
    assert.ok(errorsFor(framePlan({ timestampSeconds: 12 }), frames).some((e) => /not a registered/.test(e)));
    assert.ok(errorsFor(validPlacementPlan(), frames).some((e) => /failed validation; the plan is blocked/.test(e)), "no silent stand-in fallback");
  });

  it("treats a frame whose source-video provenance does not match as invalid", async () => {
    for (const prov of [{ sourceChecksum: `sha256:${"9".repeat(64)}` }, { sourceStorageRef: "storage://nf-media/other.mp4" }, { sourceAssetId: "asset:luv-hypothesis:source-video:v9" }]) {
      const { frames } = await setup(frame(prov));
      assert.deepEqual(frames.forScene(CASE, "luv-scene-1"), { valid: null, invalid: true }, JSON.stringify(prov));
    }
  });

  it("refuses arbitrary URLs, public URLs, file paths, inline data, and extra caller-supplied fields", async () => {
    const { frames } = await setup();
    for (const storageRef of ["https://cdn.example.com/f.png", "http://x/f.png", "/Users/me/f.png", "file:///tmp/f.png", "data:image/png;base64,iVBORw0KGgo=", "storage://nf-media/../secret.png"]) {
      assert.ok(errorsFor(framePlan({ storageRef }), frames).some((e) => /private storage:\/\/ reference/.test(e)), storageRef);
    }
    assert.ok(errorsFor(framePlan({ url: "https://evil.example.com/f.png" }), frames).some((e) => /must have exactly/.test(e)));
    assert.ok(errorsFor(framePlan({ assetId: "https://evil.example.com/f.png" }), frames).some((e) => /source-frame asset ID/.test(e)));
    assert.ok(errorsFor(framePlan({ isSceneFrame: false }), frames).length > 0);
  });

  it("refuses a frame missing from the registry", async () => {
    const { frames } = await setup(null);
    assert.ok(errorsFor(framePlan(), frames).some((e) => /not a registered/.test(e)));
  });

  it("refuses a checksum, storage-reference, timestamp, or source mismatch with the registered frame", async () => {
    const { frames } = await setup();
    assert.ok(errorsFor(framePlan({ checksum: `sha256:${"3".repeat(64)}` }), frames).some((e) => /checksum does not match/.test(e)));
    assert.ok(errorsFor(framePlan({ storageRef: "storage://nf-media/frames/luv-hypothesis/other.png" }), frames).some((e) => /storageRef does not match/.test(e)));
    assert.ok(errorsFor(framePlan({ timestampSeconds: 9 }), frames).some((e) => /timestampSeconds does not match/.test(e)));
    assert.ok(errorsFor(framePlan({ sourceAssetId: "asset:luv-hypothesis:source-video:v2" }), frames).some((e) => /registered source video/.test(e)));
  });

  it("keeps the stand-in route unchanged when no frame is registered, and requires the frame when one is", async () => {
    assert.deepEqual(validatePlacementPlan(validPlacementPlan(), CASE), []);
    const none = await setup(null);
    assert.deepEqual(none.frames.forScene(CASE, "luv-scene-1"), { valid: null, invalid: false });
    assert.deepEqual(errorsFor(validPlacementPlan(), none.frames), []);
    const registered = await setup();
    assert.ok(errorsFor(validPlacementPlan(), registered.frames).some((e) => /bind it instead of the stand-in/.test(e)));
  });

  it("fails closed when the registry cannot be read", async () => {
    class DownStore extends MemoryWorkflowStore {
      override async listMediaAssetsForCase(): Promise<never> {
        throw new Error("network down");
      }
    }
    const frames = new PersistentSourceFrameRegistry(new WorkflowRegistry(new DownStore()));
    assert.deepEqual(await frames.refreshScene(CASE, "luv-scene-1"), { valid: null, invalid: true });
    assert.ok(errorsFor(validPlacementPlan(), frames).some((e) => /blocked/.test(e)));
  });
});

describe("nativeframe_get_source_frame", () => {
  const tool = (frames?: PersistentSourceFrameRegistry) => toolsForRole("placement-director", { frames }).find((t) => t.name === "nativeframe_get_source_frame")!;

  it("returns exact binding fields for a registered frame", async () => {
    const { frames } = await setup();
    const r = (await tool(frames).handler({ caseId: CASE, sceneId: "luv-scene-1" })) as { status: string; sourceMedia: unknown };
    assert.equal(r.status, "registered");
    assert.deepEqual(r.sourceMedia, binding());
  });

  it("says none without a registry or frame, and invalid (block) for a bad frame", async () => {
    assert.equal(((await tool().handler({ caseId: CASE, sceneId: "luv-scene-1" })) as { status: string }).status, "none");
    assert.equal(((await tool((await setup(null)).frames).handler({ caseId: CASE, sceneId: "luv-scene-1" })) as { status: string }).status, "none");
    const bad = (await tool((await setup(frame({ timestampSeconds: 12 }))).frames).handler({ caseId: CASE, sceneId: "luv-scene-1" })) as { status: string; message: string };
    assert.equal(bad.status, "invalid");
    assert.match(bad.message, /blocked/);
  });
});

