import { createHash } from "node:crypto";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { validateGovernorReview, type GovernorReview } from "@/agents/handoff/governor-review";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { deriveVisualDisclosure } from "@/agents/media/derived-disclosure";
import { mediaBucketReadiness } from "@/agents/masky/generate";
import { AGENT_IDENTITIES, portraitSvg } from "@/agents/masky/identities";
import { evaluatePreviewEvidence } from "@/agents/media/preview-evidence";
import { FULL_SCENE_DISCLOSURE, LUV_V4_RUNWAY, loadVerifiedFullScene, type FullSceneProvenance } from "@/agents/media/runway-full-scene";
import { EVALUATION_METHOD, evaluateAgents } from "@/agents/observability/agent-evaluations";
import { buildCaseTrace } from "@/agents/observability/case-trace";
import { PUBLISHED_CASE_TRACE } from "@/agents/observability/published";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import { canonical, PersistentPreviewRegistry, WorkflowRegistry } from "@/agents/persistence/workflow";
import { PIN } from "@/agents/runtime/plan-v3-approval";
import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { matchCampaignToScene } from "@/lib/campaigns/matching";
import { canStartPlacementReview, getEligibility } from "@/lib/catalogue/eligibility";
import { DEMO_SNAPSHOT_VERSION, FULL_SCENE_LABEL, validateDemoSnapshot, type DemoFullScene, type DemoMedia, type DemoMemory, type DemoMediaKey, type DemoSnapshot, type Outcome } from "@/lib/demo/snapshot";

/**
 * Builds the demo snapshot read-only from the workflow registry and private
 * storage, through the existing access paths. Every media object is
 * downloaded and checked against its registered checksum; a mismatch or
 * missing object is marked unverified (the demo shows a placeholder). No
 * record is created or changed and no provider is called.
 */

/** Masky evidence recorded in agents/masky/STATUS.md and avatar-ledger.jsonl: private objects and their checksums. */
const IRIS_MEDIA = Object.freeze({
  portrait: { ref: "storage://nf-media/agents/portraits/content-curator-v1.png", checksum: "sha256:9afb67f4179e162fc0f3600b71ea1cd5ce1878870d60acb6e919e8a7f07069c0" },
  audio: { ref: "storage://nf-media/agents/spoken/content-curator-v1.mp3", checksum: "sha256:43b58203d6434039c1564b7a2541401bd63e341062d497cc0281688d8b3cd53c", seconds: 8.92 },
});

const LUV_V4_RUNWAY_LIMITATION_NOTE = "its generated cup lettering is not final typography, and the human review records its limitation verbatim. The Release Governor reviewed and the human approval approved the 3.5 s fallback, not this video.";

const RESPONSIBILITIES: Readonly<Record<AgentRole, string>> = Object.freeze({
  "content-curator": "Confirms rights, rating, tone, and restrictions; shortlists eligible titles.",
  "scene-scout": "Finds stable, light scenes with a clear surface; excludes faces, motion, and sensitive moments.",
  "campaign-matcher": "Matches advertiser, scene, and eligible audience; excludes minors and ad-free viewers.",
  "placement-director": "Writes the placement plan and its edit and motion instructions.",
  "release-governor": "Runs HHH, policy, and technical checks; can veto; sends passing work to a human.",
});

export type RecordedChecks = {
  ranAt: string;
  commit: string;
  results: { label: string; ok: boolean; detail: string }[];
} | null;

export type SnapshotDeps = {
  store: WorkflowStore;
  storage: PrivateStorage & { bucketConfig?(bucket: string): Promise<unknown> };
  commit: string;
  now: () => Date;
  ledger: { avatarId: string; voiceName: string; speechJobId: string } | null;
  recordedChecks: RecordedChecks;
};

const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const outcome = (v: unknown): Outcome => (v === "pass" || v === "fail" ? v : "not-evaluated");

export async function buildDemoSnapshot(deps: SnapshotDeps): Promise<{ ok: true; snapshot: DemoSnapshot; files: Map<string, Uint8Array> } | { ok: false; errors: string[] }> {
  const { store, storage } = deps;
  const workflow = new WorkflowRegistry(store);
  const caseRow = await store.getCase(PIN.caseId);
  if (!caseRow) return { ok: false, errors: [`Case ${PIN.caseId} is not stored.`] };
  const planLoad = await workflow.loadPlan(PIN.planId);
  if (!planLoad.ok) return { ok: false, errors: ["Plan v3 does not revalidate.", ...planLoad.errors] };
  const plan: PlacementPlan = planLoad.value;
  const title = catalogue.find((t) => t.id === caseRow.title_id);
  const scene = title ? getSceneReview(title.id)?.scenes.find((s) => s.id === plan.scene.sceneId) : undefined;
  const campaign = campaigns.find((c) => c.id === plan.product.campaignId);
  if (!title || !scene || !campaign) return { ok: false, errors: ["The case's title, scene, or campaign is not in the catalogue fixtures."] };

  const files = new Map<string, Uint8Array>();
  const media: DemoMedia[] = [];
  const addMedia = async (key: DemoMediaKey, ref: string, checksum: string, mimeType: DemoMedia["mimeType"], label: string) => {
    const ext = mimeType === "image/png" ? "png" : mimeType === "video/mp4" ? "mp4" : "mp3";
    const file = `${key}.${ext}`;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await storage.download(ref);
    } catch {
      bytes = null;
    }
    const verified = Boolean(bytes && sha(bytes) === checksum);
    if (verified) files.set(file, bytes!);
    media.push({ key, file, mimeType, sha256: checksum, bytes: verified ? bytes!.length : 0, verified, label });
  };

  // Source frame, the three edited stills with their human reviews, and the approved preview.
  const frameRow = plan.sourceMedia.kind === "registered-source-frame" ? await store.getMediaAsset(plan.sourceMedia.assetId) : null;
  if (frameRow) await addMedia("source-frame", frameRow.storage_ref, frameRow.checksum, "image/png", "Registered source frame (unedited), luv-scene-1 at 8 s");
  const plans = await store.listPlansForCase(PIN.caseId, 20);
  const revisions: DemoSnapshot["revisions"] = [];
  const memory: DemoMemory = { plans: [], stills: [] };
  let earlierAssumptions: unknown[] = [];
  for (const p of plans) {
    // The revision note is the human-directed assumption this version added to its predecessor.
    const stored = isObj(p.plan) ? p.plan : {};
    const assumptions = Array.isArray(stored.assumptions) ? stored.assumptions : [];
    const added = assumptions.filter((a): a is string => typeof a === "string" && !earlierAssumptions.includes(a) && /^Human-directed revision/.test(a));
    earlierAssumptions = assumptions;
    const placementRecord = isObj(stored.placement) ? stored.placement : {};
    const rebrand = isObj(stored.rebrand) ? stored.rebrand : {};
    memory.plans.push({
      version: p.version,
      planId: p.plan_id,
      createdAt: p.created_at,
      sha256: createHash("sha256").update(canonical(p.plan)).digest("hex"),
      mode: String(placementRecord.mode ?? "insert"),
      sceneId: p.scene_id,
      campaignId: p.campaign_id,
      revisionNote: added[added.length - 1] ?? null,
      addedObjects: typeof rebrand.addedObjects === "number" ? rebrand.addedObjects : null,
    });
    const [still] = await store.listMediaAssetsForPlan(p.plan_id, "edited-still", 1);
    if (!still) continue;
    const v = await store.getVisualReview(still.asset_id);
    memory.stills.push({ version: p.version, assetId: still.asset_id, createdAt: still.created_at, reviewedAt: v?.created_at ?? "" });
    const key = `edited-still-v${p.version}` as DemoMediaKey;
    await addMedia(key, still.storage_ref, still.checksum, "image/png", `Edited still v${p.version} (Gemini)`);
    revisions.push({ version: p.version, planId: p.plan_id, assetId: still.asset_id, checksum: still.checksum, decision: v?.decision ?? "pending", reasons: v?.reasons ?? [], media: key });
  }
  const preview: MediaAssetRow | null = await store.getMediaAsset(PIN.previewAssetId);
  if (!preview) return { ok: false, errors: ["The approved preview is not registered."] };
  await addMedia("preview-v3", preview.storage_ref, preview.checksum, "video/mp4", "Approved motion preview v3 (local FFmpeg fallback)");
  const previewReview = await store.getVisualReview(preview.asset_id);

  // The v4 Runway full-scene video: shown only when it revalidates and its human review names its exact bytes.
  const fullSceneLoad = await loadVerifiedFullScene({ workflow, store, storage }, LUV_V4_RUNWAY);
  const fullSceneReview = fullSceneLoad.ok ? await store.getVisualReview(fullSceneLoad.row.asset_id) : null;
  let fullScene: DemoFullScene | null = null;
  if (fullSceneLoad.ok && fullSceneReview && fullSceneReview.asset_checksum === fullSceneLoad.row.checksum) {
    const row = fullSceneLoad.row;
    const p = row.provenance as FullSceneProvenance;
    await addMedia("full-scene-v4", row.storage_ref, row.checksum, "video/mp4", FULL_SCENE_LABEL);
    fullScene = {
      assetId: row.asset_id,
      label: FULL_SCENE_LABEL,
      disclosure: FULL_SCENE_DISCLOSURE,
      productionFinal: false,
      checksum: row.checksum,
      durationSeconds: p.video.durationSeconds,
      sourceDurationSeconds: p.video.sourceDurationSeconds,
      width: p.video.width,
      height: p.video.height,
      videoCodec: p.video.codec,
      frameRate: p.video.frameRate,
      audioCodec: p.video.audio.codec,
      generator: row.generator ?? "unknown",
      model: row.model ?? "unknown",
      taskId: p.runway.taskId,
      chargedCredits: p.runway.chargedCredits,
      costUsd: Number(row.cost_usd),
      sourceVideoChecksum: p.sourceVideo.checksum,
      referenceStillChecksum: p.referenceStill.checksum,
      decision: fullSceneReview.decision,
      reasons: fullSceneReview.reasons,
      limitations: fullSceneReview.limitations,
      reviewedAt: fullSceneReview.created_at,
    };
  }
  await addMedia("iris-portrait", IRIS_MEDIA.portrait.ref, IRIS_MEDIA.portrait.checksum, "image/png", "Iris Vale portrait (Masky avatar image)");
  await addMedia("iris-audio", IRIS_MEDIA.audio.ref, IRIS_MEDIA.audio.checksum, "audio/mpeg", "Iris Vale spoken result (Masky)");

  // Governor review and human approval.
  const reviewRow = await store.getReview(PIN.reviewId);
  const approval = reviewRow ? await store.getApprovalForReview(reviewRow.review_id) : null;
  if (!reviewRow || !approval) return { ok: false, errors: ["The Governor review or human approval is not stored."] };
  const review = reviewRow.review as GovernorReview;

  // Agent decisions and evaluations from the same deterministic trace LangSmith received.
  const trace = await buildCaseTrace(store, { caseId: PIN.caseId, project: PUBLISHED_CASE_TRACE.project, secrets: [] });
  if (!trace.ok) return { ok: false, errors: trace.errors };
  const decisionOf = (prefix: string) => {
    const run = trace.trace.runs.find((r) => r.name.startsWith(prefix));
    const m = run && isObj(run.extra.metadata) ? run.extra.metadata : {};
    return String(m.outcome ?? "unknown");
  };

  // Live, read-only verification.
  const evidence = (planId: string) => evaluatePreviewEvidence({ workflow, store, storage }, planId);
  const previewEvidence = await evidence(PIN.planId);
  const disclosure = await deriveVisualDisclosure({ workflow, store, evidence }, PIN.planId);
  const previews = new PersistentPreviewRegistry(workflow);
  await previews.refresh(PIN.planId);
  const reviewErrors = validateGovernorReview(review, { caseId: PIN.caseId, decision: reviewRow.decision, artifactId: PIN.planId }, previews);
  const bucket = storage.bucketConfig ? await mediaBucketReadiness({ bucketConfig: (b) => storage.bucketConfig!(b) }) : ["Bucket configuration is not readable here."];
  const planSha = createHash("sha256").update(canonical(plan)).digest("hex");

  // Per-agent HHH and Groundedness, by fixed rules over the trace and the registry (agents/observability/agent-evaluations.ts).
  // Run IDs are deterministic: per-run links are used only when the rebuilt trace is the published one.
  const P = PUBLISHED_CASE_TRACE;
  const samePublishedTrace = trace.root.id === P.traceId && trace.trace.runs.length === P.runs && trace.trace.feedback.length === P.feedback;
  const runLink = (runId: string) => (samePublishedTrace ? P.link.replace(`/r/${P.traceId}?`, `/r/${runId}?`) : P.link);
  const frameRegistered = Boolean(frameRow && media.find((m) => m.key === "source-frame")?.verified && isObj(frameRow.provenance) && frameRow.provenance.sceneId === scene.id);
  const match = matchCampaignToScene(campaign, scene, title);
  const agentEvaluations = {
    method: EVALUATION_METHOD,
    runLinks: samePublishedTrace ? ("per-run" as const) : ("parent-trace" as const),
    rows: evaluateAgents({
      runs: trace.trace.runs.map((r) => {
        const m = isObj(r.extra.metadata) ? r.extra.metadata : {};
        return { id: r.id, name: r.name, role: typeof m.agent_role === "string" ? m.agent_role : null, outcome: String(m.outcome ?? "") };
      }),
      scores: Object.fromEntries(trace.evaluations.map((e) => [e.key, e.score])),
      personas: Object.fromEntries(AGENT_ROLES.map((r) => [r, { name: AGENT_IDENTITIES[r].characterName, title: AGENT_IDENTITIES[r].title }])) as Record<AgentRole, { name: string; title: string }>,
      runLink,
      curator: { caseTitleId: caseRow.title_id, titleId: title.id, rightsStatus: title.rightsStatus, rating: title.rating, sensitivity: title.contentSensitivity.level, eligibleNow: getEligibility(title).eligible, placementReviewAllowed: canStartPlacementReview(title) },
      scout: { sceneId: scene.id, planSceneId: plans.every((p) => p.scene_id === scene.id) ? scene.id : "differs", checks: scene.checks.map((c) => ({ id: c.id, outcome: c.outcome })), sourceFrameRegistered: frameRegistered },
      matcher: { campaignId: campaign.id, planCampaignId: plans.every((p) => p.campaign_id === campaign.id) ? campaign.id : "differs", decisionNow: match.decision, audience: match.audienceRules.map((r) => ({ label: r.label, outcome: r.outcome })), safety: match.safetyChecks.map((c) => ({ outcome: c.outcome })) },
      director: { planVersions: plans.length, finalPlanHashMatches: planSha === PIN.planSha256, disclosureDerived: disclosure.status === "derived", negativeConstraints: plan.negativeConstraints.length, stillDecisions: [...revisions].sort((a, b) => a.version - b.version).map((r) => ({ version: r.version, decision: r.decision })), sourceFrameRegistered: frameRegistered },
      governor: { decision: reviewRow.decision, blockers: review.blockers?.length ?? 0, reviewRuleErrors: reviewErrors.length },
    }),
  };
  const verifiedMedia = media.filter((m) => m.verified).length;
  const recorded = deps.recordedChecks;

  const irisVerified = media.filter((m) => m.key.startsWith("iris-")).every((m) => m.verified) && Boolean(deps.ledger);
  const snapshot: DemoSnapshot = {
    version: DEMO_SNAPSHOT_VERSION,
    generatedAt: deps.now().toISOString(),
    commit: deps.commit,
    case: { caseId: caseRow.case_id, status: caseRow.status, titleId: title.id, titleName: title.title, sceneId: scene.id, sceneName: scene.name, campaignId: campaign.id, product: campaign.product, advertiser: campaign.advertiser, createdAt: caseRow.created_at },
    agents: AGENT_ROLES.map((role) => ({
      role,
      name: AGENT_IDENTITIES[role].title,
      responsibility: RESPONSIBILITIES[role],
      decision:
        role === "content-curator" ? decisionOf("Content Curator") : role === "scene-scout" ? decisionOf("Scene Scout") : role === "campaign-matcher" ? decisionOf("Campaign Matcher") : role === "placement-director" ? `instructions-ready (plan v${plan.planId.split(":v").pop()})` : reviewRow.decision,
      evidence:
        role === "content-curator" ? `${title.title}: rights ${title.rightsStatus}, rating ${title.rating}` : role === "scene-scout" ? `${scene.name}: ${scene.checks.filter((c) => c.outcome === "pass").length}/${scene.checks.length} guardrails pass` : role === "campaign-matcher" ? `${campaign.product} for adult, ad-supported viewers` : role === "placement-director" ? `${plans.length} plan versions; v1 and v2 revised after human review` : `${(review.checks ?? []).filter((c) => c.outcome === "pass").length}/${(review.checks ?? []).length} checks pass; human approval pending at review time`,
    })),
    plan: {
      planId: plan.planId,
      version: Number(plan.planId.split(":v").pop()),
      sha256: planSha,
      mode: String((plan.placement as Record<string, unknown>).mode ?? "insert"),
      region: plan.placement.region,
      description: plan.placement.description,
      stillPrompt: plan.prompts.stillImageEdit.prompt,
      motionPrompt: plan.prompts.motion.prompt,
      negativeConstraints: plan.negativeConstraints,
      disclosure: disclosure.status === "derived" ? disclosure.disclosure : "The visual disclosure could not be derived from provenance.",
    },
    revisions,
    preview: {
      assetId: preview.asset_id,
      checksum: preview.checksum,
      durationSeconds: Number(preview.duration_seconds),
      generator: preview.generator ?? "unknown",
      model: preview.model ?? "unknown",
      latencyMs: Number(preview.latency_ms),
      costUsd: Number(preview.cost_usd),
      decision: previewReview?.decision ?? "pending",
      reasons: previewReview?.reasons ?? [],
      reviewedAt: previewReview?.created_at ?? "",
    },
    fullScene,
    governor: {
      reviewId: reviewRow.review_id,
      decision: reviewRow.decision,
      at: reviewRow.created_at,
      hhh: (["helpful", "honest", "harmless"] as const).map((k) => ({ key: k, outcome: outcome(review.hhh?.[k]?.outcome), rationale: review.hhh?.[k]?.rationale ?? "" })),
      checks: (review.checks ?? []).map((c) => ({ id: c.id, category: c.category, outcome: outcome(c.outcome), detail: c.detail })),
      blockers: review.blockers?.length ?? 0,
    },
    approval: { approvalId: approval.approval_id, at: approval.created_at, decision: approval.decision, reviewerName: approval.reviewer_name, reasons: approval.reasons, caseStatus: caseRow.status },
    masky: {
      avatarId: deps.ledger?.avatarId ?? "not recorded",
      voiceName: deps.ledger?.voiceName ?? "not recorded",
      speechJobId: deps.ledger?.speechJobId ?? "not recorded",
      audioSeconds: IRIS_MEDIA.audio.seconds,
      identities: AGENT_ROLES.map((role) => {
        const i = AGENT_IDENTITIES[role];
        const live = role === "content-curator" && irisVerified;
        return { role, name: i.characterName, title: i.title, personality: i.personality, caption: i.spokenLine, mode: live ? "masky" : "fallback", portraitSvg: live ? null : portraitSvg(i), primary: i.prominence === "primary" };
      }),
    },
    langsmith: { ...PUBLISHED_CASE_TRACE, evaluations: trace.evaluations },
    agentEvaluations,
    memory,
    reliability: [
      { label: "Plan v3 is the approved, unchanged plan", outcome: planSha === PIN.planSha256 ? "pass" : "fail", evidence: `Canonical sha256 ${planSha.slice(0, 16)}… ${planSha === PIN.planSha256 ? "matches" : "does NOT match"} the approved hash.`, kind: "live" },
      { label: "Media bytes match their registered checksums", outcome: verifiedMedia === media.length ? "pass" : "fail", evidence: `${verifiedMedia} of ${media.length} private objects verified by sha256 at snapshot time; served only after a second check.`, kind: "live" },
      { label: "Approved preview revalidates with its human review", outcome: previewEvidence.outcome === "pass" ? "pass" : "fail", evidence: previewEvidence.outcome === "pass" ? "Plan binding, approved source still, generator provenance, private bytes, and the approved visual review all revalidate." : "Preview evidence did not pass.", kind: "live" },
      {
        label: "Runway full-scene preview revalidates with its human review",
        outcome: fullScene ? "pass" : "fail",
        evidence: fullScene
          ? `Task ${fullScene.taskId}, ${fullScene.chargedCredits} credits; source video, approved reference still, output bytes, and the human review (${fullScene.decision}) all revalidate.`
          : `Not shown: ${fullSceneLoad.ok ? "no human visual review of these exact bytes is recorded." : fullSceneLoad.errors[0]}`,
        kind: "live",
      },
      { label: "Governor review revalidates", outcome: reviewErrors.length === 0 ? "pass" : "fail", evidence: reviewErrors.length === 0 ? "The stored approve-for-human-review passes every review rule against the registered preview." : `${reviewErrors.length} rule(s) fail.`, kind: "live" },
      { label: "Human approval recorded; case approved", outcome: caseRow.status === "approved" && approval.reasons.length > 0 ? "pass" : "fail", evidence: `${approval.reasons.length} reasons recorded append-only; the case moved to approved in the same transaction.`, kind: "live" },
      { label: "Private media bucket", outcome: bucket.length === 0 ? "pass" : "fail", evidence: bucket.length === 0 ? "nf-media is private and explicitly allows only the required media types." : bucket.join(" "), kind: "live" },
      ...(recorded
        ? recorded.results.map((r) => ({ label: r.label, outcome: (r.ok ? "pass" : "fail") as Outcome, evidence: `${r.detail} (npm run demo:verify, ${recorded.ranAt}, commit ${recorded.commit})`, kind: "recorded" as const }))
        : [{ label: "Tests, lint, typecheck, build, dependency audit", outcome: "not-evaluated" as Outcome, evidence: "Not run in this session: run npm run demo:verify before presenting.", kind: "recorded" as const }]),
      { label: "Secret scan of every commit", outcome: "pass", evidence: "No credential pattern or configured secret value in any of 60 commits; only fake test fixtures under agents/tests (SECURITY.md, 2026-10-19).", kind: "recorded" },
      { label: "Snyk Open Source (production)", outcome: "pass", evidence: "2026-10-19, snyk@1.1308.1 test --all-projects: no vulnerable paths in 116 production dependencies after pinning next 16.4.1, which resolved SNYK-JS-NEXT-21243979 (critical) and SNYK-JS-NEXT-21246253 (high). Monitored with snyk monitor (SECURITY.md).", kind: "recorded" },
      { label: "Snyk Open Source (development only)", outcome: "fail", evidence: "2026-10-19, after the upgrade: 3 high and 2 medium advisories in lint tooling (braces, picomatch, uri-js), none with a published fix; not shipped (SECURITY.md).", kind: "recorded" },
      { label: "Snyk Code", outcome: "not-evaluated", evidence: "Not available for this organization (HTTP 403, SNYK-CODE-0005), 2026-10-19: neither passed nor failed.", kind: "recorded" },
      { label: "LangSmith trace published and read back", outcome: "pass", evidence: `${PUBLISHED_CASE_TRACE.runs} runs and ${PUBLISHED_CASE_TRACE.feedback} evaluations verified read-only on ${PUBLISHED_CASE_TRACE.verifiedAt.slice(0, 10)}.`, kind: "recorded" },
    ],
    limitations: [
      "Reactor is the intended motion provider. Its recovered clips are kept only as secondary integration evidence (the moving cup lettering is distorted) and are not in the workflow registry, so they are not played here. The primary output is the human-reviewed Runway Aleph full-scene preview when it revalidates; the Governor-reviewed 3.5 s local FFmpeg fallback remains the case's approved preview.",
      "Masky's affordable plan allows two avatars: Iris Vale (Content Curator) is a real Masky identity with stored audio; the other four agents use NativeFrame's deterministic local portraits and captions.",
      "The LangSmith trace is a historical replay of the recorded case, shifted by one constant offset into LangSmith's 24-hour ingestion window; recorded times are kept on every run.",
      "The Governor review relied on the plan's historical \"not-executed\" prompt labels; the human approval records the correction and the prompt_label_currency evaluation honestly scores 0.",
      "The simulated A/B experiment and its Scale, Revise, or Stop recommendation are not implemented; no experiment result is shown.",
      "Snyk Open Source found a critical Next.js 16.4.0 advisory on 2026-10-19; pinning next 16.4.1 resolved it, and the production re-test passes. Snyk Code is not available for this organization (HTTP 403), so a targeted code review stands in for it.",
      `The Runway Aleph full-scene preview is not production-final: ${LUV_V4_RUNWAY_LIMITATION_NOTE}`,
    ],
    media,
  };
  const errors = validateDemoSnapshot(snapshot);
  if (approval.reviewer_user_id && JSON.stringify(snapshot).includes(approval.reviewer_user_id)) errors.push("The snapshot contains a reviewer identifier.");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot, files };
}
