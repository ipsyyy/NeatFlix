import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { catalogue } from "@/data/catalogue";
import { campaigns } from "@/data/campaigns";
import { getSceneReview } from "@/data/scene-candidates";
import { matchCampaignToScene } from "@/lib/campaigns/matching";

/** The registered source clip asset:luv-hypothesis:source-video:v1 (verified 20.064 s, 1280×720, video/mp4). */
const SOURCE_DURATION_SECONDS = 20.064;
const luv = catalogue.find((t) => t.id === "luv-hypothesis")!;
const review = getSceneReview("luv-hypothesis")!;

describe("LUV scenes match the registered source video", () => {
  it("uses the source clip's whole-second runtime and keeps the case and title IDs", () => {
    assert.equal(luv.durationSeconds, Math.floor(SOURCE_DURATION_SECONDS));
    assert.equal(review.caseId, "NF-DEMO-0001");
    assert.equal(review.titleId, "luv-hypothesis");
  });

  it("keeps every scene window inside the source, with start before end", () => {
    assert.equal(review.scenes.length, 3);
    for (const s of review.scenes) {
      assert.ok(s.startSeconds >= 0 && s.startSeconds < s.endSeconds, s.id);
      assert.ok(s.endSeconds <= luv.durationSeconds && s.endSeconds <= SOURCE_DURATION_SECONDS, s.id);
    }
  });

  it("recommends exactly one scene, luv-scene-1, which Daybreak Cold Brew still matches", () => {
    const recommended = review.scenes.filter((s) => s.decision === "recommended");
    assert.deepEqual(recommended.map((s) => s.id), ["luv-scene-1"]);
    const daybreak = campaigns.find((c) => c.id === "daybreak-cold-brew")!;
    assert.equal(matchCampaignToScene(daybreak, recommended[0], luv).decision, "recommended");
  });

  it("places the representative frame inside luv-scene-1 and nowhere else", () => {
    const scene1 = review.scenes.find((s) => s.id === "luv-scene-1")!;
    assert.equal(scene1.representativeFrameSeconds, 8);
    assert.ok(scene1.representativeFrameSeconds! >= scene1.startSeconds && scene1.representativeFrameSeconds! <= scene1.endSeconds);
    assert.ok(review.scenes.filter((s) => s.id !== "luv-scene-1").every((s) => s.representativeFrameSeconds === undefined));
  });

  it("states the existing cups and nearby hands instead of claiming an empty table", () => {
    const scene1 = review.scenes.find((s) => s.id === "luv-scene-1")!;
    const text = [scene1.rationale, scene1.surface, ...scene1.checks.map((c) => c.evidence)].join(" ");
    assert.match(text, /two existing takeaway cups/);
    assert.match(text, /pastry/);
    assert.match(text, /straw/);
    assert.doesNotMatch(text, /table is (clear|empty)\b|no (hand|interaction)/i);
  });

  it("removes the retired lab-desk, hallway, and impossible-timestamp facts", () => {
    for (const s of review.scenes) {
      const text = JSON.stringify(s);
      assert.doesNotMatch(text, /lab desk|hallway|campus café/i, s.id);
      for (const t of [42, 47, 78, 83, 124, 129]) assert.ok(s.startSeconds !== t && s.endSeconds !== t, `${s.id} uses retired ${t}s`);
    }
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n)] : []));
    for (const path of [...files("data"), ...files("agents").filter((p) => !p.startsWith(join("agents", "tests")))]) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /lab desk/i, path);
    }
  });

  it("keeps the 3–5 minute rule for every title without an approved source clip", () => {
    for (const t of catalogue.filter((t) => t.id !== "luv-hypothesis")) {
      assert.ok(t.durationSeconds >= 180 && t.durationSeconds <= 300, t.id);
    }
  });
});
