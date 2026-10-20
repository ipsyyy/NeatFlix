import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HERO_PREVIEW_VIDEOS,
  HOVER_DELAY_MS,
  heroPreviewReducer,
  initialHeroPreview,
  type HeroPreviewEvent,
  type HeroPreviewState,
} from "@/lib/catalogue/hero-preview";
import type { DemoSnapshot } from "@/lib/demo/snapshot";

const run = (...events: HeroPreviewEvent[]): HeroPreviewState => events.reduce(heroPreviewReducer, initialHeroPreview);
const desktopEnter: HeroPreviewEvent = { type: "pointer-enter", hoverCapable: true, reducedMotion: false };
const idle = (s: HeroPreviewState) => s.status === "idle" && s.source === null && !s.visible;

describe("hero preview behaviour", () => {
  it("does not play on page load", () => {
    assert.ok(idle(initialHeroPreview));
    assert.equal(initialHeroPreview.muted, true);
  });

  it("plays only after the hover delay, muted", () => {
    assert.equal(HOVER_DELAY_MS, 400);
    const waiting = run(desktopEnter);
    assert.equal(waiting.status, "waiting");
    const playing = heroPreviewReducer(waiting, { type: "hover-elapsed" });
    assert.deepEqual([playing.status, playing.source, playing.muted, playing.visible], ["playing", "hover", true, false]);
    // Fades in only once the video has frames.
    assert.equal(heroPreviewReducer(playing, { type: "frames-ready" }).visible, true);
  });

  it("does not restart while the pointer stays inside", () => {
    const playing = run(desktopEnter, { type: "hover-elapsed" }, { type: "frames-ready" });
    assert.equal(heroPreviewReducer(playing, desktopEnter), playing);
    assert.equal(heroPreviewReducer(playing, { type: "hover-elapsed" }), playing);
    // Once it ends it stays on the poster until the pointer leaves and returns.
    assert.ok(idle(heroPreviewReducer(playing, { type: "ended" })));
  });

  it("stops and resets when the pointer leaves, including before the delay", () => {
    assert.ok(idle(run(desktopEnter, { type: "hover-elapsed" }, { type: "frames-ready" }, { type: "pointer-leave" })));
    assert.ok(idle(run(desktopEnter, { type: "pointer-leave" }, { type: "hover-elapsed" })));
  });

  it("starts and stops from the Preview control (Enter and Space click the native button)", () => {
    const started = run({ type: "toggle" });
    assert.deepEqual([started.status, started.source, started.muted], ["playing", "explicit", true]);
    // An explicit preview survives the pointer leaving the media area.
    assert.equal(heroPreviewReducer(started, { type: "pointer-leave" }), started);
    assert.ok(idle(heroPreviewReducer(started, { type: "toggle" })));
  });

  it("Escape and a press outside the hero stop the preview", () => {
    const playing = run({ type: "toggle" }, { type: "frames-ready" });
    assert.ok(idle(heroPreviewReducer(playing, { type: "escape" })));
    assert.ok(idle(heroPreviewReducer(playing, { type: "pointer-outside" })));
    assert.equal(heroPreviewReducer(initialHeroPreview, { type: "escape" }), initialHeroPreview);
  });

  it("reduced motion: hover never plays, the explicit control still does", () => {
    assert.ok(idle(run({ type: "pointer-enter", hoverCapable: true, reducedMotion: true }, { type: "hover-elapsed" })));
    assert.equal(run({ type: "toggle" }).status, "playing");
  });

  it("touch devices: no hover logic, explicit playback only", () => {
    assert.ok(idle(run({ type: "pointer-enter", hoverCapable: false, reducedMotion: false }, { type: "hover-elapsed" })));
    assert.equal(run({ type: "toggle" }).source, "explicit");
  });

  it("mute is offered only once frames play, and every new preview starts muted again", () => {
    assert.equal(run({ type: "toggle" }, { type: "toggle-mute" }).muted, true);
    const unmuted = run({ type: "toggle" }, { type: "frames-ready" }, { type: "toggle-mute" });
    assert.equal(unmuted.muted, false);
    const restarted = [{ type: "toggle" }, { type: "toggle" }] as HeroPreviewEvent[];
    assert.equal(restarted.reduce(heroPreviewReducer, unmuted).muted, true);
  });

  it("a missing or failed video keeps the poster and offers no preview", () => {
    const failed = run({ type: "toggle" }, { type: "error" });
    assert.ok(idle(failed));
    assert.equal(failed.failed, true);
    assert.equal(heroPreviewReducer(failed, { type: "toggle" }), failed);
    assert.equal(heroPreviewReducer(failed, desktopEnter), failed);
  });
});

describe("hero preview source", () => {
  const src = HERO_PREVIEW_VIDEOS["luv-hypothesis"];

  it("is the deployable public V4 file, never the private snapshot or its route", () => {
    assert.equal(src, "/demo-videos/luv-hypothesis-daybreak-v4.mp4");
    assert.doesNotMatch(src, /\.demo|\/demo\/media\/|storage:\/\/|^https?:/);
  });

  const file = join(process.cwd(), "public", src);
  const snapshotFile = join(process.cwd(), ".demo", "snapshot.json");
  const skip = !existsSync(file) ? "public V4 file not present: the hero shows its poster fallback" : !existsSync(snapshotFile) ? "no .demo snapshot to compare against" : false;
  it("when present, is byte-identical to the registered, human-reviewed V4 video", { skip }, () => {
    const registered = (JSON.parse(readFileSync(snapshotFile, "utf8")) as DemoSnapshot).fullScene?.checksum;
    assert.equal(`sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`, registered);
  });
});
