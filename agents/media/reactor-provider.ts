import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./edited-still";
import { ProviderError } from "./gemini-provider";
import { ProviderRunError, REACTOR_GENERATOR, type MotionPreviewProvider, type MotionPreviewResult, type ProviderCostRate, type ProviderRunRecord } from "./motion-preview";
import { PREVIEW_MAX_BYTES } from "./mp4-validate";
import { ORBIS_MODEL } from "./reactor-session";

/**
 * Server-only Reactor provider for one Visko Orbis Stable motion preview.
 *
 * The documented @reactor-team/js-sdk is a browser binding (WebRTC through
 * RTCPeerConnection), so the session runs in a local headless Chrome page that
 * this process controls over the DevTools protocol. REACTOR_API_KEY stays in
 * this process: it is exchanged once (POST /tokens, docs.reactor.inc
 * /authentication) for a session-scoped JWT that can create at most one session
 * of this one model, for a capped duration. Only that JWT enters the page. The
 * page is served from 127.0.0.1 and the browser profile is a fresh temporary
 * directory that is always deleted. Never import from app/, components/, or lib/.
 */

export const REACTOR_API_KEY_ENV = "REACTOR_API_KEY";
export const REACTOR_SDK = "@reactor-team/js-sdk@3.1.0";
export const REACTOR_TOKENS_URL = "https://api.reactor.inc/tokens";
export const REACTOR_PRICING_URL = "https://api.reactor.inc/pricing";
export const PRICING_MODEL_NAME = "visko-orbis-stable";
/** A session may not outlive this, enforced by Reactor through the token. */
export const MAX_SESSION_SECONDS = 180;
const TOKEN_LIFETIME_SECONDS = 900;
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const API_KEY_FORMAT = /^rk_[A-Za-z0-9_-]{8,}$/;
const JWT_FORMAT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The exact token request: scoped to one model, one session, a capped duration. */
export function tokenRequestBody() {
  return {
    expires_after: TOKEN_LIFETIME_SECONDS,
    authorization_details: [
      {
        type: "session",
        resources: { models: { match: [ORBIS_MODEL] } },
        constraints: { max_sessions: 1, max_session_duration_seconds: MAX_SESSION_SECONDS },
      },
    ],
  };
}

/** Exchanges the API key for a session-scoped JWT. One request, no retry; errors never carry the key or token. */
export async function mintSessionToken(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ jwt: string; expiresAt: number }> {
  if (!API_KEY_FORMAT.test(apiKey)) throw new ProviderError(`${REACTOR_API_KEY_ENV} is not a Reactor API key (rk_...).`);
  let res: Response;
  try {
    res = await fetchImpl(REACTOR_TOKENS_URL, {
      method: "POST",
      headers: { "Reactor-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(tokenRequestBody()),
    });
  } catch {
    throw new ProviderError("The Reactor token request could not be sent.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ProviderError(`The Reactor token request failed with HTTP ${res.status}.`);
  }
  const body = (await res.json().catch(() => null)) as { jwt?: unknown; expires_at?: unknown } | null;
  if (!body || typeof body.jwt !== "string" || !JWT_FORMAT.test(body.jwt) || typeof body.expires_at !== "number") throw new ProviderError("The Reactor token response is malformed.");
  return { jwt: body.jwt, expiresAt: body.expires_at };
}

/** The documented public per-second rate for Visko Orbis Stable, or null when none is published. */
export async function fetchOrbisRate(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<ProviderCostRate | null> {
  const res = await fetchImpl(REACTOR_PRICING_URL).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { models?: unknown } | null;
  const models = Array.isArray(body?.models) ? (body.models as Record<string, unknown>[]) : [];
  const entry = models.find((m) => m?.name === PRICING_MODEL_NAME);
  const rate = entry && typeof entry.rate === "object" && entry.rate !== null ? (entry.rate as Record<string, unknown>).amount_per_sec_usd : undefined;
  const value = typeof rate === "string" && /^\d+(\.\d+)?$/.test(rate) ? Number(rate) : NaN;
  return Number.isFinite(value) ? { usdPerSecond: value, source: `${REACTOR_PRICING_URL} models[${PRICING_MODEL_NAME}].rate.amount_per_sec_usd = "${rate}"`, retrievedAt: now().toISOString() } : null;
}

/** Bundles the page entry and the SDK's WebAssembly binding for the local page. */
export async function buildPageBundle(): Promise<{ js: Uint8Array; wasm: Uint8Array; sha256: string }> {
  const { build } = await import("esbuild");
  const here = dirname(fileURLToPath(import.meta.url));
  const out = await build({
    entryPoints: [join(here, "reactor-page-entry.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    write: false,
    minify: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  if (out.outputFiles.length !== 1) throw new ProviderError("The page bundle did not build to one file.");
  const js = out.outputFiles[0].contents;
  const sdkDir = dirname(createRequire(import.meta.url).resolve("@reactor-team/js-sdk"));
  const wasm = new Uint8Array(await readFile(join(sdkDir, "wasm", "reactor_wasm_bg.wasm")));
  return { js, wasm, sha256: sha256Hex(Buffer.concat([js, wasm])) };
}

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>NativeFrame Orbis session</title><script type="module" src="/page.js"></script>`;

/** Serves exactly three fixed files on 127.0.0.1. */
async function servePage(bundle: { js: Uint8Array; wasm: Uint8Array }): Promise<{ origin: string; close: () => Promise<void> }> {
  const files: Record<string, [string, Uint8Array | string]> = {
    "/": ["text/html; charset=utf-8", PAGE_HTML],
    "/page.js": ["text/javascript; charset=utf-8", bundle.js],
    "/reactor_wasm_bg.wasm": ["application/wasm", bundle.wasm],
  };
  const server: Server = createServer((req, res) => {
    const file = req.method === "GET" ? files[(req.url ?? "").split("?")[0]] : undefined;
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file[0], "Cache-Control": "no-store" }).end(file[1]);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new ProviderError("The local page server did not start.");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** A minimal DevTools protocol client for one page target. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  readonly events: { method: string; params: Record<string, unknown> }[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
      if (msg.method === "Network.requestWillBeSent" && this.events.length < 1000) this.events.push({ method: msg.method, params: msg.params ?? {} });
      const waiter = msg.id ? this.pending.get(msg.id) : undefined;
      if (!waiter) return;
      this.pending.delete(msg.id!);
      if (msg.error) waiter.reject(new ProviderError(`DevTools error: ${String(msg.error.message).slice(0, 120)}`));
      else waiter.resolve(msg.result ?? {});
    };
    ws.onclose = () => {
      for (const w of this.pending.values()) w.reject(new ProviderError("The browser connection closed."));
      this.pending.clear();
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new ProviderError("Could not connect to the browser."));
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}

/** Launches a fresh headless Chrome with a temporary profile; resolves its DevTools port. */
async function launchChrome(chromePath: string): Promise<{ port: number; proc: ChildProcess; close: () => Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), "nf-orbis-chrome-"));
  const proc = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const close = async () => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  for (let i = 0; i < 100; i++) {
    const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    const port = Number(text.split("\n")[0]);
    if (Number.isInteger(port) && port > 0) return { port, proc, close };
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await close();
  throw new ProviderError("Headless Chrome did not start.");
}

type SessionPage = { cdp: Cdp; origin: string; close: () => Promise<void> };

/** Serves the bundle on 127.0.0.1, opens it in a fresh headless Chrome, and waits for the session entry. */
async function openSessionPage(chromePath: string, bundle: { js: Uint8Array; wasm: Uint8Array }): Promise<SessionPage> {
  const server = await servePage(bundle);
  let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let cdp: Cdp | null = null;
  const close = async () => {
    cdp?.close();
    await chrome?.close();
    await server.close();
  };
  try {
    chrome = await launchChrome(chromePath);
    const target = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl?: string };
    if (!target.webSocketDebuggerUrl?.startsWith("ws://127.0.0.1:")) throw new ProviderError("The browser page could not be opened.");
    cdp = await Cdp.open(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.navigate", { url: `${server.origin}/` });
    for (let i = 0; ; i++) {
      const ready = await cdp.send("Runtime.evaluate", { expression: "typeof globalThis.__nfRunOrbis === 'function'", returnByValue: true });
      if ((ready.result as { value?: unknown })?.value === true) break;
      if (i > 100) throw new ProviderError("The session page did not load.");
      await new Promise((r) => setTimeout(r, 100));
    }
    return { cdp, origin: server.origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Local-only runtime check for the preflight: the bundled SDK page loads in a
 * fresh headless Chrome that has WebRTC. Makes no Reactor request, and reports
 * every request the page made so the caller can prove that.
 */
export async function probePageRuntime(chromePath = DEFAULT_CHROME): Promise<{ bundleSha256: string; webrtc: boolean; wasm: boolean; userAgent: string; requests: string[]; externalRequests: string[] }> {
  const bundle = await buildPageBundle();
  const page = await openSessionPage(chromePath, bundle);
  try {
    // The SDK loads its binding only inside connect(); compile the served binding here instead (local only).
    const expression = `(async () => JSON.stringify({
      webrtc: typeof RTCPeerConnection === "function",
      wasm: (await WebAssembly.compile(await (await fetch("/reactor_wasm_bg.wasm")).arrayBuffer())) instanceof WebAssembly.Module,
      ua: navigator.userAgent,
    }))()`;
    const r = await page.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const v = JSON.parse(String((r.result as { value?: unknown })?.value ?? "{}")) as { webrtc?: boolean; wasm?: boolean; ua?: string };
    await new Promise((res) => setTimeout(res, 500));
    const requests = page.cdp.events.map((e) => String((e.params.request as { url?: unknown } | undefined)?.url ?? ""));
    const externalRequests = requests.filter((u) => !u.startsWith(`${page.origin}/`));
    return { bundleSha256: bundle.sha256, webrtc: v.webrtc === true, wasm: v.wasm === true, userAgent: String(v.ua ?? "").slice(0, 200), requests, externalRequests };
  } finally {
    await page.close();
  }
}

type PageOutcome = Omit<MotionPreviewResult, "video" | "sessionSeconds" | "runtime"> & {
  ok: boolean;
  stage?: string;
  error?: string;
  videoBase64?: string;
  videoMimeType: string;
  timings: { readyMs: number | null; disconnectedMs: number | null; disconnectedEpochMs?: number | null };
  generatedSeconds?: number;
  startAcknowledgedBy?: string | null;
  download?: { deadlineMs: number | null; waitMs: number | null } | null;
  clipRequestAcknowledgedAtEpochMs?: number | null;
  resolution?: unknown;
};

/** The production provider: one token, one browser, one page, one session. */
export class ReactorOrbisProvider implements MotionPreviewProvider {
  readonly provider = REACTOR_GENERATOR;
  readonly model = ORBIS_MODEL;
  private used = false;
  /** Values redacted from anything this provider reports (the token once minted). */
  readonly sensitive: string[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly options: { chromePath?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.sensitive.push(apiKey);
  }

  async generate(input: { image: Uint8Array; mimeType: "image/png"; prompt: string; seed: number; resolution: string }, options: { timeoutMs: number }): Promise<MotionPreviewResult> {
    if (this.used) throw new ProviderError("This provider already ran its one session.");
    this.used = true;
    const redact = (s: unknown) => this.sensitive.reduce((t, secret) => t.split(secret).join("[REDACTED]"), String(s ?? ""));
    const scrub = (s: unknown) => redact(s).slice(0, 300);
    const failed = (category: string, message: string, live: LiveReport | null = null) => new ProviderRunError(scrub(message), runRecordFromReport(live, category, scrub(message), redact));
    let bundle: Awaited<ReturnType<typeof buildPageBundle>>;
    try {
      bundle = await buildPageBundle();
    } catch {
      throw failed("browser", "The session page could not be built.");
    }
    let jwt: string;
    try {
      ({ jwt } = await mintSessionToken(this.apiKey, this.options.fetchImpl));
    } catch (error) {
      throw failed("authentication", error instanceof ProviderError ? error.message : "The Reactor token request failed.");
    }
    this.sensitive.push(jwt);
    let page: SessionPage | null = null;
    try {
      page = await openSessionPage(this.options.chromePath ?? DEFAULT_CHROME, bundle);
    } catch (error) {
      throw failed("browser", error instanceof ProviderError ? error.message : "Headless Chrome could not open the session page.");
    }
    const cdp = page.cdp;
    // Ends the session from the page (non-recoverable) and reads what it recorded, bounded.
    const abort = async (): Promise<LiveReport | null> => {
      const r = await Promise.race([
        cdp.send("Runtime.evaluate", { expression: "globalThis.__nfAbort()", awaitPromise: true, returnByValue: true }).catch(() => null),
        new Promise<null>((res) => setTimeout(() => res(null), 8000)),
      ]);
      return ((r?.result as { value?: LiveReport | null } | undefined)?.value ?? null) as LiveReport | null;
    };
    try {
      const params = {
        jwt,
        imageBase64: Buffer.from(input.image).toString("base64"),
        imageMimeType: input.mimeType,
        imageName: "edited-still.png",
        prompt: input.prompt,
        seed: input.seed,
        resolution: input.resolution,
        maxVideoBytes: PREVIEW_MAX_BYTES,
        timeouts: { connectMs: 90_000, commandMs: 20_000, generationMs: 60_000, clipMs: 30_000 },
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const evaluated = await Promise.race([
        cdp.send("Runtime.evaluate", { expression: `globalThis.__nfRunOrbis(${JSON.stringify(params)})`, awaitPromise: true, returnByValue: true }),
        new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), options.timeoutMs))),
      ]).finally(() => clearTimeout(timer));
      if (evaluated === "timeout") throw failed("timeout", `The session did not finish within ${Math.round(options.timeoutMs / 1000)} s.`, await abort());
      if (evaluated.exceptionDetails) throw failed("page", "The session page raised an exception.", await abort());
      const outcome = (evaluated.result as { value?: PageOutcome })?.value;
      if (!outcome || typeof outcome !== "object") throw failed("page", "The session page returned nothing.", await abort());
      if (!outcome.ok) throw failed(String(outcome.stage ?? "session"), `Reactor session stopped at ${scrub(outcome.stage)}: ${scrub(outcome.error)}`, outcome);
      if (typeof outcome.videoBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(outcome.videoBase64)) throw failed("recording", "The session page returned no video.", outcome);
      const { readyMs, disconnectedMs } = outcome.timings;
      if (typeof readyMs !== "number" || typeof disconnectedMs !== "number" || disconnectedMs < readyMs) throw failed("session", "The session duration was not measured.", outcome);
      return {
        sessionId: String(outcome.sessionId),
        video: new Uint8Array(Buffer.from(outcome.videoBase64, "base64")),
        videoMimeType: outcome.videoMimeType,
        requestedClipSeconds: outcome.requestedClipSeconds,
        clip: outcome.clip,
        chunks: outcome.chunks,
        generation: outcome.generation ?? {},
        imageAccepted: outcome.imageAccepted!,
        availableResolutions: outcome.availableResolutions,
        commandsSent: outcome.commandsSent,
        sessionSeconds: (disconnectedMs - readyMs) / 1000,
        startAcknowledgedBy: String(outcome.startAcknowledgedBy),
        download: { deadlineMs: Number(outcome.download?.deadlineMs), waitMs: Number(outcome.download?.waitMs) },
        sessionClosedAt: new Date(Number(outcome.timings.disconnectedEpochMs)).toISOString(),
        clipRequestAcknowledgedAt: new Date(Number(outcome.clipRequestAcknowledgedAtEpochMs)).toISOString(),
        generatedSeconds: Number(outcome.generatedSeconds) || 0,
        runtime: { sdk: REACTOR_SDK, bundleSha256: bundle.sha256, browser: "headless Chrome (local)" },
      };
    } catch (error) {
      if (error instanceof ProviderRunError) throw error;
      throw failed("browser", error instanceof ProviderError ? error.message : "The Reactor browser session failed.", await abort());
    } finally {
      await page.close();
    }
  }
}

/** The page's report fields a run record is built from (never media or credentials). */
export type LiveReport = {
  sessionId?: string | null;
  commandsSent?: unknown;
  generatedSeconds?: unknown;
  resolution?: unknown;
  startAcknowledgedBy?: unknown;
  clip?: unknown;
  download?: unknown;
  clipRequestAcknowledgedAtEpochMs?: unknown;
  timings?: { readyMs?: number | null; disconnectedMs?: number | null; disconnectedEpochMs?: number | null };
};

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Only a clip's numeric markers and kind; its URL (and anything else) is dropped. */
function clipMarkers(v: unknown): ProviderRunRecord["clip"] {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  const [startMarker, endMarker, nowMarker] = [finite(c.startMarker), finite(c.endMarker), finite(c.nowMarker)];
  if (startMarker === null || endMarker === null || nowMarker === null) return null;
  return { kind: typeof c.kind === "string" && /^[a-z]{1,20}$/.test(c.kind) ? c.kind : "unknown", startMarker, endMarker, nowMarker, predictedReadyInMs: finite(c.predictedReadyInMs) };
}

function downloadRecord(v: unknown): ProviderRunRecord["download"] {
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  const outcome = ["downloaded", "deadline", "failed", "not-attempted"].includes(String(d.outcome)) ? String(d.outcome) : "unknown";
  return { deadlineMs: finite(d.deadlineMs), waitMs: finite(d.waitMs), outcome };
}

/** Builds a failed run's record from whatever the page reported, redacted and without payloads. */
export function runRecordFromReport(live: LiveReport | null, errorCategory: string, message: string, redact: (s: string) => string = (s) => s): ProviderRunRecord {
  const readyMs = live?.timings?.readyMs;
  const closedMs = live?.timings?.disconnectedMs;
  const reachedReady = typeof readyMs === "number" && Number.isFinite(readyMs);
  const commands = Array.isArray(live?.commandsSent) ? live.commandsSent.filter((c): c is string => typeof c === "string" && /^[a-zA-Z_]{1,40}$/.test(c)) : [];
  let resolution: unknown = null;
  try {
    resolution = live?.resolution == null ? null : JSON.parse(redact(JSON.stringify(live.resolution)));
  } catch {
    resolution = null;
  }
  return {
    errorCategory: errorCategory.slice(0, 40),
    message: redact(message).slice(0, 300),
    sessionId: typeof live?.sessionId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(live.sessionId) ? live.sessionId : null,
    commandsSent: commands,
    reachedReady,
    readyToCloseSeconds: reachedReady && typeof closedMs === "number" && closedMs >= (readyMs as number) ? Math.round((closedMs - (readyMs as number)) / 10) / 100 : null,
    generatedSeconds: typeof live?.generatedSeconds === "number" && live.generatedSeconds >= 0 ? live.generatedSeconds : 0,
    resolution,
    startAcknowledgedBy: live?.startAcknowledgedBy === "direct reply" || live?.startAcknowledgedBy === "broadcast" ? live.startAcknowledgedBy : null,
    clip: clipMarkers(live?.clip),
    download: downloadRecord(live?.download),
    sessionClosedAt: finite(live?.timings?.disconnectedEpochMs) !== null ? new Date(live!.timings!.disconnectedEpochMs as number).toISOString() : null,
    clipRequestAcknowledgedAt: finite(live?.clipRequestAcknowledgedAtEpochMs) !== null ? new Date(live!.clipRequestAcknowledgedAtEpochMs as number).toISOString() : null,
  };
}

/** The production provider from server env, or null when the key is not configured. */
export function createReactorProviderFromEnv(env: Record<string, string | undefined>): ReactorOrbisProvider | null {
  const key = env[REACTOR_API_KEY_ENV]?.trim();
  return key ? new ReactorOrbisProvider(key, { chromePath: env.CHROME_PATH?.trim() || undefined }) : null;
}
