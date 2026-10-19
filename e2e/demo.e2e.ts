import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Browser tests of the end-to-end demo against the production build
 * (`npm run build` first): the full click-through on the verified local
 * snapshot, and graceful placeholders when no snapshot exists. Uses the
 * system Chrome; only localhost is contacted.
 */

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(process.cwd());
const HAS_SNAPSHOT = existsSync(join(ROOT, ".demo", "snapshot.json"));

async function startServer(port: number, demoDir: string): Promise<ChildProcess> {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "Run npm run build before the browser tests.");
  const proc = spawn(join(ROOT, "node_modules", ".bin", "next"), ["start", "--port", String(port)], { cwd: ROOT, env: { ...process.env, NATIVEFRAME_DEMO_DIR: demoDir }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return proc;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("The production server did not start.");
}

async function openDemo(browser: Browser, base: string): Promise<{ page: Page; hosts: Set<string> }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const hosts = new Set<string>();
  page.on("request", (r) => hosts.add(new URL(r.url()).host));
  await page.goto(`${base}/demo`, { waitUntil: "networkidle" });
  return { page, hosts };
}

describe("end-to-end demo (verified snapshot)", { skip: HAS_SNAPSHOT ? false : "no .demo snapshot: run npm run demo:snapshot" }, () => {
  const port = 3217;
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess;
  let browser: Browser;
  before(async () => {
    server = await startServer(port, join(ROOT, ".demo"));
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  });
  after(async () => {
    await browser?.close();
    server?.kill();
  });

  it("tells the whole story in order, with every step present and correct", async () => {
    const { page } = await openDemo(browser, base);
    const steps = await page.locator('nav[aria-label="Demo steps"] a').allInnerTexts();
    assert.deepEqual(steps, ["1. Case", "2. Agents", "3. Plan & scene", "4. Approved visuals", "5. Reactor", "6. Governor checks", "7. Human approval", "8. Masky", "9. LangSmith", "10. Reliability & security", "11. Business value"]);
    assert.equal(await page.getByTestId("case-id").innerText(), "NF-DEMO-0001");
    assert.equal(await page.getByTestId("case-status").innerText(), "approved");
    assert.equal(await page.getByTestId("agents").locator("h3").count(), 5);
    assert.match(await page.getByTestId("visual-disclosure").innerText(), /registered LUV source frame[\s\S]*FFmpeg fallback/);
    for (const [v, decision] of [["1", "rejected"], ["2", "rejected"], ["3", "approved"]]) {
      assert.match(await page.getByTestId(`revision-v${v}`).innerText(), new RegExp(`v${v}: human ${decision}`));
    }
    assert.match(await page.getByTestId("reactor-note").innerText(), /intended motion provider[\s\S]*secondary integration evidence/);
    assert.equal(await page.getByTestId("governor-decision").innerText(), "approve-for-human-review");
    assert.equal(await page.locator('ul[aria-label="Governor checks"] > li').count(), 6);
    assert.equal(await page.locator('ul[aria-label="Helpful, honest, harmless"] > li').count(), 3);
    assert.equal(await page.getByTestId("approval-reasons").locator("li").count(), 6);
    assert.equal(await page.getByTestId("approval-case-status").innerText(), "approved");
    assert.equal(await page.getByTestId("masky-identities").locator("h3").count(), 5);
    assert.match(await page.getByTestId("masky-live-identity").innerText(), /VDzafw3fD73I9SNZC6SY/);
    assert.equal(await page.getByText("Local fallback: caption, no voice").count(), 4);
    assert.equal(await page.getByTestId("langsmith-runs").innerText(), "17");
    assert.equal(await page.getByTestId("langsmith-feedback").innerText(), "12");
    assert.match(await page.getByTestId("langsmith-scores").innerText(), /prompt_label_currency\s+0/);
    const reliability = await page.locator('ul[aria-label="Reliability and security checks"]').innerText();
    assert.ok((reliability.match(/· live/g) ?? []).length >= 6, "the live checks are shown");
    assert.ok(!/· live\s+Fail/.test(reliability), "no live check fails");
    assert.equal(await page.getByTestId("business-value").locator("li").count(), 4);
    await page.close();
  });

  it("loads every verified image, the preview video, and the Masky audio", async () => {
    const { page } = await openDemo(browser, base);
    for (const key of ["source-frame", "edited-still-v1", "edited-still-v2", "edited-still-v3", "iris-portrait"]) {
      const img = page.getByTestId(`media-${key}`);
      await img.scrollIntoViewIfNeeded();
      await page.waitForFunction((k) => {
        const el = document.querySelector(`[data-testid="media-${k}"]`) as HTMLImageElement | null;
        return Boolean(el && el.complete && el.naturalWidth > 0);
      }, key);
    }
    const duration = await page.getByTestId("media-preview-v3").evaluate(
      (v: HTMLVideoElement) => new Promise<number>((ok) => (v.readyState >= 1 ? ok(v.duration) : v.addEventListener("loadedmetadata", () => ok(v.duration), { once: true }))),
    );
    assert.ok(Math.abs(duration - 3.5) < 0.05, `preview duration ${duration}`);
    const audio = await page.request.get(`${base}/demo/media/iris-audio`);
    assert.deepEqual([audio.status(), audio.headers()["content-type"]], [200, "audio/mpeg"]);
    await page.close();
  });

  it("clicks through every step with the navigation and the Next buttons", async () => {
    const { page } = await openDemo(browser, base);
    const ids = ["step-case", "step-workforce", "step-plan", "step-visuals", "step-reactor", "step-governor", "step-human", "step-masky", "step-langsmith", "step-reliability", "step-value"];
    for (const id of ids) {
      await page.locator(`nav[aria-label="Demo steps"] a[href="#${id}"]`).click();
      await page.waitForFunction((x) => location.hash === `#${x}`, id);
      assert.ok(await page.locator(`#${id}`).isVisible(), id);
    }
    await page.locator('nav[aria-label="Demo steps"] a[href="#step-case"]').click();
    for (let i = 1; i < ids.length; i++) {
      await page.locator(`#${ids[i - 1]} a[href="#${ids[i]}"]`).click();
      await page.waitForFunction((x) => location.hash === `#${x}`, ids[i]);
    }
    assert.equal(await page.locator("#step-value a").count(), 0, "the last step has no Next button");
    await page.close();
  });

  it("exposes no private path, credential, or external request, and serves only verified media", async () => {
    const { page, hosts } = await openDemo(browser, base);
    const html = await page.content();
    assert.ok(!/storage:\/\/|sb_secret_|lsv2_|mky_|sk-ant-|token=|supabase\.co|nf-media\//.test(html), "no private path or credential in the page");
    assert.deepEqual([...hosts].filter((h) => h !== `127.0.0.1:${port}`), [], "the browser only contacts the local server");
    for (const bad of ["unknown", "..%2Fsnapshot.json", "snapshot.json", "preview-v3.mp4"]) assert.equal((await page.request.get(`${base}/demo/media/${bad}`)).status(), 404, bad);
    const video = await page.request.get(`${base}/demo/media/preview-v3`);
    assert.deepEqual([video.status(), video.headers()["content-type"], video.headers()["cache-control"], video.headers()["x-content-type-options"]], [200, "video/mp4", "no-store", "nosniff"]);
    await page.close();
  });
});

describe("end-to-end demo without a snapshot (graceful placeholders)", () => {
  const port = 3218;
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess;
  let browser: Browser;
  const empty = mkdtempSync(join(tmpdir(), "nf-demo-empty-"));
  before(async () => {
    server = await startServer(port, empty);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  });
  after(async () => {
    await browser?.close();
    server?.kill();
    rmSync(empty, { recursive: true, force: true });
  });

  it("shows the step navigation and a clear placeholder, and serves no media", async () => {
    const { page } = await openDemo(browser, base);
    assert.equal(await page.locator('nav[aria-label="Demo steps"] a').count(), 11);
    assert.match(await page.getByLabel("Demo snapshot unavailable").innerText(), /not available[\s\S]*npm run demo/);
    assert.equal(await page.getByTestId("demo-story").count(), 0);
    assert.equal((await page.request.get(`${base}/demo/media/preview-v3`)).status(), 404);
    await page.close();
  });
});
