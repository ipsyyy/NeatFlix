import { createHash } from "node:crypto";
import { AGENT_MODEL } from "@/agents/config/model";
import type { AgentRole } from "@/agents/config/roles";
import type { GovernorReview } from "@/agents/handoff/governor-review";
import type { MediaAssetRow, ReviewRow, WorkflowStore } from "@/agents/persistence/store";
import { buildSystemPrompt } from "@/agents/runtime/prompts";
import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { matchCampaignToScene } from "@/lib/campaigns/matching";
import { canStartPlacementReview, getEligibility } from "@/lib/catalogue/eligibility";
import { TraceBuilder, type TraceRun } from "./langsmith";

/**
 * One LangSmith trace for a NativeFrame case, reconstructed read-only from the
 * immutable workflow registry (plans, media, human visual reviews, Release
 * Governor review, human approval) and the deterministic catalogue fixtures
 * the first three agents decide from. Every run says so in its metadata
 * (trace_source "registry-replay"): it is not live instrumentation. Timings
 * come from recorded timestamps and latencies; nothing is invented. The
 * evaluations are deterministic checks over the same records.
 */

export const CASE_TRACE_VERSION = "v1";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const promptVersion = (role: AgentRole) => createHash("sha256").update(buildSystemPrompt(role)).digest("hex").slice(0, 12);
const iso = (v: string | null | undefined, fallback: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback);
const minus = (t: string, ms: number | null) => new Date(Date.parse(t) - Math.max(0, ms ?? 0)).toISOString();

export type CaseTraceResult =
  | { ok: true; trace: TraceBuilder; root: TraceRun; evaluations: { key: string; score: number; comment: string }[] }
  | { ok: false; errors: string[] };

export async function buildCaseTrace(store: WorkflowStore, input: { caseId: string; project: string; secrets: readonly string[] }): Promise<CaseTraceResult> {
  const caseRow = await store.getCase(input.caseId);
  if (!caseRow) return { ok: false, errors: [`Case ${input.caseId} is not stored.`] };
  const plans = await store.listPlansForCase(input.caseId, 20);
  if (plans.length === 0) return { ok: false, errors: [`Case ${input.caseId} has no stored plan.`] };
  const title = catalogue.find((t) => t.id === caseRow.title_id);
  const latest = plans[plans.length - 1];
  const scene = title ? getSceneReview(title.id)?.scenes.find((s) => s.id === latest.scene_id) : undefined;
  const campaign = campaigns.find((c) => c.id === latest.campaign_id);
  if (!title || !scene || !campaign) return { ok: false, errors: ["The case's title, scene, or campaign is not in the catalogue fixtures."] };

  const reviews: ReviewRow[] = [...(await store.listReviewsForCase(input.caseId, 10))].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const media = new Map<string, { stills: MediaAssetRow[]; previews: MediaAssetRow[] }>();
  for (const p of plans) {
    media.set(p.plan_id, {
      stills: await store.listMediaAssetsForPlan(p.plan_id, "edited-still", 5),
      previews: await store.listMediaAssetsForPlan(p.plan_id, "generated-preview", 5),
    });
  }
  const approvals = new Map((await Promise.all(reviews.map(async (r) => [r.review_id, await store.getApprovalForReview(r.review_id)] as const))).filter(([, a]) => a));

  const trace = new TraceBuilder(input.project, input.secrets, `case:${input.caseId}:${CASE_TRACE_VERSION}`);
  const start = iso(caseRow.created_at, new Date().toISOString());
  const times = [caseRow.updated_at, ...plans.map((p) => p.created_at), ...reviews.map((r) => r.created_at), ...[...approvals.values()].map((a) => a!.created_at)];
  for (const m of media.values()) for (const a of [...m.stills, ...m.previews]) times.push(a.created_at);
  const end = new Date(Math.max(...times.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)))).toISOString();
  const common = { case_id: input.caseId, title_id: title.id, scene_id: scene.id, campaign_id: campaign.id, trace_source: "registry-replay", trace_version: CASE_TRACE_VERSION };

  const finalReview = reviews[reviews.length - 1];
  const finalApproval = finalReview ? approvals.get(finalReview.review_id) : undefined;
  const root = trace.add({
    key: "case",
    name: `NativeFrame case ${input.caseId}`,
    runType: "chain",
    start,
    end,
    inputs: { caseId: input.caseId, title: title.title, scene: scene.id, campaign: campaign.id },
    outputs: {
      caseStatus: caseRow.status,
      governorDecision: finalReview?.decision ?? "none",
      humanApproval: finalApproval ? "approved" : "none",
      approvedPlan: finalApproval ? finalReview!.plan_id : null,
      approvedPreview: finalApproval ? finalApproval.preview_asset_id : null,
      experimentRecommendation: "not evaluated: the simulated A/B experiment (Scale, Revise, Stop) is not implemented yet",
    },
    metadata: { ...common, outcome: caseRow.status, plan_versions: plans.length },
    tags: ["nativeframe", "case", "registry-replay"],
  });

  // 1–3. Deterministic agent decisions over the catalogue fixtures.
  const eligibility = getEligibility(title);
  const agent = (role: AgentRole, name: string) => ({ ...common, agent_name: name, agent_role: role, model: AGENT_MODEL, model_note: "configured agent model", prompt_version: promptVersion(role) });
  trace.add({
    key: "content-curator",
    name: "Content Curator: title eligibility",
    runType: "chain",
    start,
    end: start,
    parent: root,
    inputs: { titleId: title.id, rightsStatus: title.rightsStatus, rating: title.rating, contentSensitivity: title.contentSensitivity },
    outputs: { eligible: eligibility.eligible, placementReviewAllowed: canStartPlacementReview(title), reasons: eligibility.reasons },
    metadata: { ...agent("content-curator", "Content Curator"), outcome: eligibility.eligible ? "approve" : "reject", evidence: "catalogue fixture" },
  });
  trace.add({
    key: "scene-scout",
    name: "Scene Scout: scene selection",
    runType: "chain",
    start,
    end: start,
    parent: root,
    inputs: { titleId: title.id, sceneId: scene.id },
    outputs: { scene: scene.name, checks: scene.checks.map((c) => ({ id: c.id, outcome: c.outcome })) },
    metadata: { ...agent("scene-scout", "Scene Scout"), outcome: scene.checks.every((c) => c.outcome === "pass") ? "select" : "reject", evidence: "scene-candidate fixture" },
  });
  const match = matchCampaignToScene(campaign, scene, title);
  trace.add({
    key: "campaign-matcher",
    name: "Campaign Matcher: campaign match",
    runType: "chain",
    start,
    end: start,
    parent: root,
    inputs: { campaignId: campaign.id, sceneId: scene.id },
    outputs: { decision: match.decision, summary: match.summary, audience: match.audienceRules.map((r) => ({ label: r.label, outcome: r.outcome })) },
    metadata: { ...agent("campaign-matcher", "Campaign Matcher"), outcome: match.decision, evidence: "campaign fixture and deterministic matcher" },
  });

  // 4. Placement Director plans, their media, and the human visual reviews.
  const visualByAsset = new Map<string, { decision: string; checksum: string }>();
  for (const p of plans) {
    const plan = isObj(p.plan) ? p.plan : {};
    const placement = isObj(plan.placement) ? plan.placement : {};
    const planRun = trace.add({
      key: `plan:${p.plan_id}`,
      name: `Placement Director: plan v${p.version}`,
      runType: "chain",
      start: iso(p.created_at, start),
      end: iso(p.created_at, start),
      parent: root,
      inputs: { planId: p.plan_id, sceneId: p.scene_id, campaignId: p.campaign_id },
      outputs: { version: p.version, mode: placement.mode ?? "insert", region: placement.region ?? null, validation: p.validation_status },
      metadata: { ...agent("placement-director", "Placement Director"), outcome: "instructions-ready", plan_version: p.version },
    });
    const m = media.get(p.plan_id)!;
    for (const a of [...m.stills, ...m.previews]) {
      const generatedAt = iso(a.generated_at, iso(a.created_at, planRun.start_time));
      const mediaStart = minus(generatedAt, a.latency_ms);
      const mediaRun = trace.add({
        key: `media:${a.asset_id}`,
        name: `${a.kind === "edited-still" ? "Edited still" : "Motion preview"}: ${a.asset_id.split(":").slice(-1)[0]}`,
        runType: "tool",
        start: Date.parse(mediaStart) < Date.parse(planRun.start_time) ? planRun.start_time : mediaStart,
        end: generatedAt,
        parent: planRun,
        inputs: { planId: p.plan_id, kind: a.kind },
        outputs: { assetId: a.asset_id, checksum: a.checksum, mimeType: a.mime_type, durationSeconds: a.duration_seconds },
        metadata: { ...common, agent_name: "Placement Director media pipeline", generator: a.generator, model: a.model, latency_ms: a.latency_ms, cost_usd: a.cost_usd, outcome: "registered" },
      });
      const v = await store.getVisualReview(a.asset_id);
      if (v) {
        visualByAsset.set(a.asset_id, { decision: v.decision, checksum: v.asset_checksum });
        const visualRun = trace.add({
          key: `visual-review:${a.asset_id}`,
          name: `Human visual review: ${v.decision}`,
          runType: "chain",
          start: Date.parse(v.created_at) < Date.parse(mediaRun.start_time) ? mediaRun.start_time : v.created_at,
          end: Date.parse(v.created_at) < Date.parse(mediaRun.start_time) ? mediaRun.start_time : v.created_at,
          parent: mediaRun,
          inputs: { assetId: a.asset_id, assetChecksum: v.asset_checksum },
          outputs: { decision: v.decision, reasons: v.reasons },
          metadata: { ...common, agent_name: "Human owner", outcome: v.decision, checksum_matches_asset: v.asset_checksum === a.checksum },
        });
        trace.score(visualRun, "human_visual_decision", v.decision === "approved" ? 1 : 0, `Human owner recorded "${v.decision}" for these exact bytes.`);
      }
    }
  }

  // 5–6. Release Governor review and human approval.
  for (const r of reviews) {
    const review = r.review as GovernorReview;
    const reviewRun = trace.add({
      key: `governor:${r.review_id}`,
      name: `Release Governor: ${r.decision}`,
      runType: "chain",
      start: iso(r.created_at, end),
      end: iso(r.created_at, end),
      parent: root,
      inputs: { planId: r.plan_id, previewAssetId: r.preview_asset_id },
      outputs: {
        decision: r.decision,
        hhh: isObj(review?.hhh) ? Object.fromEntries(Object.entries(review.hhh).map(([k, v]) => [k, v.outcome])) : null,
        checks: Array.isArray(review?.checks) ? review.checks.map((c) => ({ id: c.id, category: c.category, outcome: c.outcome })) : [],
        blockers: review?.blockers?.length ?? 0,
      },
      metadata: { ...agent("release-governor", "Release Governor"), outcome: r.decision },
    });
    const a = approvals.get(r.review_id);
    if (a) {
      trace.add({
        key: `approval:${r.review_id}`,
        name: "Human approval: approve",
        runType: "chain",
        start: iso(a.created_at, end),
        end: iso(a.created_at, end),
        parent: reviewRun,
        inputs: { reviewId: r.review_id, previewAssetId: a.preview_asset_id },
        outputs: { decision: a.decision, reasons: a.reasons },
        metadata: { ...common, agent_name: "Human owner", outcome: "approved", reasons: a.reasons.length },
      });
    }
  }

  // Deterministic evaluations, recorded as feedback on the case run.
  const evaluations: { key: string; score: number; comment: string }[] = [];
  const evaluate = (key: string, score: number, comment: string) => {
    evaluations.push({ key, score, comment });
    trace.score(root, key, score, comment);
  };
  const final = finalReview?.review as GovernorReview | undefined;
  if (final && isObj(final.hhh)) {
    for (const k of ["helpful", "honest", "harmless"] as const) evaluate(`hhh_${k}`, final.hhh[k]?.outcome === "pass" ? 1 : 0, `Release Governor: ${final.hhh[k]?.outcome ?? "missing"}.`);
    const checks = Array.isArray(final.checks) ? final.checks : [];
    evaluate("governor_checks_pass_rate", checks.length ? checks.filter((c) => c.outcome === "pass").length / checks.length : 0, `${checks.filter((c) => c.outcome === "pass").length} of ${checks.length} checks passed.`);
  }
  const gate = Boolean(finalReview && finalReview.decision === "approve-for-human-review" && finalApproval && finalApproval.preview_asset_id === finalReview.preview_asset_id);
  evaluate("release_gate_respected", gate ? 1 : 0, gate ? "A Governor approve-for-human-review was followed by a human approval of the same preview." : "No Governor approval followed by a matching human approval.");
  const earlier = plans.slice(0, -1).flatMap((p) => media.get(p.plan_id)!.stills);
  const loop = earlier.length > 0 && earlier.every((s) => visualByAsset.get(s.asset_id)?.decision === "rejected");
  evaluate("revision_loop_completed", loop ? 1 : 0, loop ? `${earlier.length} earlier edited still(s) were rejected before the approved version.` : "No rejected earlier version precedes the approved one.");
  const previewId = finalReview?.preview_asset_id ?? null;
  const preview = previewId ? [...media.values()].flatMap((m) => m.previews).find((p) => p.asset_id === previewId) : undefined;
  const visual = previewId ? visualByAsset.get(previewId) : undefined;
  const previewOk = Boolean(preview && visual && visual.decision === "approved" && visual.checksum === preview.checksum);
  evaluate("preview_human_visual_approval", previewOk ? 1 : 0, previewOk ? "The approved preview has an approved human visual review of its exact checksum." : "The reviewed preview lacks an approved visual review of its exact bytes.");
  const reviewedPlanStills = finalReview ? media.get(finalReview.plan_id)?.stills.length ?? 0 : 0;
  // Only the review's statements count (rationales, details, assumptions, evidence, uncertainty), never check ids.
  const statements = final
    ? [
        ...Object.values(isObj(final.hhh) ? final.hhh : {}).map((h) => h?.rationale ?? ""),
        ...(Array.isArray(final.checks) ? final.checks.map((c) => c.detail) : []),
        ...(Array.isArray(final.assumptions) ? final.assumptions : []),
        ...(Array.isArray(final.evidence) ? final.evidence.map((e) => e.claim) : []),
        final.uncertainty ?? "",
      ].join("\n")
    : "";
  const stale = reviewedPlanStills > 0 && /not[- ]executed/i.test(statements);
  evaluate(
    "prompt_label_currency",
    stale ? 0 : 1,
    stale
      ? "The Governor review relies on the plan's historical not-executed prompt labels although media was produced from them; the human approval records the correction."
      : "The Governor review's prompt-execution statements match the registry.",
  );
  return { ok: true, trace, root, evaluations };
}
