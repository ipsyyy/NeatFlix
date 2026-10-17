import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectSecrets } from "@/agents/config/env";
import { buildCaseTrace } from "@/agents/observability/case-trace";
import { diagnoseErrorResponse, dottedStamp, langSmithConfigFromEnv, payloadLeaks, publishTrace, sanitize, stableUuidV7, TraceBuilder, validationDetails, type LangSmithConfig } from "@/agents/observability/langsmith";
import { MemoryWorkflowStore } from "./memory-store";

const KEY = "lsv2_pt_0123456789abcdef0123456789abcdef_0123456789";
const CONFIG: LangSmithConfig = { endpoint: "https://api.smith.langchain.com", apiKey: KEY, project: "nativeframe-test" };
const CASE = "NF-DEMO-0001";
const sum = (n: string) => `sha256:${n.repeat(64)}`;

describe("LangSmith configuration", () => {
  it("is off unless tracing is true with a LangSmith key and an https LangSmith host", () => {
    assert.equal(langSmithConfigFromEnv({ LANGSMITH_API_KEY: KEY }).ok, false, "tracing not enabled");
    assert.equal(langSmithConfigFromEnv({ LANGSMITH_TRACING: "true" }).ok, false, "no key");
    assert.equal(langSmithConfigFromEnv({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "sk-not-langsmith" }).ok, false, "wrong key shape");
    const ok = langSmithConfigFromEnv({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: KEY, LANGSMITH_PROJECT: "nf" });
    assert.ok(ok.ok && ok.value.endpoint === "https://api.smith.langchain.com" && ok.value.project === "nf");
    assert.ok(langSmithConfigFromEnv({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: KEY, LANGSMITH_ENDPOINT: "https://eu.api.smith.langchain.com" }).ok, "regional host");
    for (const endpoint of ["http://api.smith.langchain.com", "https://evil.example.com", "https://api.smith.langchain.com.evil.com", "https://user:pw@api.smith.langchain.com", "not a url"]) {
      assert.equal(langSmithConfigFromEnv({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: KEY, LANGSMITH_ENDPOINT: endpoint }).ok, false, endpoint);
    }
    const off = langSmithConfigFromEnv({ LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "lsv2_short" });
    assert.ok(!off.ok && !off.reason.includes("lsv2_short"), "reasons never echo the key");
    assert.ok(collectSecrets({ LANGSMITH_API_KEY: KEY }).includes(KEY), "the key is redacted from logs");
  });
});

describe("LangSmith payload safety", () => {
  it("removes secrets, keys, URLs, private media references, and identity fields", () => {
    const out = sanitize(
      {
        note: `key ${KEY} and secret-value-123 at https://x.example/a?token=1 stored at storage://nf-media/agents/spoken/x.mp3`,
        reviewer_user_id: "fb686fec-b978-4e61-8370-ce7682564747",
        nested: { ownerUserId: "u1", list: ["mky_abcdefghij12", "sk-ant-api03-zzzz", "plain"] },
        long: "x".repeat(3000),
        n: 3,
        ok: true,
      },
      ["secret-value-123"],
    ) as Record<string, unknown>;
    const text = JSON.stringify(out);
    assert.ok(!/lsv2_|secret-value-123|https?:|storage:\/\/|mky_|sk-ant|fb686fec|"u1"/.test(text), text);
    assert.equal(out.reviewer_user_id, "[redacted]");
    assert.equal((out.long as string).length, 2001);
    assert.deepEqual([out.n, out.ok], [3, true]);
    assert.deepEqual(payloadLeaks(text, ["secret-value-123"], ["fb686fec-b978-4e61-8370-ce7682564747"]), []);
    assert.deepEqual(payloadLeaks(`${KEY} https://x storage://a/b fb686fec-b978`, [], ["fb686fec-b978"]), ["a key-shaped string", "a URL", "a private storage reference", "a reviewer or owner id"]);
  });

  it("derives deterministic, standards-compliant UUIDv7 ids and LangSmith's dotted_order time format", () => {
    const t = "2026-10-16T00:11:33.496Z";
    const a = stableUuidV7("case:x:run:root", t);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "version 7, RFC variant");
    assert.equal(parseInt(a.replace(/-/g, "").slice(0, 12), 16), Date.parse(t), "the first 48 bits are the recorded time in ms");
    assert.equal(stableUuidV7("case:x:run:root", t), a, "deterministic");
    assert.notEqual(stableUuidV7("case:x:run:other", t), a, "distinct names at the same time differ");
    assert.notEqual(stableUuidV7("case:x:run:root", "2026-10-16T00:11:33.497Z"), a);
    assert.throws(() => stableUuidV7("x", "not a time"), /Invalid UUIDv7 time/);
    assert.equal(dottedStamp("2026-10-17T05:27:57.708Z"), "20261017T052757708000Z");
  });

  it("builds a single ordered trace and refuses malformed runs or evaluations", () => {
    const t = new TraceBuilder("p", [], "ns");
    const root = t.add({ key: "root", name: "Root", runType: "chain", start: "2026-10-17T00:00:00.000Z", end: "2026-10-17T00:00:05.000Z", inputs: {}, outputs: {}, metadata: {} });
    const child = t.add({ key: "child", name: "Child", runType: "tool", start: "2026-10-17T00:00:01.000Z", end: "2026-10-17T00:00:02.000Z", inputs: {}, outputs: {}, metadata: {}, parent: root });
    assert.equal(child.trace_id, root.id);
    assert.equal(child.parent_run_id, root.id);
    assert.equal(child.dotted_order, `${root.dotted_order}.20261017T000001000000Z${child.id}`);
    assert.throws(() => t.add({ key: "early", name: "x", runType: "chain", start: "2026-10-16T00:00:00.000Z", end: "2026-10-16T00:00:00.000Z", inputs: {}, outputs: {}, metadata: {}, parent: root }), /before its parent/);
    assert.throws(() => t.add({ key: "child", name: "dup", runType: "chain", start: "2026-10-17T00:00:01.000Z", end: "2026-10-17T00:00:01.000Z", inputs: {}, outputs: {}, metadata: {}, parent: root }), /Duplicate/);
    assert.throws(() => t.score(root, "Bad Key", 1, ""), /Invalid evaluation/);
    assert.throws(() => t.score(root, "too_high", 2, ""), /Invalid evaluation/);
    t.score(root, "ok", 0.5, "fine");
    assert.equal(t.feedback[0].run_id, root.id);
  });
});

describe("LangSmith publishing is fail-safe", () => {
  const trace = () => {
    const t = new TraceBuilder("p", [], "ns");
    const root = t.add({ key: "root", name: "Root", runType: "chain", start: "2026-10-17T00:00:00.000Z", end: "2026-10-17T00:00:05.000Z", inputs: {}, outputs: {}, metadata: {} });
    const child = t.add({ key: "child", name: "Child", runType: "tool", start: "2026-10-17T00:00:01.000Z", end: "2026-10-17T00:00:02.000Z", inputs: {}, outputs: {}, metadata: {}, parent: root });
    t.score(root, "root_eval", 1, "ok");
    t.score(child, "child_eval", 1, "ok");
    return { t, root, child };
  };

  it("sends runs parents-first, then feedback, with the key only in the x-api-key header", async () => {
    const { t, root } = trace();
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("{}", { status: url.endsWith("/runs") && calls.length === 1 ? 200 : 409 });
    }) as unknown as typeof fetch;
    const s = await publishTrace(CONFIG, t, fetchImpl);
    assert.deepEqual(calls.map((c) => c.url), ["https://api.smith.langchain.com/runs", "https://api.smith.langchain.com/runs", "https://api.smith.langchain.com/feedback", "https://api.smith.langchain.com/feedback"]);
    assert.equal(JSON.parse(calls[0].body).id, root.id);
    assert.ok(calls.every((c) => c.headers["x-api-key"] === KEY && !c.body.includes(KEY)));
    assert.deepEqual([s.created, s.existing, s.failed], [1, 3, 0], "409 means already published");
  });

  it("never throws: a failed run skips its children and their feedback; network errors are reported", async () => {
    const { t } = trace();
    const down = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const s = await publishTrace(CONFIG, t, down);
    assert.deepEqual([s.attempted, s.created, s.failed, s.skipped], [1, 0, 1, 3], "only the root was sent; its child and all feedback were skipped");
    assert.ok(s.results.filter((r) => r.outcome === "skipped").every((r) => r.status === null && !r.validation));
    assert.equal(s.results[0].validation, undefined, "a 5xx carries no validation details");
    const offline = (async () => Promise.reject(new Error(`connect ECONNREFUSED with ${KEY}`))) as unknown as typeof fetch;
    const o = await publishTrace(CONFIG, t, offline);
    assert.deepEqual([o.failed, o.skipped], [1, 3]);
    assert.ok(!JSON.stringify(o).includes(KEY), "errors carry no secret");
  });

  it("keeps only sanitized field paths, codes, and messages from a 422, never the payload", async () => {
    const { t } = trace();
    const body = {
      detail: [
        { loc: ["body", "id"], type: "uuid_version", msg: `Bad id; see https://docs.example/x?token=1 key ${KEY}`, input: { inputs: { path: "storage://nf-media/agents/spoken/x.mp3" } }, ctx: { expected: "7" } },
        { loc: ["body", "dotted_order"], type: "value_error", msg: "Invalid dotted order for storage://nf-media/x.png" },
      ],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 422, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const s = await publishTrace(CONFIG, t, fetchImpl, ["secret-value-123"]);
    const root = s.results[0];
    assert.deepEqual([root.outcome, root.status], ["failed", 422]);
    assert.deepEqual(root.validation, [
      { path: "body.id", code: "uuid_version", message: "Bad id; see [url] key [redacted]" },
      { path: "body.dotted_order", code: "value_error", message: "Invalid dotted order for [private-media]" },
    ]);
    const text = JSON.stringify(s);
    assert.ok(!/storage:\/\/|https?:|lsv2_|nf-media/.test(text), "no payload echo, URL, key, or private path");
    const shape = root.diagnosis?.shape as { detail: { input: string; ctx: string }[] };
    assert.deepEqual([shape.detail[0].input, shape.detail[0].ctx], ["(omitted)", "(omitted)"], "echoed subtrees appear only as omitted field names");
    assert.deepEqual(validationDetails({ title: "Unprocessable", detail: "dotted_order must start with trace id" }, []), [{ path: "(body)", code: "Unprocessable", message: "dotted_order must start with trace id" }]);
    assert.deepEqual(validationDetails("not json", []), []);
    assert.equal(validationDetails({ detail: Array.from({ length: 30 }, () => ({ loc: ["x"], type: "t", msg: "m" })) }, []).length, 10);
  });
});

describe("NativeFrame case trace from the registry", () => {
  async function world(options: { staleLabels?: boolean } = {}) {
    const store = new MemoryWorkflowStore();
    await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
    for (const v of [1, 2, 3]) {
      const planId = `plan:daybreak-cold-brew:luv-scene-1:v${v}`;
      await store.insertPlan({ plan_id: planId, case_id: CASE, title_id: "luv-hypothesis", scene_id: "luv-scene-1", campaign_id: "daybreak-cold-brew", version: v, validation_status: "valid", plan: { planId, placement: { region: "visible café table", ...(v === 3 ? { mode: "rebrand-existing-cups" } : {}) } } });
      const stillId = `asset:luv-hypothesis:edited-still:luv-scene-1:v${v}`;
      await store.insertMediaAsset({ asset_id: stillId, case_id: CASE, plan_id: planId, kind: "edited-still", storage_ref: `storage://nf-media/edits/v${v}.png`, mime_type: "image/png", duration_seconds: null, generator: "google-gemini", model: "gemini-nano-banana-2.1", generated_at: null, latency_ms: 12_000, cost_usd: 0.04, checksum: sum(String(v)), provenance: {} });
      await store.insertVisualReview({ review_id: `vr-${v}`, asset_id: stillId, case_id: CASE, decision: v === 3 ? "approved" : "rejected", reasons: [`Reason ${v}.`], asset_checksum: sum(String(v)), reviewer_user_id: "fb686fec-b978-4e61-8370-ce7682564747", reviewer_name: "Owner" });
    }
    const plan3 = "plan:daybreak-cold-brew:luv-scene-1:v3";
    const previewId = "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback";
    await store.insertMediaAsset({ asset_id: previewId, case_id: CASE, plan_id: plan3, kind: "generated-preview", storage_ref: "storage://nf-media/previews/v3-fallback.mp4", mime_type: "video/mp4", duration_seconds: 3.5, generator: "local-ffmpeg", model: "ffmpeg 8.1.2 zoompan+libx264", generated_at: "2026-10-15T00:00:30.000Z", latency_ms: 12_959, cost_usd: 0, checksum: sum("4"), provenance: { inputPlanId: plan3 } });
    await store.insertVisualReview({ review_id: "vr-preview", asset_id: previewId, case_id: CASE, decision: "approved", reasons: ["Good."], asset_checksum: sum("4"), reviewer_user_id: "fb686fec-b978-4e61-8370-ce7682564747", reviewer_name: "Owner" });
    const reviewId = `review:${plan3}:r1`;
    const checks = ["plan-rules", "title-eligibility", "scene-guardrails", "campaign-match", "prompts-not-executed"].map((id) => ({ id, category: "policy", outcome: "pass", detail: options.staleLabels && id === "prompts-not-executed" ? "Both prompts are labelled not-executed." : "ok", source: "tool" }));
    checks.push({ id: "preview-visual-quality", category: "technical", outcome: "pass", detail: "Verified.", source: "tool" });
    await store.insertReview({ review_id: reviewId, case_id: CASE, plan_id: plan3, preview_asset_id: previewId, decision: "approve-for-human-review", review: { kind: "governor-review", reviewId, decision: "approve-for-human-review", hhh: { helpful: { outcome: "pass", rationale: "r" }, honest: { outcome: "pass", rationale: "r" }, harmless: { outcome: "pass", rationale: "r" } }, checks, blockers: [] } });
    await store.setCaseStatus(CASE, "awaiting-human-review");
    await store.insertApproval({ approval_id: "ap-1", case_id: CASE, review_id: reviewId, preview_asset_id: previewId, reviewer_user_id: "fb686fec-b978-4e61-8370-ce7682564747", reviewer_name: "Owner", decision: "approve", reasons: ["Approved for the demo."] });
    return store;
  }

  it("traces every stage with useful non-secret metadata and deterministic evaluations", async () => {
    const store = await world({ staleLabels: true });
    const r = await buildCaseTrace(store, { caseId: CASE, project: "p", secrets: ["secret-value-123"] });
    assert.ok(r.ok, JSON.stringify(r));
    const names = r.trace.runs.map((x) => x.name);
    for (const expected of ["NativeFrame case NF-DEMO-0001", "Content Curator: title eligibility", "Scene Scout: scene selection", "Campaign Matcher: campaign match", "Placement Director: plan v1", "Placement Director: plan v3", "Release Governor: approve-for-human-review", "Human approval: approve"]) {
      assert.ok(names.includes(expected), expected);
    }
    assert.equal(r.trace.runs.filter((x) => x.name.startsWith("Human visual review")).length, 4);
    assert.ok(r.trace.runs.every((x) => x.trace_id === r.root.id && (x === r.root || x.dotted_order.startsWith(`${r.root.dotted_order}.`))));
    const governor = r.trace.runs.find((x) => x.name.startsWith("Release Governor"))!;
    const meta = governor.extra.metadata as Record<string, unknown>;
    assert.deepEqual([meta.agent_name, meta.case_id, meta.scene_id, meta.trace_source, meta.outcome], ["Release Governor", CASE, "luv-scene-1", "registry-replay", "approve-for-human-review"]);
    assert.match(String(meta.prompt_version), /^[0-9a-f]{12}$/);
    const media = r.trace.runs.find((x) => x.name.startsWith("Motion preview"))!.extra.metadata as Record<string, unknown>;
    assert.deepEqual([media.generator, media.latency_ms, media.cost_usd], ["local-ffmpeg", 12_959, 0]);
    const scores = Object.fromEntries(r.evaluations.map((e) => [e.key, e.score]));
    assert.deepEqual(scores, { hhh_helpful: 1, hhh_honest: 1, hhh_harmless: 1, governor_checks_pass_rate: 1, release_gate_respected: 1, revision_loop_completed: 1, preview_human_visual_approval: 1, prompt_label_currency: 0 });
    assert.equal(r.trace.feedback.filter((f) => f.run_id !== r.root.id).length, 4, "per-review human visual decisions");
    const payload = r.trace.payload();
    assert.deepEqual(payloadLeaks(payload, ["secret-value-123"], ["fb686fec-b978-4e61-8370-ce7682564747"]), [], "no private refs, URLs, or reviewer ids");
    assert.ok(payload.includes("not evaluated: the simulated A/B experiment"), "the missing experiment is stated, not invented");
    const again = await buildCaseTrace(store, { caseId: CASE, project: "p", secrets: [] });
    assert.ok(again.ok && again.trace.runs.map((x) => x.id).join() === r.trace.runs.map((x) => x.id).join(), "stable ids: a re-publish targets the same runs");
    assert.ok(again.ok && again.trace.feedback.map((x) => x.id).join() === r.trace.feedback.map((x) => x.id).join(), "stable feedback ids");
    const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const run of r.trace.runs) {
      assert.match(run.id, v7);
      assert.equal(parseInt(run.id.replace(/-/g, "").slice(0, 12), 16), Date.parse(run.start_time), `${run.name}: id time is its recorded start`);
    }
    assert.ok(r.trace.feedback.every((f) => v7.test(f.id)));
  });

  it("scores current prompt labels as 1, and refuses an unknown case", async () => {
    const r = await buildCaseTrace(await world(), { caseId: CASE, project: "p", secrets: [] });
    assert.ok(r.ok && r.evaluations.find((e) => e.key === "prompt_label_currency")?.score === 1);
    const missing = await buildCaseTrace(new MemoryWorkflowStore(), { caseId: CASE, project: "p", secrets: [] });
    assert.equal(missing.ok, false);
  });
});

describe("LangSmith error diagnosis (diagnostic only)", () => {
  const leak = /lsv2_|https?:|storage:\/\/|secret-value-123|SENSITIVE|fb686fec/;

  it("extracts paths, codes, and sanitized messages from nested and non-standard JSON, never values", () => {
    const body = {
      detail: { errors: [{ field: "dotted_order", code: "invalid_format", message: `dotted_order mismatch; see https://docs.example/x?token=${KEY}` }, { path: ["extra", "metadata"], error: "too large", value: "SENSITIVE" }] },
      request: { inputs: { note: "SENSITIVE storage://nf-media/x.mp3" } },
      status: 422,
    };
    const d = diagnoseErrorResponse(422, "application/json; charset=utf-8", JSON.stringify(body), ["secret-value-123"]);
    assert.equal(d.contentType, "application/json");
    assert.deepEqual(d.details, [
      { path: "dotted_order", code: "invalid_format", message: "dotted_order mismatch; see [url]" },
      { path: "extra.metadata", code: "(none)", message: "too large" },
    ]);
    assert.deepEqual(d.shape, { detail: { errors: [{ code: "string", field: "string", message: "string" }] }, request: "(omitted)", status: "number" });
    assert.ok(!leak.test(JSON.stringify(d)), JSON.stringify(d));
  });

  it("handles message, error, and title bodies, plain text, HTML, and unknown content types safely", () => {
    assert.deepEqual(diagnoseErrorResponse(422, "application/json", JSON.stringify({ message: "Invalid run: start_time", code: 42 }), []).details, [{ path: "(body)", code: "42", message: "Invalid run: start_time" }]);
    assert.deepEqual(diagnoseErrorResponse(422, "application/problem+json", JSON.stringify({ title: "Unprocessable", type: "about:blank" }), []).details, [{ path: "(body)", code: "about:blank", message: "Unprocessable" }]);
    assert.deepEqual(diagnoseErrorResponse(422, "application/json", JSON.stringify({ error: "bad" }), []).details, [{ path: "(body)", code: "(none)", message: "bad" }]);
    const text = diagnoseErrorResponse(422, "text/plain", `invalid trace for ${KEY} at storage://nf-media/a.png`, []);
    assert.deepEqual([text.shape, text.details], ["(not JSON)", [{ path: "(body)", code: "(text)", message: "invalid trace for [redacted] at [private-media]" }]]);
    const html = diagnoseErrorResponse(422, "text/html", "<html><body><h1>Unprocessable Entity</h1><a href='https://x'>x</a></body></html>", []);
    assert.equal(html.details[0].message, "Unprocessable Entity x");
    assert.equal(diagnoseErrorResponse(422, "weird type with spaces", "", []).contentType, "(unrecognized)");
    assert.deepEqual(diagnoseErrorResponse(422, null, "", []).details, []);
    assert.equal(diagnoseErrorResponse(422, "application/json", JSON.stringify({ detail: Array.from({ length: 30 }, (_, i) => ({ loc: ["x", i], msg: "m", type: "t" })) }), []).details.length, 10);
  });

  it("is recorded on a failed publish without echoing the payload", async () => {
    const t = new TraceBuilder("p", [], "ns");
    t.add({ key: "root", name: "Root", runType: "chain", start: "2026-10-17T00:00:00.000Z", end: "2026-10-17T00:00:05.000Z", inputs: { a: 1 }, outputs: {}, metadata: {} });
    const fetchImpl = (async () => new Response(JSON.stringify({ detail: { errors: [{ field: "id", message: "bad id" }] }, input: { echoed: "SENSITIVE" } }), { status: 422, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const r = (await publishTrace(CONFIG, t, fetchImpl)).results[0];
    assert.deepEqual(r.diagnosis?.details, [{ path: "id", code: "(none)", message: "bad id" }]);
    assert.ok(!leak.test(JSON.stringify(r)));
  });
});
