/**
 * The demo snapshot: a read-only, verified copy of NativeFrame's approved
 * records for case NF-DEMO-0001, built server-side by `npm run demo:snapshot`
 * (agents/demo/build-snapshot.ts) into the git-ignored `.demo/` directory.
 * It holds identifiers, decisions, reasons, checksums, and evidence only:
 * never storage paths, signed URLs, credentials, or person identifiers.
 * Media bytes are copied beside it and served only after a checksum check.
 */

export const DEMO_SNAPSHOT_VERSION = 1;

export const DEMO_MEDIA_KEYS = ["source-frame", "edited-still-v1", "edited-still-v2", "edited-still-v3", "preview-v3", "full-scene-v4", "iris-portrait", "iris-audio"] as const;
export type DemoMediaKey = (typeof DEMO_MEDIA_KEYS)[number];

export type DemoMedia = {
  key: DemoMediaKey;
  file: string;
  mimeType: "image/png" | "video/mp4" | "audio/mpeg";
  sha256: string;
  bytes: number;
  /** The bytes matched the registered checksum when the snapshot was built. */
  verified: boolean;
  label: string;
};

/** The on-screen label of the v4 full-scene video; it never claims production-final output. */
export const FULL_SCENE_LABEL = "Runway Aleph full-scene preview — human reviewed";

/** The registered, human-reviewed Runway full-scene video, when the snapshot verified it. */
export type DemoFullScene = {
  assetId: string;
  label: typeof FULL_SCENE_LABEL;
  disclosure: string;
  productionFinal: false;
  checksum: string;
  durationSeconds: number;
  sourceDurationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  frameRate: number;
  audioCodec: string;
  generator: string;
  model: string;
  taskId: string;
  chargedCredits: number;
  costUsd: number;
  sourceVideoChecksum: string;
  referenceStillChecksum: string;
  decision: string;
  reasons: string[];
  limitations: string[];
  reviewedAt: string;
};

/** Facts copied from the append-only plan and media records (no storage paths, no reviewer identifiers). */
export type DemoMemory = {
  plans: { version: number; planId: string; createdAt: string; sha256: string; mode: string; sceneId: string; campaignId: string; revisionNote: string | null; addedObjects: number | null }[];
  stills: { version: number; assetId: string; createdAt: string; reviewedAt: string }[];
};

export type Outcome = "pass" | "fail" | "not-evaluated";
export type EvidenceKind = "live" | "recorded";

/** Per-agent dimensions: the three HHH dimensions, and Groundedness kept separate. */
export const HHH_DIMENSIONS = ["helpful", "honest", "harmless"] as const;
export type AgentDimension = (typeof HHH_DIMENSIONS)[number] | "groundedness";
export type AgentEvaluation = { outcome: Outcome; basis: string; sources: string[] };
/** One BAND agent's rule-based evaluation, with its runs in the published LangSmith trace. */
export type DemoAgentEvaluation = {
  role: string;
  name: string;
  title: string;
  runs: { id: string; name: string; link: string }[];
} & Record<AgentDimension, AgentEvaluation>;

export type DemoSnapshot = {
  version: typeof DEMO_SNAPSHOT_VERSION;
  generatedAt: string;
  commit: string;
  case: { caseId: string; status: string; titleId: string; titleName: string; sceneId: string; sceneName: string; campaignId: string; product: string; advertiser: string; createdAt: string };
  agents: { role: string; name: string; responsibility: string; decision: string; evidence: string }[];
  plan: { planId: string; version: number; sha256: string; mode: string; region: string; description: string; stillPrompt: string; motionPrompt: string; negativeConstraints: string[]; disclosure: string };
  revisions: { version: number; planId: string; assetId: string; checksum: string; decision: string; reasons: string[]; media: DemoMediaKey }[];
  preview: { assetId: string; checksum: string; durationSeconds: number; generator: string; model: string; latencyMs: number; costUsd: number; decision: string; reasons: string[]; reviewedAt: string };
  /** Absent in snapshots built before the full-scene video was registered and reviewed. */
  fullScene?: DemoFullScene | null;
  governor: { reviewId: string; decision: string; at: string; hhh: { key: string; outcome: Outcome; rationale: string }[]; checks: { id: string; category: string; outcome: Outcome; detail: string }[]; blockers: number };
  approval: { approvalId: string; at: string; decision: string; reviewerName: string; reasons: string[]; caseStatus: string };
  masky: {
    avatarId: string;
    voiceName: string;
    speechJobId: string;
    audioSeconds: number;
    identities: { role: string; name: string; title: string; personality: string; caption: string; mode: "masky" | "fallback"; portraitSvg: string | null; primary: boolean }[];
  };
  langsmith: { project: string; traceId: string; runs: number; feedback: number; link: string; verifiedAt: string; replayShiftMs: number; recorded: { start: string; end: string }; replayed: { start: string; end: string }; evaluations: { key: string; score: number; comment: string }[] };
  /** Stored plan and still facts for the decision memory graph; absent in older snapshots. */
  memory?: DemoMemory | null;
  /** Absent in snapshots built before the per-agent evaluation existed. */
  agentEvaluations?: { method: string; runLinks: "per-run" | "parent-trace"; rows: DemoAgentEvaluation[] } | null;
  reliability: { label: string; outcome: Outcome; evidence: string; kind: EvidenceKind }[];
  limitations: string[];
  media: DemoMedia[];
};

/** The only URL a snapshot may contain: the verified LangSmith trace page. */
const ALLOWED_URL = /^https:\/\/smith\.langchain\.com\/o\/[0-9a-f-]{36}\/projects\/p\/[0-9a-f-]{36}\/r\/[0-9a-f-]{36}\?trace_id=[0-9a-f-]{36}$/;
// Written so the source itself never contains a key prefix literally (guarded in browser-reachable code).
const UNSAFE = /storage:\/\/|lsv2(?:_)|mky(?:_)|sk-ant-|sb(?:_)secret(?:_)|AIza[0-9A-Za-z_-]{20,}|token=|signedurl|\/object\/sign\//i;
const SHA = /^sha256:[0-9a-f]{64}$/;

/** Why a snapshot must not be shown: wrong shape, or it carries something private. */
export function validateDemoSnapshot(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["The demo snapshot is malformed."];
  const s = value as Partial<DemoSnapshot>;
  const e: string[] = [];
  if (s.version !== DEMO_SNAPSHOT_VERSION) e.push("Unsupported demo snapshot version.");
  for (const k of ["case", "plan", "preview", "governor", "approval", "masky", "langsmith"] as const) if (typeof s[k] !== "object" || s[k] === null) e.push(`The demo snapshot has no ${k}.`);
  if (!Array.isArray(s.agents) || s.agents.length !== 5) e.push("The demo snapshot must describe exactly five agents.");
  if (!Array.isArray(s.media) || !s.media.every((m) => DEMO_MEDIA_KEYS.includes(m.key) && SHA.test(m.sha256) && /^[a-z0-9-]+\.(png|mp4|mp3)$/.test(m.file))) e.push("The demo snapshot media list is invalid.");
  if (s.fullScene != null) {
    const f = s.fullScene;
    if (f.label !== FULL_SCENE_LABEL || f.productionFinal !== false) e.push("The full-scene video must carry its preview label and must not claim production-final output.");
    if (!SHA.test(f.checksum) || !SHA.test(f.sourceVideoChecksum) || !SHA.test(f.referenceStillChecksum)) e.push("The full-scene video checksums are invalid.");
    if (f.decision === "approved-with-limitation" && !(Array.isArray(f.limitations) && f.limitations.length > 0)) e.push("An approval with limitation must show its limitation.");
  }
  if (s.agentEvaluations != null) {
    const a = s.agentEvaluations;
    const dims: AgentDimension[] = [...HHH_DIMENSIONS, "groundedness"];
    if (!Array.isArray(a.rows) || a.rows.length !== 5) e.push("The agent evaluation must describe exactly five agents.");
    else if (!a.rows.every((r) => dims.every((d) => ["pass", "fail", "not-evaluated"].includes(r[d]?.outcome) && typeof r[d]?.basis === "string"))) e.push("Each agent needs an outcome and basis for every dimension.");
    if (typeof a.method !== "string" || !/no llm judge/i.test(a.method)) e.push("The agent evaluation must state that no LLM judge ran.");
  }
  const text = JSON.stringify(value);
  if (UNSAFE.test(text)) e.push("The demo snapshot contains a private path, key, or signed URL.");
  const urls = text.match(/https?:\/\/[^"\\\s]+/g) ?? [];
  if (urls.some((u) => !ALLOWED_URL.test(u) && u !== "http://www.w3.org/2000/svg")) e.push("The demo snapshot contains an unexpected URL.");
  return e;
}

/**
 * The video the demo presents as its primary output: the v4 full-scene video
 * when the snapshot verified its bytes and the human owner approved it (with or
 * without a limitation); otherwise the approved 3.5 s fallback preview.
 */
export function selectPrimaryVideo(s: Pick<DemoSnapshot, "fullScene" | "media">): { mediaKey: "full-scene-v4" | "preview-v3"; kind: "full-scene" | "fallback" } {
  const f = s.fullScene;
  const verified = s.media.some((m) => m.key === "full-scene-v4" && m.verified && m.sha256 === f?.checksum);
  if (f && verified && f.productionFinal === false && (f.decision === "approved" || f.decision === "approved-with-limitation")) return { mediaKey: "full-scene-v4", kind: "full-scene" };
  return { mediaKey: "preview-v3", kind: "fallback" };
}
