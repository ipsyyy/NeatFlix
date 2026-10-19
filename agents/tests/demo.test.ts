import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEMO_MEDIA_KEYS, validateDemoSnapshot, type DemoSnapshot } from "@/lib/demo/snapshot";

const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const LINK = "https://smith.langchain.com/o/262ec4f0-5a5c-420c-baa8-d2beaf6ce18f/projects/p/4f41ade7-c79b-4d7b-ad45-7f91e1704c55/r/01a1420c-bcf8-7898-945f-0db7640aa8c0?trace_id=01a1420c-bcf8-7898-945f-0db7640aa8c0";

function snapshot(over: Partial<DemoSnapshot> = {}): DemoSnapshot {
  return {
    version: 1,
    generatedAt: "2026-10-17T07:00:00.000Z",
    commit: "abc1234",
    case: { caseId: "NF-DEMO-0001", status: "approved", titleId: "luv-hypothesis", titleName: "The LUV Hypothesis", sceneId: "luv-scene-1", sceneName: "Café", campaignId: "daybreak-cold-brew", product: "Daybreak Cold Brew", advertiser: "Daybreak Coffee", createdAt: "2026-10-16T00:11:33.496Z" },
    agents: Array.from({ length: 5 }, (_, i) => ({ role: `r${i}`, name: `A${i}`, responsibility: "x", decision: "y", evidence: "z" })),
    plan: { planId: "plan:x:y:v3", version: 3, sha256: "0".repeat(64), mode: "rebrand-existing-cups", region: "table", description: "d", stillPrompt: "s", motionPrompt: "m", negativeConstraints: [], disclosure: "d" },
    revisions: [],
    preview: { assetId: "asset:x", checksum: sha("p"), durationSeconds: 3.5, generator: "local-ffmpeg", model: "ffmpeg", latencyMs: 1, costUsd: 0, decision: "approved", reasons: [], reviewedAt: "" },
    governor: { reviewId: "review:x", decision: "approve-for-human-review", at: "", hhh: [], checks: [], blockers: 0 },
    approval: { approvalId: "a", at: "", decision: "approve", reviewerName: "NativeFrame project owner", reasons: [], caseStatus: "approved" },
    masky: { avatarId: "VDzafw3fD73I9SNZC6SY", voiceName: "v", speechJobId: "j", audioSeconds: 8.92, identities: [] },
    langsmith: { project: "p", traceId: "t", runs: 17, feedback: 12, link: LINK, verifiedAt: "", replayShiftMs: 1, recorded: { start: "", end: "" }, replayed: { start: "", end: "" }, evaluations: [] },
    reliability: [],
    limitations: [],
    media: [],
    ...over,
  };
}

describe("demo snapshot validation", () => {
  it("accepts a well-formed snapshot whose only URL is the verified LangSmith trace page", () => {
    assert.deepEqual(validateDemoSnapshot(snapshot()), []);
  });

  it("refuses private paths, keys, signed URLs, unexpected URLs, wrong agent counts, and unsafe media names", () => {
    const cases: [string, DemoSnapshot][] = [
      ["storage path", snapshot({ limitations: ["see storage://nf-media/agents/spoken/x.mp3"] })],
      ["LangSmith key", snapshot({ limitations: ["lsv2_pt_0123456789abcdef0123"] })],
      ["signed URL", snapshot({ limitations: ["/object/sign/nf-media/x.png?token=abc"] })],
      ["unexpected URL", snapshot({ limitations: ["https://project.supabase.co/x"] })],
      ["four agents", snapshot({ agents: snapshot().agents.slice(0, 4) })],
      ["path traversal file", snapshot({ media: [{ key: "preview-v3", file: "../snapshot.json", mimeType: "video/mp4", sha256: sha("x"), bytes: 1, verified: true, label: "x" }] })],
    ];
    for (const [name, s] of cases) assert.ok(validateDemoSnapshot(s).length > 0, name);
    assert.ok(validateDemoSnapshot("nope").length > 0);
  });
});

describe("demo media serving", () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-demo-"));
  const good = new Uint8Array([1, 2, 3, 4]);
  let load: typeof import("@/app/demo/load-snapshot");
  before(async () => {
    mkdirSync(join(dir, "media"));
    writeFileSync(join(dir, "media", "preview-v3.mp4"), good);
    writeFileSync(join(dir, "media", "edited-still-v1.png"), new Uint8Array([9, 9]));
    const s = snapshot({
      media: [
        { key: "preview-v3", file: "preview-v3.mp4", mimeType: "video/mp4", sha256: sha(good), bytes: 4, verified: true, label: "p" },
        { key: "edited-still-v1", file: "edited-still-v1.png", mimeType: "image/png", sha256: sha("other bytes"), bytes: 2, verified: true, label: "tampered" },
        { key: "edited-still-v2", file: "edited-still-v2.png", mimeType: "image/png", sha256: sha("x"), bytes: 0, verified: false, label: "unverified" },
      ],
    });
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(s));
    process.env.NATIVEFRAME_DEMO_DIR = dir;
    load = await import("@/app/demo/load-snapshot");
  });
  after(() => {
    delete process.env.NATIVEFRAME_DEMO_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves only listed, verified files whose bytes still match", async () => {
    const ok = await load.loadDemoMedia("preview-v3");
    assert.deepEqual(ok && [...ok.bytes], [1, 2, 3, 4]);
    assert.equal(await load.loadDemoMedia("edited-still-v1"), null, "bytes no longer match the checksum");
    assert.equal(await load.loadDemoMedia("edited-still-v2"), null, "unverified at snapshot time");
    assert.equal(await load.loadDemoMedia("edited-still-v3"), null, "not listed");
    for (const bad of ["../snapshot.json", "snapshot", "preview-v3.mp4", ""]) assert.equal(await load.loadDemoMedia(bad), null, bad);
    assert.ok(DEMO_MEDIA_KEYS.includes("preview-v3"));
    const loaded = await load.loadDemoSnapshot();
    assert.ok(loaded.ok);
  });
});
