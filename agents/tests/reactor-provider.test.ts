import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectSecrets } from "@/agents/config/env";
import { ProviderError } from "@/agents/media/gemini-provider";
import {
  buildPageBundle,
  createReactorProviderFromEnv,
  fetchOrbisRate,
  MAX_SESSION_SECONDS,
  mintSessionToken,
  REACTOR_TOKENS_URL,
  ReactorOrbisProvider,
  tokenRequestBody,
} from "@/agents/media/reactor-provider";
import { redactSecrets } from "@/agents/security/redact";

const KEY = "rk_TESTnotarealkey0000000000";
const JWT = "eyJ0ZXN0Ijp0cnVlfQ.eyJzY29wZSI6InNlc3Npb24ifQ.c2lnbmF0dXJlLW5vdC1yZWFs";

type Call = { url: string; init: RequestInit };
const fakeFetch = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
};

describe("Reactor authentication", () => {
  it("exchanges the key once for a token scoped to one Orbis session of capped duration", async () => {
    const f = fakeFetch(() => Response.json({ jwt: JWT, expires_at: 1_800_000_000 }));
    const token = await mintSessionToken(KEY, f.impl);
    assert.equal(token.jwt, JWT);
    assert.equal(f.calls.length, 1);
    const [call] = f.calls;
    assert.equal(call.url, REACTOR_TOKENS_URL);
    assert.equal(call.init.method, "POST");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Reactor-API-Key"], KEY, "documented header");
    assert.equal(Object.keys(headers).some((h) => /authorization/i.test(h)), false);
    const body = JSON.parse(String(call.init.body));
    assert.deepEqual(body, tokenRequestBody());
    assert.equal(String(call.init.body).includes(KEY), false, "the key is never in the body");
    assert.deepEqual(body.authorization_details, [
      { type: "session", resources: { models: { match: ["reactor/visko-orbis-stable"] } }, constraints: { max_sessions: 1, max_session_duration_seconds: MAX_SESSION_SECONDS } },
    ]);
  });

  it("fails closed without leaking the key: bad key format, HTTP errors, malformed responses", async () => {
    const never = fakeFetch(() => assert.fail("must not be called"));
    await assert.rejects(mintSessionToken("not-a-reactor-key", never.impl), ProviderError);
    assert.equal(never.calls.length, 0);
    for (const res of [() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }), () => Response.json({ token: "x" }), () => Response.json({ jwt: "not-a-jwt", expires_at: 1 })]) {
      const f = fakeFetch(res);
      await assert.rejects(mintSessionToken(KEY, f.impl), (e: Error) => e instanceof ProviderError && !e.message.includes(KEY) && !e.message.includes(JWT));
      assert.equal(f.calls.length, 1, "no retry");
    }
    const offline = (async () => Promise.reject(new Error(`socket closed for ${KEY}`))) as typeof fetch;
    await assert.rejects(mintSessionToken(KEY, offline), (e: Error) => !e.message.includes(KEY));
  });

  it("treats REACTOR_API_KEY as a secret everywhere output is redacted", () => {
    const secrets = collectSecrets({ REACTOR_API_KEY: KEY });
    assert.ok(secrets.includes(KEY));
    assert.equal(redactSecrets(`failed with ${KEY} in it`, secrets).includes(KEY), false);
  });

  it("reads the key only from server env, and the provider runs once", async () => {
    assert.equal(createReactorProviderFromEnv({}), null);
    assert.equal(createReactorProviderFromEnv({ NEXT_PUBLIC_REACTOR_API_KEY: KEY }), null, "never from a public variable");
    const f = fakeFetch(() => new Response("{}", { status: 403 }));
    const provider = new ReactorOrbisProvider(KEY, { fetchImpl: f.impl, chromePath: "/nonexistent/chrome" });
    const input = { image: new Uint8Array([1]), mimeType: "image/png" as const, prompt: "p", seed: 42, resolution: "1080p" };
    await assert.rejects(provider.generate(input, { timeoutMs: 5000 }), (e: Error) => e instanceof ProviderError && /HTTP 403/.test(e.message) && !e.message.includes(KEY));
    await assert.rejects(provider.generate(input, { timeoutMs: 5000 }), /already ran its one session/);
    assert.equal(f.calls.length, 1, "one token request, no retry, and no browser after a failed exchange");
  });
});

describe("Reactor pricing", () => {
  it("uses only a published numeric per-second rate for this model", async () => {
    const tbd = fakeFetch(() => Response.json({ settings: { credits_per_dollar: 10000 }, models: [{ name: "helios", rate: { amount_per_sec_usd: "0.0017" } }] }));
    assert.equal(await fetchOrbisRate(tbd.impl), null, "no entry: rate TBD");
    const listed = fakeFetch(() => Response.json({ models: [{ name: "visko-orbis-stable", rate: { amount_per_sec_usd: "0.0021" } }] }));
    const rate = await fetchOrbisRate(listed.impl, () => new Date("2026-10-16T00:00:00.000Z"));
    assert.deepEqual(rate && { usd: rate.usdPerSecond, at: rate.retrievedAt }, { usd: 0.0021, at: "2026-10-16T00:00:00.000Z" });
    const bad = fakeFetch(() => Response.json({ models: [{ name: "visko-orbis-stable", rate: { amount_per_sec_usd: "-1" } }] }));
    assert.equal(await fetchOrbisRate(bad.impl), null);
    const down = fakeFetch(() => new Response("", { status: 500 }));
    assert.equal(await fetchOrbisRate(down.impl), null);
  });
});

describe("browser page boundary", () => {
  it("bundles the SDK page without any key handling or token minting", async () => {
    const bundle = await buildPageBundle();
    const js = Buffer.from(bundle.js).toString("utf8");
    for (const banned of ["REACTOR_API_KEY", "Reactor-API-Key", "api.reactor.inc/tokens", "rk_"]) assert.equal(js.includes(banned), false, banned);
    assert.ok(js.includes("__nfRunOrbis"));
    assert.ok(bundle.wasm.byteLength > 100_000, "the SDK's WebAssembly binding is served beside the page");
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/);
  });

  it("never exposes Reactor credentials through public env or client code", async () => {
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) files.push(p);
      }
    };
    for (const d of ["app", "components", "lib", "agents"]) await walk(d).catch(() => {});
    for (const f of files) {
      const text = await readFile(f, "utf8");
      if (f.endsWith("reactor-provider.test.ts")) continue;
      assert.equal(/NEXT_PUBLIC_REACTOR/.test(text), false, f);
      if (/^(app|components|lib)\//.test(f)) assert.equal(/REACTOR_API_KEY|reactor-provider|@reactor-team\/js-sdk/.test(text), false, f);
    }
  });
});
