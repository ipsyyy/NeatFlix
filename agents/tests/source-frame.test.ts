import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRedelivery } from "@/agents/band/redeliver";
import { validateHandoff } from "@/agents/handoff/envelope";
import { RELEASE_GOVERNOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE, validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { formatHandoffBlock } from "@/agents/handoff/protocol";
import { NO_REGISTERED_SOURCE_FRAMES, SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { stampOutgoingContent } from "@/agents/handoff/stamp";
import { REGISTRY_LOOKUP_CAP, type NewMediaAsset } from "@/agents/persistence/store";
import { SupabaseWorkflowStore } from "@/agents/persistence/supabase-store";
import { PersistentSourceFrameRegistry } from "@/agents/persistence/source-frames";
import { staticFrameRegistry, WorkflowRegistry } from "@/agents/persistence/workflow";
import { runInTurnScope } from "@/agents/runtime/turn-scope";
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
      override async listSourceFramesForScene(): Promise<never> {
        throw new Error("network down");
      }
    }
    const frames = new PersistentSourceFrameRegistry(new WorkflowRegistry(new DownStore()));
    assert.deepEqual(await frames.refreshScene(CASE, "luv-scene-1"), { valid: null, invalid: true });
    assert.ok(errorsFor(validPlacementPlan(), frames).some((e) => /blocked/.test(e)));
  });
});

describe("nativeframe_get_source_frame", () => {
  const raw = (frames?: PersistentSourceFrameRegistry) => toolsForRole("placement-director", { frames }).find((t) => t.name === "nativeframe_get_source_frame")!;
  /** The tool as called inside a turn acting on the authenticated luv-scene-1 handoff. */
  const tool = (frames?: PersistentSourceFrameRegistry) => ({
    handler: (args: Record<string, unknown>) => runInTurnScope({ caseId: CASE, sceneId: "luv-scene-1" }, () => raw(frames).handler(args)),
  });

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


describe("source-frame lookup is bound to the authenticated handoff (security follow-up)", () => {
  const OTHER_CASE = "NF-DEMO-0002";
  const OTHER_FRAME = "asset:luv-hypothesis:source-frame:luv-scene-1:v7";
  const OTHER_REF = "storage://nf-media/frames/other-case/secret-frame.png";
  const OTHER_SUM = `sha256:${"7".repeat(64)}`;

  async function twoCases() {
    const ctx = await setup();
    await ctx.store.ensureCase({ case_id: OTHER_CASE, title_id: "luv-hypothesis", status: "open" });
    await ctx.store.insertMediaAsset(video({ asset_id: "asset:luv-hypothesis:source-video:v7", case_id: OTHER_CASE, storage_ref: "storage://nf-media/other-case/v.mp4" }));
    await ctx.store.insertMediaAsset(
      frame(
        { sourceAssetId: "asset:luv-hypothesis:source-video:v7", sourceStorageRef: "storage://nf-media/other-case/v.mp4" },
        { asset_id: OTHER_FRAME, case_id: OTHER_CASE, storage_ref: OTHER_REF, checksum: OTHER_SUM },
      ),
    );
    return ctx;
  }
  const lookup = (frames: PersistentSourceFrameRegistry, scope: { caseId: string; sceneId: string } | null, args: Record<string, unknown>) =>
    runInTurnScope(scope, () => toolsForRole("placement-director", { frames }).find((t) => t.name === "nativeframe_get_source_frame")!.handler(args));
  const scope = { caseId: CASE, sceneId: "luv-scene-1" };

  it("refuses a request for another case without revealing anything about it", async () => {
    const { frames } = await twoCases();
    const r = await lookup(frames, scope, { caseId: OTHER_CASE, sceneId: "luv-scene-1" });
    assert.deepEqual(r, { found: false, status: "not-available", message: "Not available for this handoff." });
    const text = JSON.stringify(r);
    for (const secret of [OTHER_FRAME, OTHER_REF, OTHER_SUM, OTHER_CASE, "secret-frame", "v7"]) assert.ok(!text.includes(secret), secret);
    assert.equal(frames.forScene(OTHER_CASE, "luv-scene-1"), null, "tool arguments never refresh another case");
  });

  it("refuses another scene in the same case, and any call outside an authenticated turn", async () => {
    const { frames } = await twoCases();
    assert.equal(((await lookup(frames, scope, { caseId: CASE, sceneId: "luv-scene-2" })) as { status: string }).status, "not-available");
    assert.equal(((await lookup(frames, null, { caseId: CASE, sceneId: "luv-scene-1" })) as { status: string }).status, "not-available");
    assert.equal(((await lookup(frames, { caseId: OTHER_CASE, sceneId: "luv-scene-1" }, { caseId: CASE, sceneId: "luv-scene-1" })) as { status: string }).status, "not-available");
  });

  it("returns only the authenticated case's frame for the matching request", async () => {
    const { frames } = await twoCases();
    const r = (await lookup(frames, scope, { caseId: CASE, sceneId: "luv-scene-1" })) as { status: string; sourceMedia: { assetId: string } };
    assert.equal(r.status, "registered");
    assert.equal(r.sourceMedia.assetId, FRAME_ID);
    assert.ok(!JSON.stringify(r).includes(OTHER_REF));
  });

  it("scopes the turn from the authenticated message in the adapter, not from tool arguments", async () => {
    const { handoffScope } = await import("@/agents/runtime/turn-scope");
    assert.deepEqual(handoffScope({ caseId: CASE, artifactId: "match:daybreak-cold-brew:luv-scene-1" }), scope);
    assert.deepEqual(handoffScope({ caseId: CASE, artifact: { scene: { sceneId: "luv-scene-1" } } }), scope);
    assert.equal(handoffScope({ artifactId: "match:daybreak-cold-brew:luv-scene-1" }), null);
  });
});

describe("registry lookups fail closed on truncation (security follow-up)", () => {
  /** A minimal PostgREST stand-in for media_assets and cases, applying the same filters as the real API. */
  function fakeSupabase(db: { media: NewMediaAsset[]; cases: { case_id: string; title_id: string }[] }, failing = false) {
    const queries: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      queries.push(decodeURIComponent(u.search));
      if (failing) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
      const table = u.pathname.split("/").pop()!;
      let rows: Record<string, unknown>[] = table === "cases" ? db.cases.map((c) => ({ ...c, status: "open", created_at: "x", updated_at: "x" })) : db.media.map((m, i) => ({ ...m, created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }));
      let limit = Infinity;
      for (const [key, value] of u.searchParams) {
        if (key === "limit") limit = Number(value);
        else if (value.startsWith("eq.")) {
          const want = value.slice(3);
          rows = rows.filter((r) => {
            if (key === "provenance->>sceneId") {
              const v = (r.provenance as Record<string, unknown> | null)?.sceneId;
              return v !== undefined && v !== null && (typeof v === "string" ? v : JSON.stringify(v)) === want;
            }
            return String(r[key]) === want;
          });
        }
      }
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return new Response(JSON.stringify(rows.slice(0, limit)), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return { store: new SupabaseWorkflowStore("https://x.supabase.co", "sb_secret_TEST0000notarealkey0000", fetchImpl), queries };
  }
  const sceneTwoFrame = (i: number) =>
    frame({ sceneId: "luv-scene-2", timestampSeconds: 5 }, { asset_id: `asset:luv-hypothesis:source-frame:luv-scene-2:v${i}`, storage_ref: `storage://nf-media/frames/luv-hypothesis/s2-${i}.png` });
  const sceneOneFrame = (i: number) => frame({}, { asset_id: `asset:luv-hypothesis:source-frame:luv-scene-1:v${i}`, storage_ref: `storage://nf-media/frames/luv-hypothesis/s1-${i}.png` });
  const CAP = REGISTRY_LOOKUP_CAP;

  /** Runs one scenario on both stores. The matching frame is inserted first, so it is the oldest row. */
  async function bothStores(media: NewMediaAsset[]) {
    const memory = new MemoryWorkflowStore();
    await memory.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
    for (const m of [video(), ...media]) await memory.insertMediaAsset(m);
    const supa = fakeSupabase({ media: [video(), ...media], cases: [{ case_id: CASE, title_id: "luv-hypothesis" }] });
    return {
      memory: await new WorkflowRegistry(memory).loadSourceFramesForScene(CASE, "luv-scene-1"),
      supabase: await new WorkflowRegistry(supa.store).loadSourceFramesForScene(CASE, "luv-scene-1"),
      queries: supa.queries,
    };
  }

  it("finds a valid matching frame beyond the old first 20 case rows, the same way in both stores", async () => {
    const r = await bothStores([frame(), ...Array.from({ length: CAP + 5 }, (_, i) => sceneTwoFrame(i + 1))]);
    assert.equal(r.memory.valid?.assetId, FRAME_ID);
    assert.deepEqual(r.supabase, r.memory);
    const frameQuery = r.queries.find((q) => q.includes("kind=eq.source-frame"))!;
    assert.match(frameQuery, /case_id=eq\.NF-DEMO-0001/);
    assert.match(frameQuery, /provenance->>sceneId=eq\.luv-scene-1/);
    assert.match(frameQuery, new RegExp(`limit=${CAP + 1}(&|$)`));
  });

  it("treats more than the cap of matching frames as invalid and chooses none, in both stores", async () => {
    const r = await bothStores(Array.from({ length: CAP + 1 }, (_, i) => sceneOneFrame(i + 1)));
    assert.deepEqual(r.memory, { valid: null, invalid: true });
    assert.deepEqual(r.supabase, r.memory);
  });

  it("evaluates exactly-at-cap frame results without treating them as truncated", async () => {
    class SpyStore extends MemoryWorkflowStore {
      limits: number[] = [];
      override async listSourceFramesForScene(caseId: string, sceneId: string, limit: number) {
        this.limits.push(limit);
        return super.listSourceFramesForScene(caseId, sceneId, limit);
      }
    }
    const store = new SpyStore();
    await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
    await store.insertMediaAsset(video());
    await store.insertMediaAsset(frame());
    for (let i = 1; i < CAP; i++) await store.insertMediaAsset(sceneTwoFrame(i));
    assert.equal((await new WorkflowRegistry(store).loadSourceFramesForScene(CASE, "luv-scene-1")).valid?.assetId, FRAME_ID);
    assert.deepEqual(store.limits, [CAP + 1], "the cap is requested plus one, never more");
  });

  it("chooses a preview at the cap but refuses to choose from more than the cap", async () => {
    const PLAN = validPlacementPlan().planId;
    const preview = (i: number): NewMediaAsset => ({
      asset_id: `asset:generated-preview:p${i}`, case_id: CASE, plan_id: PLAN, kind: "generated-preview", storage_ref: `storage://nf-media/previews/p${i}.mp4`,
      mime_type: "video/mp4", duration_seconds: 3, generator: "reactor", model: "reactor-orbis", generated_at: "2026-10-20T10:00:00.000Z",
      latency_ms: 1000, cost_usd: 0.1, checksum: `sha256:${"4".repeat(64)}`, provenance: { generator: "reactor", generatedAt: "2026-10-20T10:00:00.000Z", inputPlanId: PLAN },
    });
    const seeded = async (n: number) => {
      const store = new MemoryWorkflowStore();
      const workflow = new WorkflowRegistry(store);
      assert.equal((await workflow.savePlan(validPlacementPlan())).ok, true);
      for (let i = 1; i <= n; i++) await store.insertMediaAsset(preview(i));
      return workflow.loadGeneratedPreview(PLAN);
    };
    const atCap = await seeded(CAP);
    assert.ok(atCap.ok && atCap.value.assetId === `asset:generated-preview:p${CAP}`, "newest of exactly the cap");
    const overCap = await seeded(CAP + 1);
    assert.ok(!overCap.ok && overCap.errors.some((e) => /truncated/.test(e)));
  });

  it("fails closed during storage errors for frames and the lookup tool", async () => {
    const down = fakeSupabase({ media: [], cases: [] }, true);
    const frames = new PersistentSourceFrameRegistry(new WorkflowRegistry(down.store));
    assert.deepEqual(await frames.refreshScene(CASE, "luv-scene-1"), { valid: null, invalid: true });
    const r = (await runInTurnScope({ caseId: CASE, sceneId: "luv-scene-1" }, () =>
      toolsForRole("placement-director", { frames }).find((t) => t.name === "nativeframe_get_source_frame")!.handler({ caseId: CASE, sceneId: "luv-scene-1" }),
    )) as { status: string };
    assert.equal(r.status, "invalid");
    assert.ok(errorsFor(validPlacementPlan(), frames).some((e) => /blocked/.test(e)));
  });
});
