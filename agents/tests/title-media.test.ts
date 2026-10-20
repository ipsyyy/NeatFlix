import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { checkSourceVideo, loadTitleMedia } from "@/app/load-title-media";
import { TitleMediaPanel } from "@/components/catalogue/title-video";
import { catalogue } from "@/data/catalogue";
import { getEligibility } from "@/lib/catalogue/eligibility";
import { HERO_PREVIEW_VIDEOS } from "@/lib/catalogue/hero-preview";
import { ffprobeVideo } from "@/agents/media/mp4-validate";
import {
  APPROVED_RESULT_HEADING,
  ORIGINAL_REGISTERED_SCENE_LABEL,
  ORIGINAL_SOURCE_SCENE_LABEL,
  placementResultSrc,
  placementStage,
  sourceSceneLabel,
  TITLE_SOURCE_VIDEOS,
  type CaseEvidence,
  type RecordedCase,
  type TitleMedia,
} from "@/lib/catalogue/title-media";
import { DEMO_MEDIA_KEYS, FULL_SCENE_LABEL, type DemoSnapshot } from "@/lib/demo/snapshot";

const VIDEO_DIR = join(process.cwd(), "public", "demo-videos");
const GITHUB_WARN_BYTES = 50 * 1024 * 1024;
const GITHUB_BLOCK_BYTES = 100 * 1024 * 1024;

/** The verified snapshot built by npm run demo:snapshot (git-ignored). */
const SNAPSHOT = join(process.cwd(), ".demo", "snapshot.json");
const snapshot = existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as DemoSnapshot) : null;
const noSnapshot = snapshot?.fullScene ? false : "no .demo snapshot with a full-scene video: run npm run demo:snapshot";
const hasFfprobe = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const title = (id: string) => catalogue.find((t) => t.id === id)!;

/** Mirrors the recorded case NF-DEMO-0001 so rendering tests run without a local snapshot. */
const luvCase: RecordedCase = {
  caseId: "NF-DEMO-0001",
  status: "approved",
  titleId: "luv-hypothesis",
  sceneName: "Café table conversation",
  product: "Daybreak Cold Brew",
  result: {
    label: FULL_SCENE_LABEL,
    decision: "approved-with-limitation",
    limitations: ["Fine generated cup lettering shows minor temporal instability during motion."],
    disclosure: "This is a generated preview, not production-final: the generated cup lettering is not final typography.",
  },
};
const recordedCase: CaseEvidence = { loaded: true, recordedCase: luvCase };
const allPlayable = Object.fromEntries(Object.entries(TITLE_SOURCE_VIDEOS).map(([id, file]) => [id, { ok: true as const, file, bytes: 1 }]));
const media = (over: Partial<TitleMedia> = {}): TitleMedia => ({ sourceVideos: allPlayable, cases: recordedCase, ...over });
const render = (id: string, m: TitleMedia = media()) => renderToStaticMarkup(createElement(TitleMediaPanel, { title: title(id), media: m }));

/** Claims no catalogue or case record supports for the titles without a recorded case. */
const UNSUPPORTED = /\brejected\b|five-agent|safety warning|completed (agent )?run|agents? (decided|rejected|approved)|approved with limitation|\/demo\/media\//i;

describe("title-to-video mapping", () => {
  it("maps each source file to its existing catalogue title, without adding titles", () => {
    assert.deepEqual(Object.keys(TITLE_SOURCE_VIDEOS).sort(), ["luv-hypothesis", "money-hoist", "not-suitable-for-professionals"]);
    for (const [id, file] of Object.entries(TITLE_SOURCE_VIDEOS)) {
      assert.ok(catalogue.some((t) => t.id === id), `${id} is not a catalogue title`);
      assert.equal(file, `${id}-original.mp4`);
    }
    assert.equal(catalogue.length, 10);
    assert.equal(new Set(catalogue.map((t) => t.id)).size, 10);
  });

  it("holds only the three original source clips, plus at most the hero's public V4 file", () => {
    const heroFile = HERO_PREVIEW_VIDEOS["luv-hypothesis"].split("/").pop()!;
    const files = readdirSync(VIDEO_DIR).filter((f) => !f.startsWith(".") && f !== heroFile);
    assert.deepEqual(files.sort(), Object.values(TITLE_SOURCE_VIDEOS).sort());
  });
});

describe("source video files", () => {
  for (const [id, file] of Object.entries(TITLE_SOURCE_VIDEOS)) {
    it(`${file} exists and is a complete, playable MP4 within deploy size limits`, async () => {
      const path = join(VIDEO_DIR, file);
      const check = await checkSourceVideo(path, file);
      assert.ok(check.ok, check.ok ? "" : `${id}: ${check.reason}`);
      const { size } = statSync(path);
      assert.ok(size < GITHUB_WARN_BYTES, `${file} is ${(size / 1e6).toFixed(1)} MB; GitHub warns above 50 MB`);
    });

    it(`${file} decodes as H.264 video with AAC audio`, { skip: hasFfprobe ? false : "ffprobe is not installed" }, async () => {
      const probe = await ffprobeVideo(new Uint8Array(readFileSync(join(VIDEO_DIR, file))));
      assert.equal(probe.video?.codec, "h264");
      assert.equal(probe.audio?.codec, "aac");
      assert.ok(probe.video.frameCount > 0 && probe.durationSeconds > 0);
    });
  }

  it("fits GitHub's 100 MB push limit in total", () => {
    const total = Object.values(TITLE_SOURCE_VIDEOS).reduce((sum, f) => sum + statSync(join(VIDEO_DIR, f)).size, 0);
    assert.ok(total < GITHUB_BLOCK_BYTES);
  });

  it("fails clearly for a missing, empty, non-MP4, or truncated file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nf-title-video-"));
    const good = readFileSync(join(VIDEO_DIR, TITLE_SOURCE_VIDEOS["money-hoist"]));
    const cases: [string, Uint8Array | null, RegExp][] = [
      ["missing.mp4", null, /missing/],
      ["empty.mp4", new Uint8Array(), /empty/],
      ["text.mp4", new TextEncoder().encode("this is not a video file at all"), /not an MP4/],
      ["truncated.mp4", good.subarray(0, good.length - 1000), /truncated/],
    ];
    for (const [name, bytes, reason] of cases) {
      if (bytes) writeFileSync(join(dir, name), bytes);
      const check = await checkSourceVideo(join(dir, name), name);
      assert.equal(check.ok, false, name);
      assert.match(check.ok ? "" : check.reason, reason);
    }
  });

  it("the LUV clip is byte-identical to the registered source video", { skip: noSnapshot }, () => {
    const sum = `sha256:${createHash("sha256").update(readFileSync(join(VIDEO_DIR, TITLE_SOURCE_VIDEOS["luv-hypothesis"]))).digest("hex")}`;
    assert.equal(sum, snapshot!.fullScene!.sourceVideoChecksum);
  });
});

describe("title video players", () => {
  for (const id of Object.keys(TITLE_SOURCE_VIDEOS)) {
    it(`${id}: controls, playsInline, preload=metadata, artwork poster, never autoplay`, () => {
      const html = render(id);
      assert.doesNotMatch(html, /autoplay/i);
      const videos = html.match(/<video[^>]*>/g) ?? [];
      assert.ok(videos.length >= 1);
      for (const v of videos) {
        assert.match(v, /\bcontrols=""/);
        assert.match(v, /\bplaysInline=""/i);
        assert.match(v, /preload="metadata"/);
        assert.match(v, new RegExp(`poster="${(title(id).artwork as { src: string }).src}"`));
        assert.doesNotMatch(v, /\bmuted\b|\bloop\b/);
      }
    });
  }

  it("catalogue components never autoplay", () => {
    const dir = join(process.cwd(), "components", "catalogue");
    for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /\bautoPlay\b|\bautoplay[=\s>]/, f);
  });

  it("renders a clear notice instead of a broken player when the source clip failed its check", () => {
    const html = render("money-hoist", media({ sourceVideos: { ...allPlayable, "money-hoist": { ok: false, file: "money-hoist-original.mp4", reason: "The source video file is missing." } } }));
    assert.doesNotMatch(html, /<video/);
    assert.match(html, /Original source scene unavailable\..*The source video file is missing\./);
  });
});

describe("original versus edited labels", () => {
  it("The LUV Hypothesis: original registered scene, selected, then the approved Runway result", () => {
    const html = render("luv-hypothesis");
    assert.match(html, new RegExp(`>${ORIGINAL_REGISTERED_SCENE_LABEL}<`));
    assert.match(html, /Selected for placement\..*Eligible · selected for case NF-DEMO-0001/);
    assert.match(html, new RegExp(`<h3[^>]*>${APPROVED_RESULT_HEADING}</h3>`));
    assert.match(html, /Approved with limitation/);
    assert.match(html, /cup lettering shows minor temporal instability/);
    assert.match(html, /not final typography/);
    assert.match(html, /href="\/demo"/);
    // The source clip comes first, the edited result second.
    assert.ok(html.indexOf("/demo-videos/luv-hypothesis-original.mp4") < html.indexOf(placementResultSrc));
  });

  for (const id of ["money-hoist", "not-suitable-for-professionals"]) {
    it(`${id}: an unedited source scene only, with no edited result`, () => {
      const html = render(id);
      assert.equal(sourceSceneLabel(id, recordedCase), ORIGINAL_SOURCE_SCENE_LABEL);
      assert.match(html, new RegExp(`>${ORIGINAL_SOURCE_SCENE_LABEL}<`));
      assert.doesNotMatch(html, /registered/i);
      assert.doesNotMatch(html, new RegExp(APPROVED_RESULT_HEADING));
      assert.equal((html.match(/<video/g) ?? []).length, 1);
    });
  }

  it("without case records, LUV is not claimed as registered or selected and shows no result", () => {
    const html = render("luv-hypothesis", media({ cases: { loaded: false, reason: "No demo snapshot has been prepared on this machine." } }));
    assert.match(html, new RegExp(`>${ORIGINAL_SOURCE_SCENE_LABEL}<`));
    assert.doesNotMatch(html, new RegExp(`${APPROVED_RESULT_HEADING}|${ORIGINAL_REGISTERED_SCENE_LABEL}|selected for case`));
  });

  it("an unverified Runway video shows a notice, not a player", () => {
    const html = render("luv-hypothesis", media({ cases: { loaded: true, recordedCase: { ...luvCase, result: null } } }));
    assert.doesNotMatch(html, new RegExp(placementResultSrc));
    assert.match(html, /Approved placement result unavailable\./);
  });
});

describe("Runway V4 result", () => {
  it("plays only through the checksum-verified demo media route", () => {
    assert.equal(placementResultSrc, "/demo/media/full-scene-v4");
    assert.ok((DEMO_MEDIA_KEYS as readonly string[]).includes("full-scene-v4"));
    const route = readFileSync(join(process.cwd(), "app", "demo", "media", "[key]", "route.ts"), "utf8");
    assert.match(route, /loadDemoMedia\(key\)/);
    const loader = readFileSync(join(process.cwd(), "app", "demo", "load-snapshot.ts"), "utf8");
    assert.match(loader, /createHash\("sha256"\)[\s\S]*=== media\.sha256/);
  });

  it("the real recorded case resolves to LUV with its approved-with-limitation result", { skip: noSnapshot }, async () => {
    const real = await loadTitleMedia();
    assert.ok(real.cases.loaded);
    assert.equal(real.cases.recordedCase.titleId, "luv-hypothesis");
    const result = real.cases.recordedCase.result;
    assert.equal(result?.decision, snapshot!.fullScene!.decision);
    assert.deepEqual(result?.limitations, snapshot!.fullScene!.limitations);
    assert.match(result?.disclosure ?? "", /not final typography/);
    // No storage path or provider URL reaches the page.
    assert.doesNotMatch(JSON.stringify(real), /storage:\/\/|https?:\/\/|\.demo\//);
    for (const check of Object.values(real.sourceVideos)) assert.ok(check.ok);
  });
});

describe("no unsupported pipeline claims", () => {
  it("Money Hoist shows its stored rights-in-review status and catalogue screening, not an agent rejection", () => {
    const stage = placementStage(title("money-hoist"), recordedCase);
    assert.equal(title("money-hoist").rightsStatus, "pending-review");
    assert.equal(stage.stage, "screened-out");
    assert.equal(stage.status, "Rights in review · not eligible");
    assert.match(stage.detail, /Catalogue screening prevents it from entering the placement pipeline/);
    assert.doesNotMatch(render("money-hoist"), UNSUPPORTED);
  });

  it("Not Suitable for Professionals shows its stored eligible status, with no invented caution or agent decision", () => {
    const stage = placementStage(title("not-suitable-for-professionals"), recordedCase);
    assert.equal(stage.stage, "review");
    assert.equal(stage.status, "Eligible · review ready · pipeline enabled");
    assert.match(stage.detail, /No caution is recorded.*No placement case or agent decision is recorded/);
    assert.doesNotMatch(render("not-suitable-for-professionals"), UNSUPPORTED);
  });

  it("every comparison stage derives from catalogue and case records: only the recorded case's title is selected", () => {
    const stages = catalogue.map((t) => [t.id, placementStage(t, recordedCase).stage] as const);
    assert.deepEqual(stages.filter(([, s]) => s === "selected").map(([id]) => id), ["luv-hypothesis"]);
    for (const [id, s] of stages) assert.equal(s === "screened-out", !getEligibility(title(id)).eligible, id);
    assert.ok(!catalogue.some((t) => placementStage(t, { loaded: false, reason: "" }).stage === "selected"));
  });
});
