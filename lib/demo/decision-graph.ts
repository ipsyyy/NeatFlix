import type { DemoSnapshot } from "./snapshot";

/**
 * The Decision Memory Graph: a deterministic, read-only projection of one
 * case's append-only workflow records, as copied into the verified demo
 * snapshot. It adds no record and infers nothing: every node names the stored
 * record it comes from, and a node is omitted when that record is absent.
 * It is recorded memory, not learning: a new case becomes part of it only when
 * its append-only records are included in a future snapshot.
 */

export const GRAPH_LABEL = "Recorded decision memory — read-only.";
export const MEMORY_NOTE =
  "Nothing here learns or changes on its own. A new recorded case becomes memory only when its append-only workflow records are included in a future snapshot.";

export const NODE_TYPES = [
  "Case",
  "Title",
  "Scene",
  "Product/Campaign",
  "Agent",
  "Plan",
  "Media",
  "Human Review",
  "Governor Decision",
  "Evidence",
  "Evaluation",
  "Failure/Limitation",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Visual class: rejected, approved, evidence, agent, limitation, or neutral context. */
export type NodeTone = "rejected" | "approved" | "evidence" | "agent" | "limitation" | "context";

/** The stored record a node projects, by source and identifier. */
export type RecordRef = {
  source: "cases" | "catalogue-fixture" | "band-agent" | "placement_plans" | "media_assets" | "media_visual_reviews" | "governor_reviews" | "human_approvals" | "langsmith-trace" | "langsmith-evaluation";
  id: string;
};

export type GraphNode = {
  id: string;
  type: NodeType;
  label: string;
  tone: NodeTone;
  outcome: string;
  timestamp: string;
  /** A checksum, hash, or other safe identifier; never a storage path or person identifier. */
  identifier: string;
  explanation: string;
  record: RecordRef;
  /** Layout column, left to right. */
  column: number;
};

export type GraphEdge = { from: string; to: string; label: string };
export type DecisionGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

const COLUMNS = ["Case", "Agents", "Plans", "Media", "Reviews", "Decisions & evidence"] as const;
export const GRAPH_COLUMNS: readonly string[] = COLUMNS;

/**
 * Whether a plan's recorded revision note cites a rejected still: by its asset
 * ID, or by the note's own wording ("Edited stills v1 and v2 were rejected").
 */
export function revisionCites(note: string | null | undefined, rejected: { version: number; assetId: string }): boolean {
  if (!note) return false;
  if (note.includes(rejected.assetId)) return true;
  const named = /edited stills? ((?:v\d+)(?:(?:, | and )v\d+)*) (?:was|were) rejected/i.exec(note);
  return Boolean(named && named[1].toLowerCase().split(/, | and /).includes(`v${rejected.version}`));
}

const tone = (decision: string): NodeTone => (decision === "rejected" ? "rejected" : decision.startsWith("approve") ? "approved" : "context");

export function buildDecisionGraph(s: DemoSnapshot): DecisionGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => nodes.push(n);
  const link = (from: string, to: string, label: string) => edges.push({ from, to, label });
  const media = (key: string) => s.media.find((m) => m.key === key && m.verified);

  // Case context.
  add({ id: "case", type: "Case", label: s.case.caseId, tone: "context", outcome: s.case.status, timestamp: s.case.createdAt, identifier: s.case.caseId, explanation: `Placement case for ${s.case.product} in ${s.case.titleName}.`, record: { source: "cases", id: s.case.caseId }, column: 0 });
  add({ id: "title", type: "Title", label: s.case.titleName, tone: "context", outcome: "eligible", timestamp: "", identifier: s.case.titleId, explanation: "Fictional catalogue title the case places into.", record: { source: "catalogue-fixture", id: s.case.titleId }, column: 0 });
  add({ id: "scene", type: "Scene", label: s.case.sceneName, tone: "context", outcome: "selected", timestamp: "", identifier: s.case.sceneId, explanation: "The scene selected for the placement.", record: { source: "catalogue-fixture", id: s.case.sceneId }, column: 0 });
  add({ id: "campaign", type: "Product/Campaign", label: s.case.product, tone: "context", outcome: "matched", timestamp: "", identifier: s.case.campaignId, explanation: `Fictional advertiser ${s.case.advertiser}.`, record: { source: "catalogue-fixture", id: s.case.campaignId }, column: 0 });
  link("case", "title", "title");
  link("case", "scene", "scene");
  link("case", "campaign", "product");

  // The five BAND agents.
  for (const a of s.agents) {
    const persona = s.masky.identities.find((i) => i.role === a.role);
    add({ id: `agent:${a.role}`, type: "Agent", label: `${a.name}${persona ? ` — ${persona.name}` : ""}`, tone: "agent", outcome: a.decision, timestamp: "", identifier: a.role, explanation: a.responsibility, record: { source: "band-agent", id: a.role }, column: 1 });
  }
  link("agent:content-curator", "title", "approved title");
  link("agent:scene-scout", "scene", "selected scene");
  link("agent:campaign-matcher", "campaign", "matched campaign");

  // Plans, their edited stills, and the human visual reviews.
  const plans = [...(s.memory?.plans ?? [])].sort((a, b) => a.version - b.version);
  for (const p of plans) {
    const id = `plan:v${p.version}`;
    add({
      id,
      type: "Plan",
      label: `Plan V${p.version}`,
      tone: "context",
      outcome: p.mode,
      timestamp: p.createdAt,
      identifier: `sha256:${p.sha256.slice(0, 16)}…`,
      explanation: p.revisionNote ?? "The Placement Director's first plan for this scene and product.",
      record: { source: "placement_plans", id: p.planId },
      column: 2,
    });
    link("agent:placement-director", id, "wrote");
    link(id, "scene", "targets");
  }
  if (media("source-frame")) {
    const m = media("source-frame")!;
    add({ id: "evidence:source-frame", type: "Evidence", label: "Registered source frame", tone: "evidence", outcome: "verified", timestamp: "", identifier: m.sha256, explanation: "The unedited frame at 8 s that every plan cites and every edit starts from.", record: { source: "media_assets", id: "source-frame" }, column: 2 });
    for (const p of plans) link(`plan:v${p.version}`, "evidence:source-frame", "cites");
  }
  for (const r of [...s.revisions].sort((a, b) => a.version - b.version)) {
    const still = s.memory?.stills.find((x) => x.version === r.version);
    const mediaId = `media:still-v${r.version}`;
    const reviewId = `review:still-v${r.version}`;
    add({ id: mediaId, type: "Media", label: `Edited still V${r.version}`, tone: tone(r.decision), outcome: r.decision, timestamp: still?.createdAt ?? "", identifier: r.checksum, explanation: `Gemini edited still from plan V${r.version}.`, record: { source: "media_assets", id: r.assetId }, column: 3 });
    add({ id: reviewId, type: "Human Review", label: `Edited still V${r.version} ${r.decision}`, tone: tone(r.decision), outcome: r.decision, timestamp: still?.reviewedAt ?? "", identifier: r.checksum, explanation: r.reasons.join(" "), record: { source: "media_visual_reviews", id: r.assetId }, column: 4 });
    if (plans.some((p) => p.version === r.version)) link(`plan:v${r.version}`, mediaId, "produced");
    link(mediaId, reviewId, "human review");
  }
  // A rejection informs the next plan exactly when that plan's recorded revision note cites the rejected asset.
  for (const p of plans) {
    for (const r of s.revisions) {
      if (r.decision === "rejected" && revisionCites(p.revisionNote, r)) link(`review:still-v${r.version}`, `plan:v${p.version}`, "informed");
    }
  }

  // The approved 3.5 s fallback preview, its review, the Governor, and the final human approval.
  const previewKey = s.preview.assetId.split(":").slice(-1)[0];
  add({ id: "media:preview", type: "Media", label: `${previewKey.replace(/^v(\d+)-fallback$/, "V$1 fallback")} preview`, tone: tone(s.preview.decision), outcome: s.preview.decision, timestamp: "", identifier: s.preview.checksum, explanation: `Deterministic ${s.preview.durationSeconds} s local FFmpeg fallback preview of the approved V3 still.`, record: { source: "media_assets", id: s.preview.assetId }, column: 3 });
  add({ id: "review:preview", type: "Human Review", label: `Preview ${s.preview.decision}`, tone: tone(s.preview.decision), outcome: s.preview.decision, timestamp: s.preview.reviewedAt, identifier: s.preview.checksum, explanation: s.preview.reasons.join(" ") || "Human visual review of the preview's exact bytes.", record: { source: "media_visual_reviews", id: s.preview.assetId }, column: 4 });
  link("media:still-v3", "media:preview", "source still");
  link("media:preview", "review:preview", "human review");
  add({ id: "governor", type: "Governor Decision", label: "Release Governor decision", tone: tone(s.governor.decision), outcome: s.governor.decision, timestamp: s.governor.at, identifier: s.governor.reviewId, explanation: `${s.governor.checks.filter((c) => c.outcome === "pass").length} of ${s.governor.checks.length} checks passed; ${s.governor.blockers} blockers.`, record: { source: "governor_reviews", id: s.governor.reviewId }, column: 5 });
  link("agent:release-governor", "governor", "decided");
  link("media:preview", "governor", "reviewed");
  add({ id: "approval", type: "Human Review", label: "Final human approval", tone: tone(s.approval.decision), outcome: s.approval.decision, timestamp: s.approval.at, identifier: s.approval.approvalId, explanation: s.approval.reasons.join(" "), record: { source: "human_approvals", id: s.approval.approvalId }, column: 5 });
  link("governor", "approval", "human release decision");

  // The Runway V4 full-scene video, its approved-with-limitation review, and the limitation.
  const f = s.fullScene;
  if (f && media("full-scene-v4")) {
    add({ id: "media:v4", type: "Media", label: "Runway V4 full-scene video", tone: tone(f.decision), outcome: "registered", timestamp: "", identifier: f.checksum, explanation: `${f.label}. ${f.disclosure}`, record: { source: "media_assets", id: f.assetId }, column: 3 });
    add({ id: "review:v4", type: "Human Review", label: `V4 ${f.decision}`, tone: tone(f.decision), outcome: f.decision, timestamp: f.reviewedAt, identifier: f.checksum, explanation: f.reasons.join(" ") || "Human visual review of the full-scene video's exact bytes.", record: { source: "media_visual_reviews", id: f.assetId }, column: 4 });
    link("media:still-v3", "media:v4", "reference still");
    link("media:v4", "review:v4", "human review");
    f.limitations.forEach((l, i) => {
      add({ id: `limitation:v4-${i}`, type: "Failure/Limitation", label: "Minor temporal typography instability", tone: "limitation", outcome: "disclosed", timestamp: f.reviewedAt, identifier: f.checksum, explanation: l, record: { source: "media_visual_reviews", id: f.assetId }, column: 5 });
      link("review:v4", `limitation:v4-${i}`, "records limitation");
    });
  }

  // LangSmith: the published trace and the zero-scored evaluation.
  add({ id: "evidence:trace", type: "Evidence", label: "LangSmith case trace", tone: "evidence", outcome: `${s.langsmith.runs} runs, ${s.langsmith.feedback} evaluations`, timestamp: s.langsmith.verifiedAt, identifier: s.langsmith.traceId, explanation: "Historical replay of this case's records, published once and read back.", record: { source: "langsmith-trace", id: s.langsmith.traceId }, column: 5 });
  link("case", "evidence:trace", "traced");
  const plc = s.langsmith.evaluations.find((e) => e.key === "prompt_label_currency");
  if (plc) {
    add({ id: "evaluation:prompt_label_currency", type: "Evaluation", label: `prompt_label_currency = ${plc.score}`, tone: plc.score === 1 ? "approved" : "limitation", outcome: String(plc.score), timestamp: s.langsmith.verifiedAt, identifier: s.langsmith.traceId, explanation: `${plc.comment} The zero reflects the Release Governor's stale "not-executed" prompt labels.`, record: { source: "langsmith-evaluation", id: "prompt_label_currency" }, column: 5 });
    link("evidence:trace", "evaluation:prompt_label_currency", "evaluation");
    link("governor", "evaluation:prompt_label_currency", "scored");
  }
  return { nodes, edges };
}

export type PriorRejection = { version: number; assetId: string; checksum: string; reasons: string[]; reviewedAt: string; informedPlans: string[] };

/**
 * "Has this product-scene pair been rejected before?": the human rejections
 * recorded for edited stills of plans with this campaign and scene, and the
 * later plans whose recorded revision note cites each rejected asset.
 */
export function priorRejections(s: DemoSnapshot, campaignId: string, sceneId: string): { answer: "yes" | "no"; rejections: PriorRejection[] } {
  const plans = s.memory?.plans ?? [];
  const forPair = new Set(plans.filter((p) => p.campaignId === campaignId && p.sceneId === sceneId).map((p) => p.version));
  const rejections = s.revisions
    .filter((r) => forPair.has(r.version) && r.decision === "rejected")
    .sort((a, b) => a.version - b.version)
    .map((r) => ({
      version: r.version,
      assetId: r.assetId,
      checksum: r.checksum,
      reasons: r.reasons,
      reviewedAt: s.memory?.stills.find((x) => x.version === r.version)?.reviewedAt ?? "",
      informedPlans: plans.filter((p) => revisionCites(p.revisionNote, r)).map((p) => `Plan V${p.version}`),
    }));
  return { answer: rejections.length > 0 ? "yes" : "no", rejections };
}
