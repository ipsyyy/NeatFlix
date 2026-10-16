import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { collectSecrets } from "@/agents/config/env";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { loadVerifiedEditedStill, sha256Hex, validateEditedStill } from "@/agents/media/edited-still";
import { GeminiImageEditProvider, parseInteraction, ProviderError, type ImageEditProvider, type ProviderEditResult } from "@/agents/media/gemini-provider";
import { executeStillEdit, normalizeToStill, type StillEditRequest } from "@/agents/media/still-edit";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { canonical, WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets } from "@/agents/security/redact";
import { validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const CASE = "NF-DEMO-0001";
const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
const VIDEO_SUM = `sha256:${"1".repeat(64)}`;
const REQ: StillEditRequest = {
  planId: "plan:daybreak-cold-brew:luv-scene-1:v1",
  sourceFrameAssetId: "asset:luv-hypothesis:source-frame:luv-scene-1:v1",
  sourceFrameStorageRef: "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png",
  outputAssetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v1",
  outputStorageRef: "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v1/edited-still-v1.png",
};

const image = (width: number, height: number, format: "png" | "jpeg" = "png", shade = 120) =>
  sharp({ create: { width, height, channels: 3, background: { r: shade, g: 90, b: 60 } } })[format]().toBuffer();

class MemoryPrivateStorage implements PrivateStorage {
  readonly objects = new Map<string, Uint8Array>();
  uploads = 0;
  async download(ref: string) {
    const o = this.objects.get(ref);
    return o ? new Uint8Array(o) : null;
  }
  async uploadNew(ref: string, bytes: Uint8Array) {
    this.uploads++;
    if (this.objects.has(ref)) return "exists" as const;
    this.objects.set(ref, new Uint8Array(bytes));
    return "created" as const;
  }
}

class FakeProvider implements ImageEditProvider {
  readonly provider = "google-gemini" as const;
  readonly model = "gemini-nano-banana-2.1";
  calls = 0;
  lastPrompt = "";
  constructor(private readonly respond: () => Promise<ProviderEditResult>) {}
  async edit(input: { prompt: string }) {
    this.calls++;
    this.lastPrompt = input.prompt;
    return this.respond();
  }
}
const oneImage = (data: Uint8Array, mimeType = "image/png"): ProviderEditResult => ({ responseId: "interaction-123", images: [{ mimeType, data }], text: null, usage: { inputTokens: 1000, outputTokens: 1300, totalTokens: 2300 } });

/** A registry and private storage seeded like production: case, source video, source frame, and the frame-bound plan. */
async function setup(frameBytesOverride?: Uint8Array) {
  const store = new MemoryWorkflowStore();
  const workflow = new WorkflowRegistry(store);
  const storage = new MemoryPrivateStorage();
  const frame = await image(1280, 720);
  const frameSum = `sha256:${sha256Hex(frame)}`;
  await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
  await store.insertMediaAsset({ asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4", duration_seconds: 20.064, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: VIDEO_SUM, provenance: { titleId: "luv-hypothesis" } });
  await store.insertMediaAsset({ asset_id: REQ.sourceFrameAssetId, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: REQ.sourceFrameStorageRef, mime_type: "image/png", duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: frameSum, provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: VIDEO_SUM, sceneId: "luv-scene-1", timestampSeconds: 8 } });
  storage.objects.set(REQ.sourceFrameStorageRef, frameBytesOverride ?? frame);
  const plan = validPlacementPlan({
    sourceMedia: { kind: "registered-source-frame", isSceneFrame: true, assetId: REQ.sourceFrameAssetId, storageRef: REQ.sourceFrameStorageRef, checksum: frameSum, sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE } as PlacementPlan["sourceMedia"],
  });
  const saved = await workflow.savePlan(plan);
  assert.ok(saved.ok, saved.ok ? "" : saved.errors.join(" "));
  return { store, workflow, storage, plan };
}

describe("controlled Gemini still edit", () => {
  it("edits once with the exact persisted prompt and verified pixels, stores privately, and leaves the plan unchanged", async () => {
    const { store, workflow, storage, plan } = await setup();
    const provider = new FakeProvider(async () => oneImage(await image(1280, 720, "png", 200)));
    const r = await executeStillEdit(REQ, { workflow, store, storage, provider });
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.equal(provider.calls, 1);
    assert.equal(provider.lastPrompt, plan.prompts.stillImageEdit.prompt, "exact persisted prompt, not rewritten");
    const verified = await loadVerifiedEditedStill(workflow, store, REQ.outputAssetId);
    assert.ok(verified.ok, verified.ok ? "" : verified.errors.join(" "));
    const prov = verified.ok ? (verified.row.provenance as Record<string, unknown>) : {};
    assert.equal(prov.responseId, "interaction-123");
    assert.equal(prov.humanVisualReview, "pending");
    assert.equal(prov.promptSha256, sha256Hex(plan.prompts.stillImageEdit.prompt));
    assert.deepEqual(prov.normalization, { method: "none", tool: "sharp@0.35.5" });
    assert.equal(verified.ok && verified.row.cost_usd, null);
    assert.match(String(prov.costBasis), /no price/);
    assert.ok(storage.objects.has(REQ.outputStorageRef));
    const stored = await workflow.loadPlan(REQ.planId);
    assert.ok(stored.ok && canonical(stored.value) === canonical(plan), "plan unchanged");
    assert.equal(stored.ok && stored.value.prompts.stillImageEdit.status, "not-executed");
  });

  it("rejects malformed, missing, and text-only responses", async () => {
    assert.throws(() => parseInteraction(null), ProviderError);
    assert.throws(() => parseInteraction({ status: "completed", output_image: { type: "image", uri: "https://x/y.png" } }), /inline base64/);
    assert.throws(() => parseInteraction({ status: "failed" }), /did not complete/);
    for (const respond of [async () => ({ responseId: "r", images: [], text: "I can't edit this image.", usage: null }), async () => ({ responseId: "r", images: [], text: null, usage: null }), async () => oneImage(new Uint8Array([1, 2, 3]))]) {
      const { store, workflow, storage } = await setup();
      const r = await executeStillEdit(REQ, { workflow, store, storage, provider: new FakeProvider(respond) });
      assert.ok(!r.ok && r.stage === "response", JSON.stringify(r));
      assert.equal(storage.uploads, 0);
      assert.equal(await store.getMediaAsset(REQ.outputAssetId), null);
    }
  });

  it("rejects multiple images", async () => {
    const { store, workflow, storage } = await setup();
    const img = await image(1280, 720);
    const r = await executeStillEdit(REQ, { workflow, store, storage, provider: new FakeProvider(async () => ({ ...oneImage(img), images: [{ mimeType: "image/png", data: img }, { mimeType: "image/png", data: img }] })) });
    assert.ok(!r.ok && /exactly one/.test(r.errors[0]));
    const parsed = parseInteraction({ status: "completed", id: "i1", steps: [{ type: "model_output", content: [{ type: "image", data: "AAAA" }] }], output_image: { type: "image", data: "AAAA" } });
    assert.equal(parsed.images.length, 1, "output_image duplicates the step image and is not counted twice");
  });

  it("rejects any aspect ratio other than exactly 16:9, without cropping or stretching", async () => {
    for (const [w, h] of [[1024, 1024], [1281, 720], [720, 1280], [1344, 768]]) {
      const n = await normalizeToStill(await image(w, h));
      assert.ok(!n.ok && /not exactly 16:9/.test(n.error), `${w}×${h}`);
    }
  });

  it("normalizes exact 16:9 output to a 1280×720 PNG and records the original resolution and method", async () => {
    const big = await normalizeToStill(await image(1920, 1080));
    assert.ok(big.ok && big.method === "lanczos3-resize-to-1280x720-png" && big.original.width === 1920);
    const jpeg = await normalizeToStill(await image(1280, 720, "jpeg"));
    assert.ok(jpeg.ok && jpeg.method === "png-reencode" && jpeg.original.mimeType === "image/jpeg");
    const again = await normalizeToStill(await image(1920, 1080));
    assert.ok(big.ok && again.ok && sha256Hex(big.png) === sha256Hex(again.png), "deterministic");
    const meta = await sharp(big.ok ? big.png : Buffer.alloc(0)).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [1280, 720, "png"]);
    const { store, workflow, storage } = await setup();
    const r = await executeStillEdit(REQ, { workflow, store, storage, provider: new FakeProvider(async () => oneImage(await image(2560, 1440, "jpeg"), "image/jpeg")) });
    assert.ok(r.ok && r.normalization === "lanczos3-resize-to-1280x720-png" && r.originalResolution.width === 2560);
  });

  it("stops before calling the provider when the source frame bytes do not match the registry", async () => {
    const { store, workflow, storage } = await setup(await image(1280, 720, "png", 10));
    const provider = new FakeProvider(async () => oneImage(await image(1280, 720)));
    const r = await executeStillEdit(REQ, { workflow, store, storage, provider });
    assert.ok(!r.ok && r.stage === "source" && /checksum/.test(r.errors[0]));
    assert.equal(provider.calls, 0);
  });

  it("refuses a record whose prompt hash, case, or plan does not match", async () => {
    const { store, workflow, storage } = await setup();
    await executeStillEdit(REQ, { workflow, store, storage, provider: new FakeProvider(async () => oneImage(await image(1280, 720))) });
    const v = await loadVerifiedEditedStill(workflow, store, REQ.outputAssetId);
    assert.ok(v.ok);
    const { row, context } = v as Extract<typeof v, { ok: true }>;
    assert.ok(validateEditedStill(row, { ...context, promptSha256: sha256Hex("a rewritten prompt") }).some((e) => /promptSha256/.test(e)));
    assert.ok(validateEditedStill(row, { ...context, caseId: "NF-DEMO-0002" }).some((e) => /another case/.test(e)));
    assert.ok(validateEditedStill(row, { ...context, planId: "plan:daybreak-cold-brew:luv-scene-1:v2" }).some((e) => /another plan/.test(e)));
    assert.ok(validateEditedStill({ ...row, provenance: { ...(row.provenance as object), humanVisualReview: "approved" } }, context).some((e) => /pending/.test(e)));
    assert.ok(validateEditedStill({ ...row, cost_usd: null, provenance: { ...(row.provenance as object), costBasis: "" } }, context).some((e) => /costBasis/.test(e)));
    store.tamper("media", REQ.outputAssetId, { provenance: { ...(row.provenance as object), promptSha256: sha256Hex("tampered") } });
    assert.equal((await loadVerifiedEditedStill(workflow, store, REQ.outputAssetId)).ok, false);
    const wrongFrame = await executeStillEdit({ ...REQ, sourceFrameAssetId: "asset:luv-hypothesis:source-frame:luv-scene-1:v2" }, { workflow, store, storage, provider: new FakeProvider(async () => oneImage(await image(1280, 720))) });
    assert.ok(!wrongFrame.ok && wrongFrame.stage === "plan");
  });

  it("never overwrites a conflicting output object", async () => {
    const { store, workflow, storage } = await setup();
    storage.objects.set(REQ.outputStorageRef, await image(1280, 720, "png", 5));
    const provider = new FakeProvider(async () => oneImage(await image(1280, 720)));
    const r = await executeStillEdit(REQ, { workflow, store, storage, provider });
    assert.ok(!r.ok && r.stage === "idempotency");
    assert.equal(provider.calls, 0, "no paid call when the output path is occupied");
    assert.equal(storage.uploads, 0);
  });

  it("reuses an identical registered output on retry without a second provider call", async () => {
    const { store, workflow, storage } = await setup();
    const provider = new FakeProvider(async () => oneImage(await image(1280, 720)));
    const first = await executeStillEdit(REQ, { workflow, store, storage, provider });
    const second = await executeStillEdit(REQ, { workflow, store, storage, provider });
    assert.ok(first.ok && second.ok && second.status === "reused" && second.checksum === first.checksum);
    assert.equal(provider.calls, 1);
    assert.equal(storage.uploads, 1);
    store.tamper("media", REQ.outputAssetId, { checksum: `sha256:${"9".repeat(64)}` });
    const conflicted = await executeStillEdit(REQ, { workflow, store, storage, provider });
    assert.ok(!conflicted.ok && conflicted.stage === "idempotency");
  });

  it("stops cleanly on provider failure and timeout, storing nothing", async () => {
    for (const respond of [async (): Promise<ProviderEditResult> => Promise.reject(new ProviderError("Gemini request failed (APIError, HTTP 500).")), () => new Promise<ProviderEditResult>(() => {})]) {
      const { store, workflow, storage } = await setup();
      const r = await executeStillEdit(REQ, { workflow, store, storage, provider: new FakeProvider(respond), timeoutMs: 50 });
      assert.ok(!r.ok && r.stage === "provider", JSON.stringify(r));
      assert.equal(storage.uploads, 0);
      assert.equal(await store.getMediaAsset(REQ.outputAssetId), null);
    }
  });
});

describe("Gemini credential handling", () => {
  const FAKE_KEY = "AIzaFAKEtestGeminiKey0000000000000000000";

  it("redacts the Gemini, Reactor, and Masky keys from logs", () => {
    const secrets = collectSecrets({ GEMINI_API_KEY: FAKE_KEY, REACTOR_API_KEY: "rk-fake-reactor-0000", MASKY_API_KEY: "mk-fake-masky-0000" });
    assert.ok(secrets.includes(FAKE_KEY) && secrets.includes("rk-fake-reactor-0000") && secrets.includes("mk-fake-masky-0000"));
    assert.ok(!redactSecrets(`failed with ${FAKE_KEY}`, secrets).includes(FAKE_KEY));
  });

  it("never puts the key or request data in provider errors (no network)", async () => {
    const provider = new GeminiImageEditProvider(FAKE_KEY);
    (provider as unknown as { client: unknown }).client = {
      interactions: { create: async () => Promise.reject(Object.assign(new Error(`401 invalid key ${FAKE_KEY} for prompt`), { status: 401 })) },
    };
    await assert.rejects(provider.edit({ image: new Uint8Array([1]), mimeType: "image/png", prompt: "secret prompt" }, { timeoutMs: 1000 }), (e: Error) => {
      assert.ok(e instanceof ProviderError);
      assert.ok(!e.message.includes(FAKE_KEY) && !e.message.includes("secret prompt"));
      assert.match(e.message, /HTTP 401/);
      return true;
    });
  });
});
