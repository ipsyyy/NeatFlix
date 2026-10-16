import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NO_GENERATED_PREVIEWS, type GovernorReview } from "@/agents/handoff/governor-review";
import { recordHumanApproval } from "@/agents/handoff/human-approval";
import { validateOutgoing } from "@/agents/handoff/protocol";
import { DuplicateRecordError, IntegrityError } from "@/agents/persistence/store";
import { createWorkflowStoreFromEnv, SupabaseWorkflowStore } from "@/agents/persistence/supabase-store";
import { PersistentPreviewRegistry, WorkflowRegistry, type MediaAssetInput } from "@/agents/persistence/workflow";
import { AcceptedPlanRegistry } from "@/agents/runtime/accepted-plans";
import { governorHandoff, PLAN_ID, validGovernorReview, validPlacementPlan } from "./fixtures";

const APPROVAL_REASONS = ["The preview and its checks were reviewed by the owner."];
import { MemoryWorkflowStore } from "./memory-store";

const CHECKSUM = `sha256:${"a".repeat(64)}`;
const GENERATED_AT = "2026-10-20T10:00:00.000Z";
const owner = { id: "owner-user", type: "User", role: null };

function setup() {
  const store = new MemoryWorkflowStore();
  const workflow = new WorkflowRegistry(store);
  return { store, workflow, previews: new PersistentPreviewRegistry(workflow) };
}

const preview = (over: Partial<MediaAssetInput> = {}): MediaAssetInput => ({
  assetId: "asset:generated-preview:daybreak-v1",
  caseId: "NF-DEMO-0001",
  planId: PLAN_ID,
  kind: "generated-preview",
  storageRef: "storage://previews/luv-scene-1/daybreak-v1.mp4",
  mimeType: "video/mp4",
  durationSeconds: 5,
  generator: "reactor",
  model: "reactor-orbis",
  generatedAt: GENERATED_AT,
  latencyMs: 41000,
  costUsd: 0.42,
  checksum: CHECKSUM,
  provenance: { generator: "reactor", generatedAt: GENERATED_AT, inputPlanId: PLAN_ID },
  ...over,
});

/** An approve-for-human-review naming exactly the registered preview. */
function approvalHandoff(assetRef = preview().storageRef) {
  const base = validGovernorReview("approve-for-human-review");
  const review: GovernorReview = {
    ...base,
    preview: {
      status: "provided",
      assetRef,
      provenance: { generator: "reactor", generatedAt: GENERATED_AT, inputPlanId: PLAN_ID },
      generationMetadata: { model: "reactor-orbis", latencyMs: 41000, costUsd: 0.42 },
    },
  };
  return governorHandoff({ artifact: review });
}

async function withPreview() {
  const ctx = setup();
  assert.equal((await ctx.workflow.savePlan(validPlacementPlan())).ok, true);
  const registered = await ctx.workflow.registerMediaAsset(preview());
  assert.ok(registered.ok, registered.ok ? "" : registered.errors.join(" "));
  await ctx.previews.refresh(PLAN_ID);
  return ctx;
}

describe("persistent placement plans", () => {
  it("persists a valid plan and reads it back, once, even after a restart", async () => {
    const { store, workflow } = setup();
    assert.deepEqual(await workflow.savePlan(validPlacementPlan()), { ok: true, value: { planId: PLAN_ID, created: true } });
    assert.deepEqual(await workflow.savePlan(validPlacementPlan()), { ok: true, value: { planId: PLAN_ID, created: false } }, "same plan is idempotent");
    const loaded = await workflow.loadPlan(PLAN_ID);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.ok && loaded.value, validPlacementPlan());
    assert.equal((await store.getCase("NF-DEMO-0001"))?.status, "open");

    const afterRestart = new AcceptedPlanRegistry(new WorkflowRegistry(store));
    assert.equal((await afterRestart.lookup(PLAN_ID))?.planId, PLAN_ID);
  });

  it("rejects an invalid plan and stores nothing", async () => {
    const { store, workflow } = setup();
    const invalid = validPlacementPlan({ placement: { ...validPlacementPlan().placement, region: "shelf" } });
    const result = await workflow.savePlan(invalid);
    assert.equal(result.ok, false);
    assert.equal(store.plans.size, 0);
    assert.equal(store.cases.size, 0);
  });

  it("refuses a different plan under an existing planId", async () => {
    const { workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    const changed = validPlacementPlan({ assumptions: ["A different assumption."] });
    const result = await workflow.savePlan(changed);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => /immutable/.test(e)));
  });
});

describe("generated-preview registry", () => {
  it("registers a valid generated preview and finds only that record", async () => {
    const { previews } = await withPreview();
    const found = previews.find(PLAN_ID);
    assert.equal(found?.assetRef, preview().storageRef);
    assert.deepEqual(found?.provenance, { generator: "reactor", generatedAt: GENERATED_AT, inputPlanId: PLAN_ID });
    assert.equal(previews.find("plan:other:luv-scene-1:v1"), null);
  });

  it("rejects a preview with missing provenance or generation metadata", async () => {
    const { workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    for (const bad of [
      preview({ provenance: {} }),
      preview({ generator: null }),
      preview({ latencyMs: null }),
      preview({ generatedAt: null }),
      preview({ provenance: { generator: "other", generatedAt: GENERATED_AT, inputPlanId: PLAN_ID } }),
    ]) {
      const result = await workflow.registerMediaAsset(bad);
      assert.equal(result.ok, false, JSON.stringify(bad.provenance));
    }
  });

  it("rejects a mismatched or unknown plan ID", async () => {
    const { workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    const mismatch = await workflow.registerMediaAsset(preview({ provenance: { generator: "reactor", generatedAt: GENERATED_AT, inputPlanId: "plan:daybreak-cold-brew:luv-scene-1:v2" } }));
    assert.ok(!mismatch.ok && mismatch.errors.some((e) => /inputPlanId/.test(e)));
    const unknown = await workflow.registerMediaAsset(preview({ planId: "plan:daybreak-cold-brew:luv-scene-1:v9", provenance: { generator: "reactor", generatedAt: GENERATED_AT, inputPlanId: "plan:daybreak-cold-brew:luv-scene-1:v9" } }));
    assert.ok(!unknown.ok && unknown.errors.some((e) => /stored, valid plan/.test(e)));
    const otherCase = await workflow.registerMediaAsset(preview({ caseId: "NF-DEMO-0002" }));
    assert.equal(otherCase.ok, false);
  });

  it("rejects duplicate asset IDs and storage references", async () => {
    const { workflow } = await withPreview();
    assert.equal((await workflow.registerMediaAsset(preview())).ok, false, "same ID");
    assert.equal((await workflow.registerMediaAsset(preview({ assetId: "asset:generated-preview:copy" }))).ok, false, "same storage ref");
  });

  it("rejects invalid storage references, checksums, and MIME types", async () => {
    const { workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    for (const storageRef of ["http://cdn.example.com/p.mp4", "file:///tmp/p.mp4", "s3://bucket/p.mp4", "storage://bad path.mp4", "", "/public/p.mp4"]) {
      const result = await workflow.registerMediaAsset(preview({ storageRef }));
      assert.ok(!result.ok && result.errors.some((e) => /storage_ref/.test(e)), storageRef);
    }
    assert.equal((await workflow.registerMediaAsset(preview({ checksum: "md5:abc" }))).ok, false);
    assert.equal((await workflow.registerMediaAsset(preview({ mimeType: "image/png" }))).ok, false, "a preview is video");
  });

  it("refuses to change a preview once a Governor review references it", async () => {
    const { store, workflow, previews } = await withPreview();
    await store.updateMediaAsset("asset:generated-preview:daybreak-v1", { duration_seconds: 4 }); // allowed before review
    await previews.refresh(PLAN_ID);
    const saved = await workflow.saveGovernorReview(approvalHandoff());
    assert.ok(saved.ok, saved.ok ? "" : saved.errors.join(" "));
    await assert.rejects(store.updateMediaAsset("asset:generated-preview:daybreak-v1", { storage_ref: "storage://previews/swapped.mp4" }), IntegrityError);
  });
});

describe("database rows are revalidated, never trusted", () => {
  it("rejects a tampered plan row", async () => {
    const { store, workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    store.tamper("plans", PLAN_ID, { plan: { ...validPlacementPlan(), placement: { ...validPlacementPlan().placement, handInteraction: "holding" } } });
    assert.equal((await workflow.loadPlan(PLAN_ID)).ok, false);
    store.tamper("plans", PLAN_ID, { plan: validPlacementPlan(), scene_id: "luv-scene-2" });
    assert.equal((await workflow.loadPlan(PLAN_ID)).ok, false, "columns must match the document");
    assert.equal(await new AcceptedPlanRegistry(workflow).lookup(PLAN_ID), null);
  });

  it("drops a tampered preview row from the registry", async () => {
    const { store, previews } = await withPreview();
    store.tamper("media", "asset:generated-preview:daybreak-v1", { storage_ref: "http://evil.example.com/p.mp4" });
    assert.equal(await previews.refresh(PLAN_ID), null);
    assert.equal(previews.find(PLAN_ID), null);
    store.tamper("media", "asset:generated-preview:daybreak-v1", { storage_ref: preview().storageRef, provenance: { generator: "reactor", generatedAt: GENERATED_AT, inputPlanId: "plan:x:y:v1" } });
    assert.equal(await previews.refresh(PLAN_ID), null);
  });

  it("refuses to approve a tampered review row", async () => {
    const { store, workflow, previews } = await withPreview();
    await workflow.saveGovernorReview(approvalHandoff());
    const reviewId = `review:${PLAN_ID}:r1`;
    const tampered = { ...validGovernorReview("approve-for-human-review"), hhh: { ...validGovernorReview("approve-for-human-review").hhh, harmless: { outcome: "fail", rationale: "x" } } };
    store.tamper("reviews", reviewId, { review: tampered });
    const approval = recordHumanApproval({ sender: owner, ownerUserId: owner.id, approverName: "Reviewer", governorHandoff: approvalHandoff(), previews });
    assert.ok(approval.ok);
    const saved = await workflow.saveHumanApproval(approval.ok ? approval.value : (null as never), APPROVAL_REASONS);
    assert.ok(!saved.ok && saved.errors.some((e) => /does not revalidate/.test(e)));
  });
});

describe("Governor approval against persisted previews", () => {
  it("stays impossible when no preview is registered", async () => {
    const { workflow, previews } = setup();
    await workflow.savePlan(validPlacementPlan());
    assert.equal(await previews.refresh(PLAN_ID), null);
    assert.equal(validateOutgoing(approvalHandoff(), { previews }).ok, false);
    assert.equal(validateOutgoing(approvalHandoff()).ok, false, "default registry");
    assert.equal(NO_GENERATED_PREVIEWS.find(PLAN_ID), null);
    assert.equal((await workflow.saveGovernorReview(approvalHandoff())).ok, false);
  });

  it("succeeds only with the matching persisted preview, and records one approval", async () => {
    const { store, workflow, previews } = await withPreview();
    assert.equal(validateOutgoing(approvalHandoff(), { previews }).ok, true);
    assert.equal(validateOutgoing(approvalHandoff("storage://previews/other.mp4"), { previews }).ok, false, "different asset");
    assert.equal((await workflow.saveGovernorReview(approvalHandoff("storage://previews/other.mp4"))).ok, false);

    const saved = await workflow.saveGovernorReview(approvalHandoff());
    assert.ok(saved.ok, saved.ok ? "" : saved.errors.join(" "));
    assert.equal(store.reviews.get(`review:${PLAN_ID}:r1`)?.preview_asset_id, "asset:generated-preview:daybreak-v1");
    assert.equal((await store.getCase("NF-DEMO-0001"))?.status, "awaiting-human-review");
    assert.equal((await workflow.saveGovernorReview(approvalHandoff())).ok, false, "review replay");

    const approval = recordHumanApproval({ sender: owner, ownerUserId: owner.id, approverName: "Reviewer", governorHandoff: approvalHandoff(), previews });
    assert.ok(approval.ok);
    const value = approval.ok ? approval.value : (null as never);
    assert.deepEqual(await workflow.saveHumanApproval(value, APPROVAL_REASONS), { ok: true, value: { reviewId: `review:${PLAN_ID}:r1` } });
    assert.equal((await store.getCase("NF-DEMO-0001"))?.status, "approved");
    assert.equal((await workflow.saveHumanApproval(value, APPROVAL_REASONS)).ok, false, "approval replay");
    const forged = { ...value };
    assert.equal((await workflow.saveHumanApproval(forged, APPROVAL_REASONS)).ok, false, "unrecorded copy");
    assert.equal(store.approvals.size, 1);
  });

  it("stores an honest revise without a preview and marks the case", async () => {
    const { store, workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    const saved = await workflow.saveGovernorReview(governorHandoff({ decision: "revise" }));
    assert.ok(saved.ok, saved.ok ? "" : saved.errors.join(" "));
    assert.equal(store.reviews.get(`review:${PLAN_ID}:r1`)?.preview_asset_id, null);
    assert.equal((await store.getCase("NF-DEMO-0001"))?.status, "revise-requested");
  });
});

describe("Supabase adapter (no network)", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  // Shaped like a Supabase secret key; not a real credential.
  const KEY = "sb_secret_TEST0000notarealkey0000";

  it("is built only from server env and never falls back to a test store", () => {
    assert.equal(createWorkflowStoreFromEnv({}), null);
    assert.equal(createWorkflowStoreFromEnv({ SUPABASE_URL: "https://x.supabase.co" }), null);
    assert.equal(createWorkflowStoreFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_SECRET_KEY: KEY }), null);
    assert.throws(() => createWorkflowStoreFromEnv({ SUPABASE_URL: "http://x.supabase.co", SUPABASE_SECRET_KEY: KEY }));
    assert.ok(createWorkflowStoreFromEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: KEY }, fakeFetch(200, [])) instanceof SupabaseWorkflowStore);
    assert.equal(createWorkflowStoreFromEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY }), null, "the legacy variable is ignored");
  });

  it("accepts only the sb_secret_ key format and never echoes a rejected key", () => {
    for (const bad of ["sb_publishable_TEST0000notarealkey0000", "eyJhbGciOiJIUzI1NiJ9.e30.notreal", "sb_secret_short", "plain-key-value-000000"]) {
      assert.throws(() => new SupabaseWorkflowStore("https://x.supabase.co", bad), (e: Error) => !e.message.includes(bad) && /SUPABASE_SECRET_KEY/.test(e.message), bad);
    }
  });

  it("maps duplicate and integrity errors without echoing the key or rows", async () => {
    const dup = new SupabaseWorkflowStore("https://x.supabase.co", KEY, fakeFetch(409, { code: "23505", message: "duplicate", details: "secret row" }));
    await assert.rejects(dup.insertPlan({} as never), DuplicateRecordError);
    const trig = new SupabaseWorkflowStore("https://x.supabase.co", KEY, fakeFetch(400, { code: "P0001", message: "immutable" }));
    await assert.rejects(trig.updateMediaAsset("asset:x", {}), IntegrityError);
    const down = new SupabaseWorkflowStore("https://x.supabase.co", KEY, fakeFetch(500, { message: KEY }));
    await assert.rejects(down.getPlan(PLAN_ID), (e: Error) => !e.message.includes(KEY) && /HTTP 500/.test(e.message));
    const last = calls.at(-1)!;
    assert.match(last.url, /^https:\/\/x\.supabase\.co\/rest\/v1\/placement_plans\?plan_id=eq\./);
    const headers = last.init.headers as Record<string, string>;
    assert.equal(headers.apikey, KEY, "secret key sent only in the apikey header");
    assert.equal(headers.Authorization, undefined, "a secret key is not a JWT and never goes in Authorization");
  });
});

describe("server-only boundaries", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it("keeps persistence and the secret key out of browser-reachable code", () => {
    for (const path of ["app", "components", "lib"].flatMap(files)) {
      const text = readFileSync(path, "utf8");
      assert.ok(!/agents\/persistence|agents\/media|@google\/genai|GEMINI_API_KEY|REACTOR_API_KEY|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE|sb_secret_|supabase-store/.test(text), path);
    }
    for (const path of files("agents")) assert.ok(!/NEXT_PUBLIC_SUPABASE_(SECRET|SERVICE)/.test(readFileSync(path, "utf8")) || path.endsWith(".test.ts"), path);
  });

  it("never imports test stores or preview fixtures from production code", () => {
    for (const path of files("agents").filter((p) => !p.startsWith(join("agents", "tests")))) {
      const text = readFileSync(path, "utf8");
      assert.ok(!/memory-store|tests\/fixtures|FUTURE_PREVIEW/.test(text), path);
    }
  });
});

describe("case isolation (security follow-up)", () => {
  const OTHER_CASE = "NF-DEMO-0002";
  const PLAN_V2 = "plan:daybreak-cold-brew:luv-scene-1:v2";
  const otherCasePlan = () => validPlacementPlan({ planId: PLAN_V2, caseId: OTHER_CASE });

  it("refuses a Governor review whose plan belongs to another case, in code and in the store", async () => {
    const { store, workflow } = setup();
    await workflow.savePlan(validPlacementPlan());
    const base = validGovernorReview("revise");
    const crossCase = governorHandoff({ decision: "revise", caseId: OTHER_CASE, artifact: { ...base, caseId: OTHER_CASE } });
    const saved = await workflow.saveGovernorReview(crossCase);
    assert.ok(!saved.ok && saved.errors.some((e) => /another case/.test(e)));
    assert.equal(store.reviews.size, 0);
    await store.ensureCase({ case_id: OTHER_CASE, title_id: "luv-hypothesis", status: "open" });
    await assert.rejects(
      store.insertReview({ review_id: `review:${PLAN_ID}:r1`, case_id: OTHER_CASE, plan_id: PLAN_ID, preview_asset_id: null, decision: "revise", review: base }),
      IntegrityError,
    );
  });

  it("refuses a preview from another case or plan, for media, reviews, and approvals", async () => {
    const { store, workflow } = await withPreview();
    assert.equal((await workflow.savePlan(otherCasePlan())).ok, true);
    // Media cannot be filed under one case while pointing at another case's plan.
    const crossMedia = await workflow.registerMediaAsset(preview({ assetId: "asset:generated-preview:x", storageRef: "storage://previews/x.mp4", caseId: OTHER_CASE }));
    assert.equal(crossMedia.ok, false);
    await assert.rejects(store.insertMediaAsset({ ...store.media.get("asset:generated-preview:daybreak-v1")!, asset_id: "asset:y", storage_ref: "storage://y.mp4", case_id: OTHER_CASE }), IntegrityError);
    // A review in the other case cannot cite case A's preview.
    const approve = validGovernorReview("approve-for-human-review");
    await assert.rejects(
      store.insertReview({ review_id: `review:${PLAN_V2}:r1`, case_id: OTHER_CASE, plan_id: PLAN_V2, preview_asset_id: "asset:generated-preview:daybreak-v1", decision: "approve-for-human-review", review: approve }),
      IntegrityError,
    );
    // An approval cannot bind a preview from another case.
    await workflow.saveGovernorReview(approvalHandoff());
    await assert.rejects(
      store.insertApproval({ reasons: APPROVAL_REASONS, approval_id: "a1", case_id: OTHER_CASE, review_id: `review:${PLAN_ID}:r1`, preview_asset_id: "asset:generated-preview:daybreak-v1", reviewer_user_id: owner.id, reviewer_name: "R", decision: "approve" }),
      IntegrityError,
    );
  });

  it("binds a human approval to its review's case, plan, and preview", async () => {
    const { store, workflow, previews } = await withPreview();
    await workflow.saveGovernorReview(approvalHandoff());
    const approval = recordHumanApproval({ sender: owner, ownerUserId: owner.id, approverName: "Reviewer", governorHandoff: approvalHandoff(), previews });
    assert.ok(approval.ok);
    const value = approval.ok ? approval.value : (null as never);
    // A review row moved to another case is refused, as is a preview moved to another case.
    store.tamper("reviews", `review:${PLAN_ID}:r1`, { case_id: OTHER_CASE });
    assert.equal((await workflow.saveHumanApproval(value, APPROVAL_REASONS)).ok, false);
    store.tamper("reviews", `review:${PLAN_ID}:r1`, { case_id: "NF-DEMO-0001" });
    store.tamper("media", "asset:generated-preview:daybreak-v1", { case_id: OTHER_CASE });
    assert.equal((await workflow.saveHumanApproval(value, APPROVAL_REASONS)).ok, false);
    store.tamper("media", "asset:generated-preview:daybreak-v1", { case_id: "NF-DEMO-0001" });
    assert.equal((await workflow.saveHumanApproval(value, APPROVAL_REASONS)).ok, true, "the correctly bound approval still succeeds");
    assert.equal(store.approvals.size, 1);
  });

  it("refuses to attach a plan to a case that belongs to another title (third finding)", async () => {
    const { store, workflow } = setup();
    await store.ensureCase({ case_id: "NF-DEMO-0001", title_id: "not-suitable-for-professionals", status: "open" });
    const saved = await workflow.savePlan(validPlacementPlan());
    assert.ok(!saved.ok && saved.errors.some((e) => /another title/.test(e)));
    assert.equal(store.plans.size, 0);
    await assert.rejects(store.insertPlan({ plan_id: PLAN_ID, case_id: "NF-DEMO-0001", title_id: "luv-hypothesis", scene_id: "luv-scene-1", campaign_id: "daybreak-cold-brew", version: 1, plan: validPlacementPlan(), validation_status: "valid" }), IntegrityError);
  });
});

describe("accepted plans never diverge from storage (security follow-up)", () => {
  it("keeps nothing when persistence fails, and reports the plan unavailable", async () => {
    class FailingStore extends MemoryWorkflowStore {
      override async insertPlan(): Promise<void> {
        throw new Error("network down");
      }
    }
    const plans = new AcceptedPlanRegistry(new WorkflowRegistry(new FailingStore()));
    await assert.rejects(plans.record(validPlacementPlan()));
    assert.equal(await plans.lookup(PLAN_ID), null);
  });

  it("keeps nothing new on a conflicting save and never evaluates the other stored plan", async () => {
    const { workflow } = setup();
    const stored = validPlacementPlan({ assumptions: ["The plan that was stored first."] });
    assert.equal((await workflow.savePlan(stored)).ok, true);
    const plans = new AcceptedPlanRegistry(workflow);
    const problems = await plans.record(validPlacementPlan());
    assert.ok(problems.some((e) => /immutable/.test(e)));
    assert.equal(await plans.lookup(PLAN_ID), null, "neither the rejected plan nor the different stored plan is evaluated");
    // Recovery: delivering the plan that really is stored makes it available again.
    assert.deepEqual(await plans.record(stored), []);
    assert.deepEqual(await plans.lookup(PLAN_ID), stored);
  });

  it("returns a stored plan only if it is the one this process accepted", async () => {
    const { store, workflow } = setup();
    const plans = new AcceptedPlanRegistry(workflow);
    assert.deepEqual(await plans.record(validPlacementPlan()), []);
    assert.deepEqual(await plans.lookup(PLAN_ID), validPlacementPlan());
    store.tamper("plans", PLAN_ID, { plan: validPlacementPlan({ assumptions: ["Swapped in storage."] }) });
    assert.equal(await plans.lookup(PLAN_ID), null);
  });

  it("keeps the in-memory behaviour when no store is configured", async () => {
    const plans = new AcceptedPlanRegistry();
    assert.deepEqual(await plans.record(validPlacementPlan()), []);
    assert.deepEqual(await plans.lookup(PLAN_ID), validPlacementPlan());
  });
});
