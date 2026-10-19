/**
 * The demo snapshot: a read-only, verified copy of NativeFrame's approved
 * records for case NF-DEMO-0001, built server-side by `npm run demo:snapshot`
 * (agents/demo/build-snapshot.ts) into the git-ignored `.demo/` directory.
 * It holds identifiers, decisions, reasons, checksums, and evidence only:
 * never storage paths, signed URLs, credentials, or person identifiers.
 * Media bytes are copied beside it and served only after a checksum check.
 */

export const DEMO_SNAPSHOT_VERSION = 1;

export const DEMO_MEDIA_KEYS = ["source-frame", "edited-still-v1", "edited-still-v2", "edited-still-v3", "preview-v3", "iris-portrait", "iris-audio"] as const;
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

export type Outcome = "pass" | "fail" | "not-evaluated";
export type EvidenceKind = "live" | "recorded";

export type DemoSnapshot = {
  version: typeof DEMO_SNAPSHOT_VERSION;
  generatedAt: string;
  commit: string;
  case: { caseId: string; status: string; titleId: string; titleName: string; sceneId: string; sceneName: string; campaignId: string; product: string; advertiser: string; createdAt: string };
  agents: { role: string; name: string; responsibility: string; decision: string; evidence: string }[];
  plan: { planId: string; version: number; sha256: string; mode: string; region: string; description: string; stillPrompt: string; motionPrompt: string; negativeConstraints: string[]; disclosure: string };
  revisions: { version: number; planId: string; assetId: string; checksum: string; decision: string; reasons: string[]; media: DemoMediaKey }[];
  preview: { assetId: string; checksum: string; durationSeconds: number; generator: string; model: string; latencyMs: number; costUsd: number; decision: string; reasons: string[]; reviewedAt: string };
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
  const text = JSON.stringify(value);
  if (UNSAFE.test(text)) e.push("The demo snapshot contains a private path, key, or signed URL.");
  const urls = text.match(/https?:\/\/[^"\\\s]+/g) ?? [];
  if (urls.some((u) => !ALLOWED_URL.test(u) && u !== "http://www.w3.org/2000/svg")) e.push("The demo snapshot contains an unexpected URL.");
  return e;
}
