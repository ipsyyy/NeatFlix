import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignSummary } from "@/components/campaign/campaign-summary";
import { DEMO_STEPS } from "@/components/demo/steps";
import { ApprovedPreview } from "@/components/placement/placement-replay";
import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { rankCampaignMatches } from "@/lib/campaigns/matching";
import { placementPreviewPath, recordedReplayFor, REPLAY_DISCLOSURE, replayDurationMs } from "@/lib/placement/replay";
import type { DemoSnapshot } from "@/lib/demo/snapshot";

const ROOT = process.cwd();
const SNAPSHOT = join(ROOT, ".demo", "snapshot.json");
const snapshot = existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as DemoSnapshot) : null;
const noSnapshot = snapshot?.fullScene ? false : "no .demo snapshot: run npm run demo:snapshot";

const replay = recordedReplayFor("luv-hypothesis", "luv-scene-1")!;
const title = catalogue.find((t) => t.id === "luv-hypothesis")!;
const scene = getSceneReview("luv-hypothesis")!.scenes.find((s) => s.id === "luv-scene-1")!;
const [best] = rankCampaignMatches(campaigns, scene, title);
const summary = (previewHref?: string) =>
  renderToStaticMarkup(createElement(CampaignSummary, { caseId: "NF-DEMO-0001", scene, campaign: best.campaign, match: best.match, previewHref }));

describe("campaign → placement preview", () => {
  it("the campaign button is an enabled link to the recorded case's preview", () => {
    const href = placementPreviewPath("luv-hypothesis", "luv-scene-1");
    assert.equal(href, "/titles/luv-hypothesis/scenes/luv-scene-1/preview");
    const html = summary(href);
    assert.match(html, new RegExp(`<a[^>]*href="${href}"[^>]*>Continue to placement preview`));
    assert.doesNotMatch(html, /disabled|Not built yet/);
    assert.match(html, /Replay the recorded placement pipeline and inspect its approved output\./);
  });

  it("the campaign workspace offers the link only for a scene with a recorded replay", () => {
    assert.equal(recordedReplayFor("luv-hypothesis", "luv-scene-2"), undefined);
    assert.match(summary(undefined), /<button[^>]*disabled/);
    const workspace = readFileSync(join(ROOT, "components", "campaign", "campaign-workspace.tsx"), "utf8");
    assert.match(workspace, /previewHref=\{recordedReplayFor\(title\.id, scene\.id\) \? placementPreviewPath\(title\.id, scene\.id\) : undefined\}/);
  });
});

describe("recorded pipeline replay", () => {
  it("states that it is a recorded replay with no provider call", () => {
    assert.equal(REPLAY_DISCLOSURE, "Recorded pipeline replay — no provider is called during this demo.");
  });

  it("replays the five agent stages, in order, in about 4–6 seconds", () => {
    assert.deepEqual(
      replay.steps.map((s) => `${s.agent} — ${s.outcome}`),
      [
        "Content Curator — Eligibility approved",
        "Scene Scout — Café scene selected",
        "Campaign Matcher — Daybreak Cold Brew recommended",
        "Placement Director — Rebrand the two existing cups",
        "Release Governor — Checks passed; sent for human review",
      ],
    );
    const ms = replayDurationMs(replay);
    assert.ok(ms >= 4000 && ms <= 6000, `${ms} ms`);
  });

  it("each stage matches the agent and decision recorded for the case", { skip: noSnapshot }, () => {
    const s = snapshot!;
    assert.equal(s.case.caseId, replay.caseId);
    assert.equal(s.case.product, replay.product);
    assert.deepEqual(replay.steps.map((x) => [x.role, x.agent]), s.agents.map((a) => [a.role, a.name]));
    assert.deepEqual(s.agents.map((a) => a.decision.split(" ")[0]), ["approve", "select", "recommended", "instructions-ready", "approve-for-human-review"]);
    assert.equal(s.governor.blockers, 0);
    // The limitation is the human reviewer's own wording.
    assert.deepEqual([replay.video.limitation], s.fullScene!.limitations);
    assert.equal(s.fullScene!.decision, replay.video.decision);
  });

  it("links to evidence that exists: the demo's human approval step", () => {
    assert.equal(replay.approvalEvidenceHref, "/demo#step-human");
    assert.ok(DEMO_STEPS.some((s) => `/demo#${s.id}` === replay.approvalEvidenceHref));
    assert.equal(replay.caseHref, "/demo");
  });
});

describe("approved video", () => {
  it("uses the public V4 path, with controls and no autoplay", () => {
    assert.equal(replay.video.src, "/demo-videos/luv-hypothesis-daybreak-v4.mp4");
    assert.ok(existsSync(join(ROOT, "public", replay.video.src)));
    const html = renderToStaticMarkup(createElement(ApprovedPreview, { replay, poster: "/artwork/the-luv-hypothesis-hero.png", unavailable: null }));
    assert.match(html, /<video[^>]*src="\/demo-videos\/luv-hypothesis-daybreak-v4\.mp4"/);
    assert.match(html, /<video[^>]*controls=""/);
    assert.doesNotMatch(html, /autoplay/i);
    assert.match(html, /Approved placement preview<\/h2>/);
    assert.match(html, /Generated earlier with Runway Aleph and approved with limitation\./);
    assert.match(html, /Fine generated cup lettering shows minor temporal instability during motion\./);
    for (const label of ["Play approved video", "View approval evidence", "View full case", "Replay pipeline"]) assert.match(html, new RegExp(label));
    assert.match(html, /href="\/demo#step-human"/);
    assert.match(html, /href="\/demo"/);
  });

  it("shows a clear unavailable message, with Play disabled, when the MP4 is missing", () => {
    const html = renderToStaticMarkup(createElement(ApprovedPreview, { replay, unavailable: "The source video file is missing." }));
    assert.doesNotMatch(html, /<video/);
    assert.match(html, /Approved placement preview unavailable\..*The source video file is missing\./);
    assert.match(html, /<button[^>]*disabled=""[^>]*>.*Play approved video/);
  });
});

describe("no generation or mutation", () => {
  it("the preview page and its components import no agent, provider SDK, or database code, and make no requests", () => {
    const files = [
      join("app", "titles", "[titleId]", "scenes", "[sceneId]", "preview", "page.tsx"),
      join("components", "placement", "placement-replay.tsx"),
      join("lib", "placement", "replay.ts"),
      join("components", "campaign", "campaign-summary.tsx"),
    ];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(src, /from "@\/agents|@runwayml|@google\/genai|@anthropic-ai|@band-ai|@reactor-team|supabase|masky/i, f);
      assert.doesNotMatch(src, /\bfetch\(|method:\s*"(POST|PUT|PATCH|DELETE)"|"use server"/, f);
    }
  });
});
