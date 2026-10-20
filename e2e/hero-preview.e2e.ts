import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright-core";
import { HERO_PREVIEW_VIDEOS } from "@/lib/catalogue/hero-preview";

/**
 * Browser tests of the homepage hero preview and the catalogue below it,
 * against the production build (`npm run build` first), in the system Chrome.
 * The preview URL is served by request interception: a playable stand-in clip
 * (the LUV source clip), or a 404 for the fallback, so no media is copied.
 */

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(process.cwd());
const HAS_SNAPSHOT = existsSync(join(ROOT, ".demo", "snapshot.json"));
const PREVIEW_URL = HERO_PREVIEW_VIDEOS["luv-hypothesis"];
const STAND_IN = readFileSync(join(ROOT, "public", "demo-videos", "luv-hypothesis-original.mp4"));
const port = 3218;
const base = `http://127.0.0.1:${port}`;

const VIDEO = '[data-testid="hero-preview-video"]';
const TOGGLE = '[data-testid="hero-preview-toggle"]';

async function startServer(): Promise<ChildProcess> {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "Run npm run build before the browser tests.");
  const proc = spawn(join(ROOT, "node_modules", ".bin", "next"), ["start", "--port", String(port)], { cwd: ROOT, env: { ...process.env, NATIVEFRAME_DEMO_DIR: join(ROOT, ".demo") }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/`)).ok) return proc;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("The production server did not start.");
}

type VideoState = { state: string; paused: boolean; time: number; muted: boolean; controls: boolean; autoplay: boolean; preload: string; opacity: string };
const videoState = (page: Page) =>
  page.$eval(VIDEO, (v: HTMLVideoElement): VideoState => ({
    state: v.dataset.state ?? "",
    paused: v.paused,
    time: v.currentTime,
    muted: v.muted,
    controls: v.controls,
    autoplay: v.autoplay,
    preload: v.preload,
    opacity: getComputedStyle(v).opacity,
  }));
const waitFor = (page: Page, state: "playing" | "poster") => page.waitForSelector(`${VIDEO}[data-state="${state}"]`, { timeout: 8000 });

describe("homepage hero preview and catalogue", () => {
  let server: ChildProcess;
  let browser: Browser;
  before(async () => {
    server = await startServer();
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  });
  after(async () => {
    await browser?.close();
    server?.kill();
  });

  async function open(options: BrowserContextOptions = {}, video: "stand-in" | "missing" = "stand-in"): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    await context.route(`**${PREVIEW_URL}`, (route) =>
      video === "missing" ? route.fulfill({ status: 404, body: "Not found" }) : route.fulfill({ status: 200, contentType: "video/mp4", body: STAND_IN }),
    );
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    return page;
  }

  /** A point on the hero media banner, clear of the text column, and one in the hero below it. */
  async function points(page: Page) {
    const box = (await page.locator('[data-testid="hero-media"]').boundingBox())!;
    return { inside: { x: box.x + box.width * 0.8, y: box.y + box.height * 0.35 }, below: { x: box.x + box.width * 0.8, y: box.y + box.height + 120 } };
  }

  const posterLoaded = (page: Page) => page.$eval("#featured img", (img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

  it("does not autoplay on page load: poster shown, video transparent, paused, metadata only", async () => {
    const page = await open();
    await page.waitForTimeout(1200);
    const v = await videoState(page);
    assert.deepEqual([v.state, v.paused, v.time, v.opacity, v.autoplay, v.controls, v.preload], ["poster", true, 0, "0", false, false, "metadata"]);
    assert.ok(await posterLoaded(page));
    await page.context().close();
  });

  it("plays muted in the hero frame only after the pointer rests ~400 ms, and does not restart while inside", async () => {
    const page = await open();
    const { inside } = await points(page);
    await page.mouse.move(inside.x, inside.y);
    await page.waitForTimeout(200);
    assert.equal((await videoState(page)).paused, true, "must not start before the delay");
    await waitFor(page, "playing");
    // Fades in from the poster rather than cutting.
    assert.deepEqual(await page.$eval(VIDEO, (el) => [getComputedStyle(el).transitionProperty, getComputedStyle(el).transitionDuration]), ["opacity", "0.5s"]);
    await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)!).opacity === "1", VIDEO);
    const v = await videoState(page);
    assert.deepEqual([v.paused, v.muted, v.controls], [false, true, false]);
    assert.equal(await page.$eval(VIDEO, (el) => getComputedStyle(el).objectFit), "cover");
    assert.equal(await page.locator("dialog[open]").count(), 0, "plays in place, never in a modal");
    await page.mouse.move(inside.x - 40, inside.y + 20);
    await page.waitForTimeout(700);
    const later = await videoState(page);
    assert.ok(later.time > v.time && !later.paused, "kept playing rather than restarting");
    await page.context().close();
  });

  it("pauses, resets to the start, and fades back to the poster when the pointer leaves", async () => {
    const page = await open();
    const { inside, below } = await points(page);
    await page.mouse.move(inside.x, inside.y);
    await waitFor(page, "playing");
    await page.waitForTimeout(600);
    await page.mouse.move(below.x, below.y);
    await waitFor(page, "poster");
    const v = await videoState(page);
    assert.deepEqual([v.paused, v.time], [true, 0]);
    await page.context().close();
  });

  it("keyboard: Enter starts, Space stops, mute appears after playback, focus stays put", async () => {
    const page = await open();
    await page.focus(TOGGLE);
    await page.keyboard.press("Enter");
    await waitFor(page, "playing");
    assert.equal((await videoState(page)).muted, true);
    assert.equal(await page.locator(TOGGLE).innerText(), "Stop preview");
    assert.equal(await page.locator('[data-testid="hero-preview-mute"]').getAttribute("aria-label"), "Unmute preview");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "hero-preview-toggle");
    await page.keyboard.press("Space");
    await waitFor(page, "poster");
    assert.equal(await page.locator('[data-testid="hero-preview-mute"]').count(), 0);
    // Tab moves on normally: focus is not trapped.
    await page.keyboard.press("Tab");
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "hero-preview-toggle");
    await page.context().close();
  });

  it("Escape stops the preview and resets it", async () => {
    const page = await open();
    await page.focus(TOGGLE);
    await page.keyboard.press("Enter");
    await waitFor(page, "playing");
    await page.locator('[data-testid="hero-preview-mute"]').click();
    assert.equal((await videoState(page)).muted, false, "unmuted only by the user");
    await page.keyboard.press("Escape");
    await waitFor(page, "poster");
    const v = await videoState(page);
    assert.deepEqual([v.paused, v.time, v.muted], [true, 0, true]);
    await page.context().close();
  });

  it("reduced motion: hovering never plays; the explicit Preview button does", async () => {
    const page = await open({ reducedMotion: "reduce" });
    const { inside } = await points(page);
    await page.mouse.move(inside.x, inside.y);
    await page.waitForTimeout(1500);
    assert.equal((await videoState(page)).paused, true);
    await page.click(TOGGLE);
    await waitFor(page, "playing");
    await page.context().close();
  });

  it("mobile: no hover playback, tap Preview to play muted, tap outside to restore the poster", async () => {
    const page = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const { inside } = await points(page);
    await page.touchscreen.tap(inside.x, Math.min(inside.y, 200));
    await page.waitForTimeout(1200);
    assert.equal((await videoState(page)).paused, true, "a touch never triggers hover playback");
    await page.locator(TOGGLE).tap();
    await waitFor(page, "playing");
    assert.equal((await videoState(page)).muted, true);
    await page.locator("#eligibility-heading").tap();
    await waitFor(page, "poster");
    await page.context().close();
  });

  it("falls back to the poster when the preview video is missing", async () => {
    const page = await open({}, "missing");
    await page.waitForSelector('[data-testid="hero-preview-unavailable"]');
    assert.equal(await page.locator(VIDEO).count(), 0);
    assert.ok(await posterLoaded(page));
    const { inside } = await points(page);
    await page.mouse.move(inside.x, inside.y);
    await page.waitForTimeout(800);
    assert.equal(await page.locator("#featured video").count(), 0);
    await page.context().close();
  });

  it("catalogue: static thumbnails, nothing plays on scroll, hero not sticky, LUV card opens both players", async () => {
    const page = await open();
    assert.doesNotMatch(await page.$eval("#featured", (el) => getComputedStyle(el).position), /sticky|fixed/);
    await page.locator("#titles").scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(800);
    assert.ok(((await page.locator("#featured").boundingBox())!.y) < -200, "the hero scrolls away");
    assert.equal(await page.locator("#titles video").count(), 0);
    const cards = page.locator("#titles article");
    assert.equal(await cards.count(), 10);
    for (let i = 0; i < 10; i++) assert.equal(await cards.nth(i).locator(".tile-frame img").count(), 1);
    assert.ok(await page.$$eval("video", (vs) => vs.every((v) => (v as HTMLVideoElement).paused)));

    const luv = cards.filter({ hasText: "The LUV Hypothesis" });
    assert.equal(await luv.locator('[data-testid="play-indicator"]').count(), 1);
    await luv.locator("h3 button").click();
    const dialog = page.locator("dialog[open]");
    await dialog.locator("video").first().waitFor();
    const srcs = await dialog.locator("video").evaluateAll((vs) => vs.map((v) => v.getAttribute("src")));
    assert.equal(srcs[0], "/demo-videos/luv-hypothesis-original.mp4");
    if (HAS_SNAPSHOT) {
      assert.equal(srcs[1], "/demo/media/full-scene-v4", "the title record keeps the verified registered V4 route");
      assert.match(await dialog.innerText(), /Runway Aleph full-scene preview — human reviewed[\s\S]*Approved with limitation[\s\S]*not final typography/);
    }
    await page.context().close();
  });
});
