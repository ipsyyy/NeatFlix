import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Browser tests of the campaign → placement preview journey against the
 * production build (`npm run build` first), in the system Chrome: the
 * recorded replay, the approved V4 video, the missing-video fallback, and
 * that the page sends no write request and contacts no host but localhost.
 */

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(process.cwd());
const port = 3219;
const base = `http://127.0.0.1:${port}`;
const CAMPAIGN = "/titles/luv-hypothesis/scenes/luv-scene-1/campaign";
const PREVIEW = "/titles/luv-hypothesis/scenes/luv-scene-1/preview";
const VIDEO_SRC = "/demo-videos/luv-hypothesis-daybreak-v4.mp4";

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

describe("campaign → placement preview", () => {
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

  async function newPage(missingVideo = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (missingVideo) await context.route(`**${VIDEO_SRC}`, (r) => r.fulfill({ status: 404, body: "Not found" }));
    const page = await context.newPage();
    const requests: { method: string; host: string; path: string }[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      requests.push({ method: r.method(), host: u.host, path: u.pathname });
    });
    return { page, requests };
  }

  const stepStates = (page: Page) => page.$$eval('[data-testid="replay-steps"] li', (lis) => lis.map((li) => li.getAttribute("data-state")));

  it("clicking the enabled campaign button replays the recorded pipeline and reaches the approved video", async () => {
    const { page, requests } = await newPage();
    await page.goto(`${base}${CAMPAIGN}`, { waitUntil: "networkidle" });
    const button = page.getByRole("link", { name: "Continue to placement preview" });
    assert.equal(await button.getAttribute("href"), PREVIEW);
    assert.match(await page.locator("#placement-preview-note").innerText(), /Replay the recorded placement pipeline and inspect its approved output\./);

    const clickedAt = Date.now();
    await button.click();
    await page.waitForURL(`**${PREVIEW}`);
    assert.equal(await page.getByTestId("replay-disclosure").innerText(), "Recorded pipeline replay — no provider is called during this demo.");

    // Progressive: early on, at least one stage is still pending and the video is hidden.
    await page.waitForTimeout(1500);
    assert.ok((await stepStates(page)).some((s) => s !== "complete"));
    assert.equal(await page.getByTestId("approved-preview").count(), 0);
    const running = page.locator('[data-testid="replay-steps"] li[data-state="running"]');
    assert.equal(await running.count(), 1);
    assert.match(await running.innerText(), /In progress/, "the running stage states its status in text");

    await page.getByTestId("approved-video").waitFor({ timeout: 9000 });
    const elapsed = Date.now() - clickedAt;
    assert.ok(elapsed >= 4000 && elapsed <= 8000, `replay took ${elapsed} ms`);
    assert.deepEqual(await stepStates(page), ["complete", "complete", "complete", "complete", "complete"]);
    const steps = await page.locator('[data-testid="replay-steps"] li').allInnerTexts();
    for (const [i, agent] of ["Content Curator", "Scene Scout", "Campaign Matcher", "Placement Director", "Release Governor"].entries()) assert.match(steps[i], new RegExp(agent));

    const preview = page.getByTestId("approved-preview");
    assert.match(await preview.innerText(), /Approved placement preview\s+Generated earlier with Runway Aleph and approved with limitation\.[\s\S]*Fine generated cup lettering shows minor temporal instability during motion\./);
    const video = page.getByTestId("approved-video");
    assert.equal(await video.getAttribute("src"), VIDEO_SRC);
    await page.waitForFunction(() => (document.querySelector('[data-testid="approved-video"]') as HTMLVideoElement).readyState >= 1);
    assert.equal(await video.evaluate((v: HTMLVideoElement) => [v.paused, Math.round(v.duration)].join()), "true,20", "the 20 s video waits for the viewer");

    await page.getByRole("button", { name: "Play approved video" }).click();
    await page.waitForFunction(() => !(document.querySelector('[data-testid="approved-video"]') as HTMLVideoElement).paused);
    assert.equal(await page.getByRole("link", { name: "View approval evidence" }).getAttribute("href"), "/demo#step-human");
    assert.equal(await page.getByRole("link", { name: "View full case" }).getAttribute("href"), "/demo");

    await page.getByRole("button", { name: "Replay pipeline" }).click();
    assert.equal(await page.getByTestId("approved-preview").count(), 0);
    await page.getByTestId("approved-video").waitFor({ timeout: 9000 });

    // Read-only: nothing but GETs, to this server only, and no API route.
    assert.deepEqual([...new Set(requests.map((r) => r.host))], [`127.0.0.1:${port}`]);
    assert.deepEqual(requests.filter((r) => !["GET", "HEAD"].includes(r.method)), []);
    assert.deepEqual(requests.filter((r) => /\/api\/|runway|masky|gemini|supabase/i.test(r.path)), []);
    await page.context().close();
  });

  it("the approval-evidence link lands on the demo's human approval step", async () => {
    const { page } = await newPage();
    await page.goto(`${base}/demo#step-human`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#step-human").count(), 1);
    await page.context().close();
  });

  it("shows a clear unavailable message instead of a broken player when the MP4 is missing", async () => {
    const { page } = await newPage(true);
    await page.goto(`${base}${PREVIEW}`, { waitUntil: "networkidle" });
    await page.getByText("Approved placement preview unavailable.").waitFor({ timeout: 9000 });
    assert.equal(await page.getByTestId("approved-video").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Play approved video" }).isDisabled(), true);
    assert.equal(await page.getByRole("link", { name: "View full case" }).count(), 1);
    await page.context().close();
  });
});
