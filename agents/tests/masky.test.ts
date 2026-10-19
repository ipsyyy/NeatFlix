import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { describeShape, MaskyClient, parseSpeechStart, parseSpeechStatus, safeVoiceLines, MaskyError, type MaskyApi, type MaskyVoice, type SpeakState } from "@/agents/masky/client";
import { avatarsByRole, FileAvatarLedger, findAvatarByDisplayName, speechByRole, type AvatarLedger, type AvatarLedgerEvent, type LedgerEvent } from "@/agents/masky/ledger";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkMediaBucket,
  diagnoseSpeech,
  mediaBucketReadiness,
  REQUIRED_MEDIA_TYPES,
  downloadProviderMedia,
  EMPTY_MANIFEST,
  estimateCredits,
  FALLBACK_DISCLOSURE,
  generateIdentities,
  isNonPublicAddress,
  presentIdentity,
  resolveVoices,
  validateManifest,
  type GenerationDeps,
  type IdentityManifest,
} from "@/agents/masky/generate";
import { AGENT_IDENTITIES, identitySpecSha256, portraitSvg, validateIdentities, type AgentIdentity } from "@/agents/masky/identities";
import { PORTRAIT_HANDOFF_TTL_SECONDS, SupabasePrivateStorage, type PortraitHandoffStorage } from "@/agents/persistence/private-storage";

const VOICES: MaskyVoice[] = [
  { id: "v-warm", name: "Warm Calm Female", source: "preset" },
  { id: "v-young", name: "Young Energetic Male", source: "preset" },
  { id: "v-conf", name: "Confident Female Pro", source: "preset" },
  { id: "v-deep", name: "Deep Male", source: "preset" },
  { id: "v-brit", name: "Authoritative British Female", source: "preset" },
  { id: "v-extra", name: "Narrator", source: "preset" },
];
const HANDOFF = "https://project.supabase.co/storage/v1/object/sign/nf-media/agents/portraits/x.png?token=secret-token";
const MEDIA_URL = "https://media.masky.example/out.bin?sig=provider-signature";

class FakeStorage implements PortraitHandoffStorage {
  readonly objects = new Map<string, Uint8Array>();
  handoffs: string[] = [];
  async download(ref: string) {
    return this.objects.get(ref) ?? null;
  }
  async uploadNew(ref: string, bytes: Uint8Array) {
    if (this.objects.has(ref)) return "exists" as const;
    this.objects.set(ref, new Uint8Array(bytes));
    return "created" as const;
  }
  async createPortraitHandoffUrl(ref: string) {
    this.handoffs.push(ref);
    return HANDOFF;
  }
}

class FakeMasky implements MaskyApi {
  calls: string[] = [];
  failStartFor: AgentRole | null = null;
  statusOverride: SpeakState | null = null;
  /** Offsets new avatar ids, so a second run never reissues an id a first run already used. */
  idOffset = 0;
  avatarInputs: { imageUrl: string; voiceId: string; displayName: string }[] = [];
  speech: { text: string; output: string }[] = [];
  failSpeechFor: AgentRole | null = null;
  pendingPolls = 1;
  voices = VOICES;
  private polls = new Map<string, number>();
  async listVoices() {
    this.calls.push("voices");
    return this.voices;
  }
  async createAvatar(input: { displayName: string; imageUrl: string; personalityPrompt: string; voiceId: string }) {
    this.calls.push("avatar");
    this.avatarInputs.push(input);
    return { avatarId: `av-${this.avatarInputs.length + this.idOffset}` };
  }
  async primaryImageAssetId(avatarId: string) {
    this.calls.push("images");
    return { assetId: `asset-${avatarId}`, unexpectedShape: null };
  }
  async listAvatars() {
    this.calls.push("list-avatars");
    return [];
  }
  async startSpeech(avatarId: string, text: string, output: "audio" | "video") {
    this.calls.push("speak");
    if (AGENT_ROLES[Number(avatarId.split("-").pop()) - 1] === this.failStartFor) throw new MaskyError(502, "upstream failure");
    this.speech.push({ text, output });
    return { generationId: `gen-${avatarId}`, reused: false };
  }
  async speechStatus(generationId: string): Promise<SpeakState> {
    this.calls.push("status");
    if (this.statusOverride) return this.statusOverride;
    const n = (this.polls.get(generationId) ?? 0) + 1;
    this.polls.set(generationId, n);
    const role = AGENT_ROLES[Number(generationId.split("-").pop()) - 1];
    if (role === this.failSpeechFor) return { state: "failed", status: "error" };
    return n <= this.pendingPolls ? { state: "pending", status: "pending" } : { state: "done", status: "ready", mediaUrl: MEDIA_URL };
  }
}

class FakeLedger implements AvatarLedger {
  events: LedgerEvent[] = [];
  fail = false;
  constructor(private readonly calls: string[]) {}
  async append(e: LedgerEvent) {
    this.calls.push("ledger");
    if (this.fail) throw new Error("disk full");
    this.events.push(e);
  }
}

function deps(over: Partial<GenerationDeps> = {}) {
  const masky = new FakeMasky();
  const ledger = new FakeLedger(masky.calls);
  const storage = new FakeStorage();
  const downloads: string[] = [];
  let current: "audio" | "video" = "audio";
  const d: GenerationDeps = {
    masky,
    ledger,
    storage,
    renderPng: async (svg) => new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()),
    download: async (url) => {
      downloads.push(url);
      current = masky.speech.at(-1)?.output === "video" ? "video" : "audio";
      return current === "video" ? { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "video/mp4" } : { bytes: new Uint8Array([5, 6, 7]), contentType: "audio/mpeg" };
    },
    probe: async () => ({ durationSeconds: 6.4, hasAudio: true, hasVideo: current === "video", width: current === "video" ? 720 : null, height: current === "video" ? 720 : null }),
    clock: () => new Date("2026-10-17T00:00:00.000Z"),
    sleep: async () => {},
    maxPolls: 5,
    ...over,
  };
  return { d, masky, storage, downloads, ledger };
}

describe("Masky identity specs", () => {
  it("gives five agents distinct, honest identities with the Release Governor as the one primary video identity", () => {
    assert.deepEqual(validateIdentities(), []);
    assert.deepEqual(Object.keys(AGENT_IDENTITIES).sort(), [...AGENT_ROLES].sort());
    assert.deepEqual(AGENT_ROLES.filter((r) => AGENT_IDENTITIES[r].prominence === "primary"), ["release-governor"]);
    assert.deepEqual(AGENT_ROLES.filter((r) => AGENT_IDENTITIES[r].spokenOutput === "video"), ["release-governor"]);
    assert.equal(new Set(AGENT_ROLES.map((r) => AGENT_IDENTITIES[r].characterName)).size, 5);
  });

  it("refuses duplicate names, URLs or keys, overlong lines, a second primary, or an unsupported claim", () => {
    const tweak = (role: AgentRole, over: Partial<AgentIdentity>) => validateIdentities({ ...AGENT_IDENTITIES, [role]: { ...AGENT_IDENTITIES[role], ...over } });
    assert.ok(tweak("scene-scout", { characterName: "Iris Vale" }).some((e) => /names/.test(e)));
    assert.ok(tweak("scene-scout", { personality: "See https://example.com for more." }).some((e) => /URLs or credentials/.test(e)));
    assert.ok(tweak("scene-scout", { personality: "Key mky_abcdefghijkl." }).some((e) => /URLs or credentials/.test(e)));
    assert.ok(tweak("scene-scout", { spokenLine: "x".repeat(201) }).some((e) => /spoken line/.test(e)));
    assert.ok(tweak("scene-scout", { prominence: "primary" }).some((e) => /only primary/.test(e)));
    assert.ok(tweak("release-governor", { spokenLine: "Reactor generated the preview and it is approved for release." }).some((e) => /unsupported claim/.test(e)));
  });

  it("renders deterministic, distinct 1024×1024 local portraits, with a gold frame only for the Release Governor", async () => {
    const svgs = AGENT_ROLES.map((r) => portraitSvg(AGENT_IDENTITIES[r]));
    assert.deepEqual(svgs, AGENT_ROLES.map((r) => portraitSvg(AGENT_IDENTITIES[r])), "deterministic");
    assert.equal(new Set(svgs).size, 5);
    assert.ok(svgs.every((s) => !/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(s)), "no external references");
    assert.deepEqual(svgs.map((s) => /r="492"/.test(s)), AGENT_ROLES.map((r) => r === "release-governor"));
    const meta = await sharp(Buffer.from(svgs[4])).png().metadata();
    assert.deepEqual([meta.width, meta.height], [1024, 1024]);
  });

  it("estimates cost from Masky's published speech rates", () => {
    assert.ok(estimateCredits(AGENT_IDENTITIES["release-governor"]) > estimateCredits(AGENT_IDENTITIES["scene-scout"]) * 10, "video costs far more than audio");
  });
});

describe("Masky voice resolution", () => {
  it("picks five distinct voices by preference, honours overrides, and fails closed", () => {
    const r = resolveVoices(VOICES);
    assert.ok(r.ok);
    assert.equal(new Set(AGENT_ROLES.map((role) => r.value[role].id)).size, 5);
    assert.equal(r.value["release-governor"].id, "v-brit");
    const o = resolveVoices(VOICES, { "content-curator": "v-extra" });
    assert.ok(o.ok && o.value["content-curator"].id === "v-extra");
    assert.equal(resolveVoices(VOICES.slice(0, 4)).ok, false, "fewer than five voices");
    assert.equal(resolveVoices(VOICES, { "scene-scout": "missing" }).ok, false, "unknown override");
    assert.equal(resolveVoices(VOICES, { "scene-scout": "v-deep", "placement-director": "v-deep" }).ok, false, "duplicate override");
  });
});

describe("Masky client", () => {
  const fakeFetch = (responses: { status: number; body: unknown }[]) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fn, requests };
  };

  it("sends the key only as a bearer token, never makes an avatar publicly renderable, and speaks literally", async () => {
    const f = fakeFetch([
      { status: 200, body: { avatar: { avatarId: "av1", avatarOwnerUserId: "u1" } } },
      { status: 200, body: { avatarId: "av2" } },
      { status: 200, body: { generationId: "g1", reused: true } },
      { status: 200, body: { status: "audio", audioUrl: "https://cdn.example/a.mp3" } },
    ]);
    const c = new MaskyClient("mky_testkey12345", f.fn);
    assert.deepEqual(await c.createAvatar({ displayName: "D", imageUrl: "https://x/p.png", personalityPrompt: "P", voiceId: "v" }), { avatarId: "av1" });
    assert.deepEqual(await c.createAvatar({ displayName: "D", imageUrl: "https://x/p.png", personalityPrompt: "P", voiceId: "v" }), { avatarId: "av2" });
    assert.deepEqual(await c.startSpeech("av1", "Hello.", "audio"), { generationId: "g1", reused: true });
    assert.deepEqual(await c.speechStatus("g1", "audio"), { state: "done", status: "audio", mediaUrl: "https://cdn.example/a.mp3" });
    assert.equal(f.requests[0].url, "https://masky.ai/api/avatars");
    assert.equal((f.requests[0].init.headers as Record<string, string>).Authorization, "Bearer mky_testkey12345");
    assert.equal(JSON.parse(String(f.requests[0].init.body)).publiclyRenderable, false);
    assert.deepEqual(JSON.parse(String(f.requests[2].init.body)), { text: "Hello.", textMode: "literal", output: "audio" });
  });

  it("reports errors with status only, scrubbing URLs and keys, and rejects unexpected shapes or keys", async () => {
    const f = fakeFetch([
      { status: 402, body: { error: "Insufficient credits; see https://masky.ai/billing?k=1 for mky_leakedkey99" } },
      { status: 200, body: { voices: "nope" } },
    ]);
    const c = new MaskyClient("mky_testkey12345", f.fn);
    await assert.rejects(c.listVoices(), (e: unknown) => e instanceof MaskyError && e.status === 402 && !/https|mky_leaked/.test(e.message));
    await assert.rejects(c.listVoices(), (e: unknown) => e instanceof MaskyError && /unexpected response shape/.test(e.message));
    assert.throws(() => new MaskyClient("sk-not-masky"), /mky_/);
  });
});

describe("Masky bounded generation", () => {
  it("creates five identities, stores media privately, and records only identifiers and checksums", async () => {
    const { d, masky, storage, downloads } = deps();
    const r = await generateIdentities(d);
    assert.equal(r.failed, null, JSON.stringify(r.failed));
    assert.deepEqual(r.completed, [...AGENT_ROLES]);
    assert.deepEqual(validateManifest(r.manifest), []);
    const text = JSON.stringify(r.manifest);
    assert.ok(!text.includes("https") && !text.includes("token") && !text.includes("sig="), "no provider or handoff URL is recorded");
    assert.equal(masky.calls.filter((c) => c === "avatar").length, 5, "exactly one avatar per agent");
    assert.ok(masky.avatarInputs.every((a) => a.imageUrl === HANDOFF), "Masky receives the portrait only through the handoff URL");
    assert.deepEqual(storage.handoffs, AGENT_ROLES.map((r) => `storage://nf-media/agents/portraits/${r}-v1.png`));
    assert.deepEqual(masky.speech.map((s) => s.output), ["audio", "audio", "audio", "audio", "video"]);
    assert.deepEqual(masky.speech.map((s) => s.text), AGENT_ROLES.map((role) => AGENT_IDENTITIES[role].spokenLine));
    assert.equal(downloads.length, 5);
    assert.equal(r.manifest.entries["release-governor"]!.spoken.storageRef, "storage://nf-media/agents/spoken/release-governor-v1.mp4");
    assert.equal(r.manifest.entries["scene-scout"]!.spoken.storageRef, "storage://nf-media/agents/spoken/scene-scout-v1.mp3");
    assert.ok(storage.objects.has("storage://nf-media/agents/spoken/release-governor-v1.mp4"));
  });

  it("stops at the first failure and keeps only the identities completed before it", async () => {
    const { d, masky } = deps();
    masky.failSpeechFor = "scene-scout";
    const r = await generateIdentities(d);
    assert.deepEqual(r.completed, ["content-curator"]);
    assert.deepEqual([r.failed?.role, r.failed?.stage], ["scene-scout", "speech"]);
    assert.equal(masky.avatarInputs.length, 2, "no avatar is created after the failure");
  });

  it("fails closed on polling timeout, wrong media type, oversized or invalid media, and voice shortage", async () => {
    const slow = deps({ maxPolls: 1 });
    slow.masky.pendingPolls = 5;
    assert.equal((await generateIdentities(slow.d)).failed?.stage, "speech");

    const wrongType = deps({ download: async () => ({ bytes: new Uint8Array([1]), contentType: "text/html" }) });
    assert.equal((await generateIdentities(wrongType.d)).failed?.stage, "download");

    const huge = deps({ download: async () => ({ bytes: new Uint8Array(25 * 1024 * 1024 + 1), contentType: "audio/mpeg" }) });
    assert.equal((await generateIdentities(huge.d)).failed?.stage, "download");

    const silent = deps({ probe: async () => ({ durationSeconds: 0.2, hasAudio: false, hasVideo: false, width: null, height: null }) });
    const s = await generateIdentities(silent.d);
    assert.deepEqual([s.failed?.stage, s.completed.length], ["download", 0]);
    assert.ok(!/https/.test(s.failed!.error), "errors never carry URLs");

    const few = deps();
    few.masky.voices = VOICES.slice(0, 3);
    const v = await generateIdentities(few.d);
    assert.deepEqual([v.failed?.stage, few.masky.avatarInputs.length], ["voices", 0]);
  });

  it("never creates a second avatar once identities are recorded, and refuses a different object at a private path", async () => {
    const first = await generateIdentities(deps().d);
    const again = deps();
    const r = await generateIdentities(again.d, { existing: first.manifest });
    assert.equal(r.failed?.stage, "existing");
    assert.deepEqual(again.masky.calls, [], "no Masky call at all");

    const clash = deps();
    clash.storage.objects.set("storage://nf-media/agents/portraits/content-curator-v1.png", new Uint8Array([9]));
    assert.equal((await generateIdentities(clash.d)).failed?.stage, "portrait");
  });
});

describe("Masky manifest and fallback", () => {
  it("validates only safe, spec-bound metadata", async () => {
    const { manifest } = await generateIdentities(deps().d);
    const entry = manifest.entries["release-governor"]!;
    const variant = (e: object): IdentityManifest => ({ ...manifest, entries: { ...manifest.entries, "release-governor": e as typeof entry } });
    assert.ok(validateManifest(variant({ ...entry, avatar: { ...entry.avatar, previewUrl: "https://masky.ai/g-1" } })).length > 0, "URL");
    assert.ok(validateManifest(variant({ ...entry, voice: { ...entry.voice, note: "mky_secretkey123" } })).length > 0, "key");
    assert.ok(validateManifest(variant({ ...entry, specSha256: "0".repeat(64) })).length > 0, "spec changed");
    assert.ok(validateManifest(variant({ ...entry, avatar: { ...entry.avatar, publiclyRenderable: true } })).length > 0, "public avatar");
    assert.ok(validateManifest(variant({ ...entry, spoken: { ...entry.spoken, mimeType: "audio/mpeg" } })).length > 0, "video result stored as audio");
    assert.ok(validateManifest(variant({ ...entry, avatar: manifest.entries["scene-scout"]!.avatar })).length > 0, "duplicate avatar");
  });

  it("presents a recorded identity, and otherwise the deterministic local fallback with a disclosure", async () => {
    const { manifest } = await generateIdentities(deps().d);
    const live = presentIdentity("release-governor", manifest);
    assert.ok(live.mode === "masky" && live.spoken.output === "video" && live.prominence === "primary");
    const none = presentIdentity("release-governor", EMPTY_MANIFEST);
    assert.ok(none.mode === "fallback" && none.spoken === null && none.disclosure === FALLBACK_DISCLOSURE);
    assert.equal(none.portraitSvg, portraitSvg(AGENT_IDENTITIES["release-governor"]));
    assert.equal(none.caption, AGENT_IDENTITIES["release-governor"].spokenLine);
    const tampered = { ...manifest, entries: { ...manifest.entries, "scene-scout": { ...manifest.entries["scene-scout"]!, characterName: "Someone Else" } } };
    assert.equal(presentIdentity("scene-scout", tampered).mode, "fallback");
    assert.equal(presentIdentity("scene-scout", "not a manifest").mode, "fallback");
  });
});

describe("Masky privacy boundaries", () => {
  it("creates a short-lived handoff URL only for agent portraits", async () => {
    const requests: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ signedURL: "/object/sign/nf-media/agents/portraits/release-governor-v1.png?token=t" }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new SupabasePrivateStorage("https://project.supabase.co", "sb_secret_TEST0000notarealkey0000", fetchImpl);
    const url = await s.createPortraitHandoffUrl("storage://nf-media/agents/portraits/release-governor-v1.png");
    assert.equal(url, "https://project.supabase.co/storage/v1/object/sign/nf-media/agents/portraits/release-governor-v1.png?token=t");
    assert.deepEqual(JSON.parse(requests[0].body), { expiresIn: PORTRAIT_HANDOFF_TTL_SECONDS });
    for (const ref of [
      "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/generated-preview-v3-fallback.mp4",
      "storage://nf-media/agents/spoken/release-governor-v1.mp4",
      "storage://nf-media/agents/portraits/../x.png",
      "storage://other-bucket/agents/portraits/x.png",
    ]) {
      await assert.rejects(s.createPortraitHandoffUrl(ref), /Only an agent portrait/, ref);
    }
    assert.equal(requests.length, 1);
  });

  it("keeps Masky out of client code and the client bundle", () => {
    const files = (dir: string): string[] =>
      existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)])) : [];
    for (const file of ["app", "components", "lib", "data"].flatMap(files).filter((f) => /\.(tsx?|jsx?|json)$/.test(f))) {
      const src = readFileSync(file, "utf8");
      // The demo may name Masky on screen; Masky's API, key, client code, and any agent code stay server-only.
      assert.ok(!/masky\.ai|MASKY_API_KEY|mky_|@\/agents|agents\/masky/i.test(src), `${file} must not reference the Masky API or server agent code`);
    }
    assert.match(readFileSync("eslint.config.mjs", "utf8"), /"@\/agents\/\*"/);
    const bundle = ".next/static";
    for (const file of files(bundle).filter((f) => f.endsWith(".js"))) {
      assert.ok(!/masky\.ai|MASKY_API_KEY|mky_/.test(readFileSync(file, "utf8")), `${file} must not contain Masky code`);
    }
  });

  it("downloads provider media only over https to public hosts, re-checking every redirect hop", async () => {
    const publicDns = async () => [{ address: "93.184.216.34" }];
    const calls: { url: string; redirect: string | undefined }[] = [];
    const routes: Record<string, Response | (() => Response)> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, redirect: init.redirect });
      const r = routes[url];
      return typeof r === "function" ? r() : r;
    }) as unknown as typeof fetch;
    const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    routes["https://cdn.example.com/a.mp3"] = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    routes["https://cdn.example.com/hop"] = redirect("https://cdn.example.com/a.mp3");
    routes["https://cdn.example.com/to-http"] = redirect("http://cdn.example.com/a.mp3");
    routes["https://cdn.example.com/to-metadata"] = redirect("https://169.254.169.254/latest/meta-data");
    routes["https://cdn.example.com/loop"] = redirect("https://cdn.example.com/loop");
    routes["https://cdn.example.com/huge"] = () => new Response(new Uint8Array(64), { status: 200, headers: { "content-type": "audio/mpeg" } });

    const ok = await downloadProviderMedia("https://cdn.example.com/hop", { fetchImpl, lookup: publicDns });
    assert.deepEqual([...ok.bytes], [1, 2, 3]);
    assert.ok(calls.every((c) => c.redirect === "manual"), "redirects are never followed automatically");

    const refused: [string, Parameters<typeof downloadProviderMedia>[1]?][] = [
      ["http://cdn.example.com/a.mp3"],
      ["https://cdn.example.com/to-http"],
      ["https://cdn.example.com/to-metadata"],
      ["https://user:pw@cdn.example.com/a.mp3"],
      ["https://localhost/a.mp3"],
      ["https://10.0.0.5/a.mp3"],
      ["https://cdn.example.com/a.mp3", { lookup: async () => [{ address: "127.0.0.1" }] }],
      ["https://cdn.example.com/a.mp3", { lookup: async () => [{ address: "93.184.216.34" }, { address: "fd00::1" }] }],
      ["https://cdn.example.com/loop"],
      ["https://cdn.example.com/huge", { maxBytes: 10 }],
    ];
    for (const [url, opts] of refused) {
      const before = calls.length;
      await assert.rejects(downloadProviderMedia(url, { fetchImpl, lookup: publicDns, ...opts }), Error, url);
      if (/\/\/(localhost|10\.|user:)|^http:/.test(url)) assert.equal(calls.length, before, `${url}: refused before any request`);
    }
    assert.deepEqual(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd12::1", "::ffff:10.0.0.1"].filter((a) => !isNonPublicAddress(a)), []);
    assert.deepEqual(["93.184.216.34", "8.8.8.8", "2606:4700::1111"].filter(isNonPublicAddress), []);
  });
});

describe("Masky avatar recovery: no unrecorded avatar", () => {
  it("records every avatar in the ledger before any later request, so no later failure can orphan it", async () => {
    const failures: [string, (x: ReturnType<typeof deps>) => void, string][] = [
      ["speech request", (x) => (x.masky.failStartFor = "scene-scout"), "speech"],
      ["speech render", (x) => (x.masky.failSpeechFor = "scene-scout"), "speech"],
      ["download", (x) => (x.d.download = async () => Promise.reject(new Error("network"))), "download"],
      ["validation", (x) => (x.d.probe = async () => ({ durationSeconds: 0, hasAudio: false, hasVideo: false, width: null, height: null })), "download"],
      ["private storage", (x) => (x.storage.uploadNew = async (ref: string) => { if (ref.includes("/spoken/")) throw new Error("storage down"); return "created" as const; }), "download"],
    ];
    for (const [name, inject, stage] of failures) {
      const x = deps();
      inject(x);
      const r = await generateIdentities(x.d);
      assert.equal(r.failed?.stage, stage, name);
      const avatarEvents = x.ledger.events.filter((e) => e.event === "avatar-created");
      assert.equal(x.masky.avatarInputs.length, avatarEvents.length, `${name}: every created avatar is recorded`);
      assert.ok(avatarEvents.length >= 1, name);
      // In the call order, each "avatar" is immediately followed by its "ledger" write.
      x.masky.calls.forEach((c, i) => c === "avatar" && assert.equal(x.masky.calls[i + 1], "ledger", `${name}: ledger right after creation`));
      assert.ok(!x.masky.calls.includes("images"), "the image lookup is not on the critical path");
    }
  });

  it("stops before any further request when the ledger cannot be written, and still reports the avatar id", async () => {
    const lines: string[] = [];
    const x = deps({ log: (l) => lines.push(l) });
    x.ledger.fail = true;
    const r = await generateIdentities(x.d);
    assert.deepEqual([r.failed?.role, r.failed?.stage], ["content-curator", "ledger"]);
    assert.deepEqual(x.masky.calls, ["voices", "avatar", "ledger"], "nothing after the failed ledger write");
    assert.ok(lines.some((l) => l.includes("av-1")), "the avatar id is printed as a backstop");
  });

  it("reuses a recorded avatar and its voice instead of creating another", async () => {
    const x = deps();
    const r = await generateIdentities(x.d, { reuse: { "content-curator": { maskyAvatarId: "adopted-1", voiceId: "v-extra" } } });
    assert.equal(r.failed, null, JSON.stringify(r.failed));
    assert.equal(x.masky.avatarInputs.length, 4, "only four new avatars");
    assert.equal(x.ledger.events.filter((e) => e.event === "avatar-created").length, 4);
    assert.deepEqual([r.manifest.entries["content-curator"]!.avatar.maskyAvatarId, r.manifest.entries["content-curator"]!.voice.id], ["adopted-1", "v-extra"]);
    assert.ok(!x.masky.avatarInputs.some((a) => a.voiceId === "v-extra"), "the reused voice stays distinct");
    assert.deepEqual(validateManifest(r.manifest), []);
    const clash = await generateIdentities(deps().d, { reuse: { "content-curator": { maskyAvatarId: "adopted-1", voiceId: "v-extra" } }, voiceOverrides: { "content-curator": "v-warm" } });
    assert.equal(clash.failed?.stage, "voices", "a reused avatar keeps its voice");
  });

  it("gives the Release Governor the most authoritative voice and the Campaign Matcher an analytical one, all distinct", async () => {
    const real: MaskyVoice[] = [
      { id: "a", name: "Warm Female Assistant Voice", source: "preset" },
      { id: "b", name: "Soft Male Conversationalist", source: "preset" },
      { id: "c", name: "Female Meditation Guide", source: "preset" },
      { id: "d", name: "Deep Male Conversational Voice", source: "preset" },
      { id: "e", name: "Warm American Female", source: "preset" },
      { id: "f", name: "Authoritative Female Narrator", source: "preset" },
      { id: "g", name: "Analytical Professional Female", source: "preset" },
      { id: "h", name: "Confident Young Male", source: "preset" },
    ];
    const r = resolveVoices(real, { "content-curator": "a" });
    assert.ok(r.ok);
    assert.equal(r.value["release-governor"].name, "Authoritative Female Narrator");
    assert.equal(r.value["campaign-matcher"].name, "Analytical Professional Female");
    assert.ok(!Object.values(r.value).some((v) => /meditation/i.test(v.name)), "unsuitable styles are avoided");
    assert.equal(new Set(Object.values(r.value).map((v) => v.id)).size, 5);
    // Required terms: without a matching voice the role gets none, and the batch stops before any avatar.
    const noAuthority = resolveVoices(real.filter((v) => v.id !== "f"), { "content-curator": "a" });
    assert.ok(!noAuthority.ok && noAuthority.errors.some((e) => /release-governor.*authoritative, commanding, formal/.test(e)));
    const noAnalyst = resolveVoices(real.filter((v) => v.id !== "g" && v.id !== "h"), { "content-curator": "a" });
    assert.ok(!noAnalyst.ok && noAnalyst.errors.some((e) => /campaign-matcher.*analytical, confident, professional/.test(e)));
    const few = deps();
    few.masky.voices = VOICES.filter((v) => v.id !== "v-brit");
    const stopped = await generateIdentities(few.d);
    assert.deepEqual([stopped.failed?.stage, few.masky.avatarInputs.length], ["voices", 0], "no avatar when the Governor cannot get an authoritative voice");
    // The Governor chooses first: an "authoritative" voice goes to it even if another role could match it.
    const contested = resolveVoices([...real.filter((v) => v.id !== "g"), { id: "z", name: "Authoritative Analytical Voice", source: "preset" }]);
    assert.ok(contested.ok && contested.value["release-governor"].id === "f");
  });

  it("keeps the ledger append-only and identifier-only, and adopts only on exactly one exact match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nf-ledger-"));
    try {
      const path = join(dir, "avatar-ledger.jsonl");
      const ledger = new FileAvatarLedger(path);
      const event: AvatarLedgerEvent = { event: "avatar-adopted", role: "content-curator", maskyAvatarId: "av-123", displayName: "Iris Vale, NativeFrame Content Curator", voice: { id: "voice_1", name: "Warm" }, specSha256: identitySpecSha256(AGENT_IDENTITIES["content-curator"]), source: "GET /avatars", at: "2026-10-17T00:00:00.000Z" };
      await ledger.append(event);
      const first = readFileSync(path, "utf8");
      await ledger.append({ ...event, event: "avatar-created", role: "scene-scout", maskyAvatarId: "av-456", voice: { id: "voice_2", name: "Young" } });
      assert.ok(readFileSync(path, "utf8").startsWith(first), "earlier lines are never rewritten");
      assert.equal(ledger.read().length, 2);
      await assert.rejects(ledger.append({ ...event, source: "https://masky.ai/api/avatars" }), /identifiers only/);
      await assert.rejects(ledger.append({ ...event, maskyAvatarId: "" }), /avatar id/);
      assert.ok(avatarsByRole(ledger.read()).ok);
      assert.equal(avatarsByRole([event, { ...event, maskyAvatarId: "av-other" }]).ok, false, "two avatars for one role");
      assert.equal(avatarsByRole([event, { ...event, role: "scene-scout", maskyAvatarId: "av-x" }]).ok, false, "a shared voice");
      writeFileSync(path, `${first}{"event":"avatar-created","role":"nope"}\n`);
      assert.throws(() => ledger.read(), /line 2 is invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const name = "Iris Vale, NativeFrame Content Curator";
    assert.deepEqual(findAvatarByDisplayName([{ avatarId: "x1", displayName: name }, { avatarId: "x2", displayName: "Other" }], name), { ok: true, avatarId: "x1" });
    assert.equal(findAvatarByDisplayName([], name).ok, false, "zero matches");
    assert.equal(findAvatarByDisplayName([{ avatarId: "x1", displayName: name }, { avatarId: "x2", displayName: name }], name).ok, false, "two matches");
    assert.equal(findAvatarByDisplayName([{ avatarId: "x1", displayName: `${name} ` }], name).ok, false, "never a near match");
  });

  it("reports an unexpected image-list shape only as redacted structure, never failing or leaking values", async () => {
    const body = { primary: { url: "https://cdn.example/p.png?token=abc", assetId: "secret-asset" }, items: [{ href: "https://cdn.example/x", n: 3 }] };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const r = await new MaskyClient("mky_testkey12345", fetchImpl).primaryImageAssetId("av1");
    assert.equal(r.assetId, null);
    assert.deepEqual(r.unexpectedShape, { items: [{ href: "string", n: "number" }], primary: { assetId: "string", url: "string" } });
    assert.ok(!/https|token|secret-asset/.test(JSON.stringify(r.unexpectedShape)));
    assert.deepEqual(describeShape(null), "null");
  });

  it("lists voices as safe name, id, and source lines only", () => {
    const lines = safeVoiceLines([
      { id: "voice_b", name: "Zed Narrator", source: "preset" },
      { id: "voice_a", name: "Anna\nsee https://cdn.example/x?token=1 mky_secretkey99", source: "custom" },
      { id: "bad id/../x", name: "Odd", source: "preset" },
    ]);
    assert.deepEqual(lines, ["Anna see <url> <redacted> | voice_a | custom", "Odd | <invalid id> | preset", "Zed Narrator | voice_b | preset"]);
  });
});

describe("Masky speech recovery: job ids, tolerant status parsing, no duplicate charge", () => {
  it("parses the documented status and common wrappers, and fails closed on anything else with redacted structure", () => {
    const url = "https://cdn.example.com/a.mp3?sig=s3cret";
    assert.deepEqual(parseSpeechStatus({ status: "audio", audioUrl: url }, "audio"), { state: "done", status: "audio", mediaUrl: url });
    for (const wrapper of ["generation", "data", "result", "speech", "job"]) {
      assert.deepEqual(parseSpeechStatus({ [wrapper]: { status: "ready", audioUrl: url } }, "audio"), { state: "done", status: "ready", mediaUrl: url }, wrapper);
    }
    assert.deepEqual(parseSpeechStatus({ status: "video", video: { url } }, "video"), { state: "done", status: "video", mediaUrl: url });
    assert.deepEqual(parseSpeechStatus({ status: "pending" }, "audio"), { state: "pending", status: "pending" });
    assert.deepEqual(parseSpeechStatus({ generation: { status: "audio" } }, "video"), { state: "pending", status: "audio" }, "audio stage of a video job");
    assert.deepEqual(parseSpeechStatus({ status: "error" }, "audio"), { state: "failed", status: "error" });
    const unknowns: unknown[] = [
      { state: "ok", media: { link: url } },
      { status: "ready" },
      { status: "ready", audioUrl: "/relative/path.mp3" },
      { status: "pending", audioUrl: "http://cdn.example.com/a.mp3" },
      null,
      "text",
    ];
    for (const body of unknowns) {
      const r = parseSpeechStatus(body, "audio");
      assert.equal(r.state, "unrecognized", JSON.stringify(body));
      assert.ok(!/https?:|s3cret|relative|cdn/.test(JSON.stringify((r as { shape: unknown }).shape)), "only field names and types");
    }
    assert.deepEqual((parseSpeechStatus({ state: "ok", media: { link: url } }, "audio") as { shape: unknown }).shape, { media: { link: "string" }, state: "string" });
  });

  it("reads the job id from the documented response or a wrapper, and reports an unknown one only as structure", () => {
    assert.deepEqual(parseSpeechStart({ generationId: "g1" }), { generationId: "g1", reused: false });
    assert.deepEqual(parseSpeechStart({ generation: { id: "g2" }, reused: true }), { generationId: "g2", reused: true });
    assert.deepEqual(parseSpeechStart({ data: { jobId: "g3", reused: true } }), { generationId: "g3", reused: true });
    assert.deepEqual(parseSpeechStart({ ok: true, link: "https://x" }), { unrecognized: { link: "string", ok: "boolean" } });
  });

  it("records every speech job id in the ledger before the first status check", async () => {
    const x = deps();
    const r = await generateIdentities(x.d);
    assert.equal(r.failed, null);
    x.masky.calls.forEach((c, i) => c === "speak" && assert.deepEqual(x.masky.calls.slice(i + 1, i + 3), ["ledger", "status"], "ledger right after speak, before status"));
    const jobs = x.ledger.events.filter((e) => e.event === "speech-requested");
    assert.equal(jobs.length, 5);
    assert.deepEqual(Object.keys(speechByRole(x.ledger.events)).sort(), [...AGENT_ROLES].sort());
  });

  it("fails closed on an unrecognized status, recording only its redacted structure", async () => {
    const x = deps();
    x.masky.statusOverride = { state: "unrecognized", shape: { result: { payload: "string" } } };
    const r = await generateIdentities(x.d);
    assert.deepEqual([r.failed?.role, r.failed?.stage, r.completed.length], ["content-curator", "speech", 0]);
    const diag = x.ledger.events.find((e) => e.event === "speech-status-unrecognized");
    assert.ok(diag && diag.event === "speech-status-unrecognized" && JSON.stringify(diag.shape) === '{"result":{"payload":"string"}}');
    assert.ok(!x.masky.calls.includes("download") && x.downloads.length === 0, "nothing downloaded");
    assert.equal(x.masky.speech.length, 1, "one speech request only");
  });

  it("recovers after a status-parser failure by polling the recorded job, never requesting (or paying for) speech again", async () => {
    const first = deps();
    first.masky.statusOverride = { state: "unrecognized", shape: { x: "string" } };
    await generateIdentities(first.d);
    const job = speechByRole(first.ledger.events)["content-curator"]!;
    const avatarId = job.maskyAvatarId;
    const again = deps();
    again.masky.idOffset = 10;
    const r = await generateIdentities(again.d, {
      reuse: { "content-curator": { maskyAvatarId: avatarId, voiceId: "v-warm" } },
      reuseSpeech: { "content-curator": { maskyAvatarId: job.maskyAvatarId, maskyGenerationId: job.maskyGenerationId, output: job.output, textSha256: job.textSha256, reused: job.reused } },
    });
    assert.equal(r.failed, null, JSON.stringify(r.failed));
    assert.equal(again.masky.speech.length, 4, "no second speech request for the Content Curator");
    assert.equal(r.manifest.entries["content-curator"]!.spoken.maskyGenerationId, job.maskyGenerationId);
    assert.ok(!again.ledger.events.some((e) => e.event === "speech-requested" && e.role === "content-curator"));
    // A recorded job for different text (or another avatar) is not reused.
    const changed = deps();
    await generateIdentities(changed.d, { reuseSpeech: { "content-curator": { ...job, maskyAvatarId: "av-1", textSha256: "0".repeat(64) } } });
    assert.equal(changed.masky.speech[0]?.text, AGENT_IDENTITIES["content-curator"].spokenLine, "a mismatched job triggers a fresh request");
  });

  it("validates speech and diagnostic ledger events: identifiers and type names only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nf-ledger-"));
    try {
      const ledger = new FileAvatarLedger(join(dir, "l.jsonl"));
      const speech: LedgerEvent = { event: "speech-requested", role: "content-curator", maskyAvatarId: "VDzafw3fD73I9SNZC6SY", maskyGenerationId: "gen_1", output: "audio", textSha256: "a".repeat(64), reused: true, source: "POST /avatars/{id}/speak", at: "2026-10-17T00:00:00.000Z" };
      await ledger.append(speech);
      await ledger.append({ event: "speech-status-unrecognized", role: "content-curator", maskyGenerationId: "gen_1", shape: { result: { payload: "string" }, items: [{ n: "number" }] }, at: "2026-10-17T00:00:01.000Z" });
      assert.equal(ledger.read().length, 2);
      assert.ok(avatarsByRole(ledger.read()).ok, "speech events are not avatars");
      await assert.rejects(ledger.append({ event: "speech-status-unrecognized", role: "content-curator", maskyGenerationId: "gen_1", shape: { audioUrl: "https://cdn/x" }, at: "2026-10-17T00:00:02.000Z" }), /field names and value types/);
      await assert.rejects(ledger.append({ event: "speech-status-unrecognized", role: "content-curator", maskyGenerationId: "gen_1", shape: { status: "ready" }, at: "2026-10-17T00:00:02.000Z" }), /field names and value types/);
      await assert.rejects(ledger.append({ ...speech, maskyGenerationId: "" }), /speech job id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoses one role's speech with exactly one identical request and one status request, recording the job first", async () => {
    const x = deps();
    const d = await diagnoseSpeech({ masky: x.masky, ledger: x.ledger }, { role: "content-curator", maskyAvatarId: "VDzafw3fD73I9SNZC6SY" });
    assert.deepEqual(x.masky.calls, ["speak", "ledger", "status"], "no avatar, no download, no retry");
    assert.deepEqual(x.masky.speech, [{ text: AGENT_IDENTITIES["content-curator"].spokenLine, output: "audio" }], "the exact committed line and output");
    assert.deepEqual(d.result, { state: "pending", status: "pending" }, "normalized status, no media URL");
    assert.equal(x.downloads.length, 0);
    const done = deps();
    done.masky.pendingPolls = 0;
    const r = await diagnoseSpeech({ masky: done.masky, ledger: done.ledger }, { role: "content-curator", maskyAvatarId: "VDzafw3fD73I9SNZC6SY" });
    assert.ok(r.result.state === "done" && !JSON.stringify(r).includes("https"), "a finished job is reported without its URL");
    const odd = deps();
    odd.masky.statusOverride = { state: "unrecognized", shape: { payload: { link: "string" } } };
    const u = await diagnoseSpeech({ masky: odd.masky, ledger: odd.ledger }, { role: "content-curator", maskyAvatarId: "VDzafw3fD73I9SNZC6SY" });
    assert.deepEqual(u.result, { state: "unrecognized", shape: { payload: { link: "string" } } });
    assert.deepEqual(odd.ledger.events.map((e) => e.event), ["speech-requested", "speech-status-unrecognized"]);
    assert.deepEqual(odd.masky.calls, ["speak", "ledger", "status", "ledger"]);
  });
});

describe("private storage readiness for Masky media", () => {
  const ready = { id: "nf-media", name: "nf-media", public: false, allowed_mime_types: ["video/mp4", "image/png", "image/jpeg", "audio/mpeg", "audio/mp4", "audio/wav"], file_size_limit: null };

  it("accepts the private nf-media bucket only when it explicitly allows every required type", () => {
    assert.deepEqual(checkMediaBucket(ready), []);
    assert.deepEqual(checkMediaBucket({ ...ready, allowed_mime_types: [...ready.allowed_mime_types, "text/plain"] }), [], "extra types do not block readiness");
    const missing = checkMediaBucket({ ...ready, allowed_mime_types: ["video/mp4", "image/png", "image/jpeg"] });
    assert.ok(missing.some((e) => /does not allow: audio\/mpeg, audio\/mp4, audio\/wav/.test(e)), "missing audio types");
    assert.ok(checkMediaBucket({ ...ready, id: "other", name: "other" }).some((e) => /not nf-media/.test(e)), "wrong bucket");
    assert.ok(checkMediaBucket({ ...ready, public: true }).some((e) => /must be private/.test(e)), "public bucket");
    assert.ok(checkMediaBucket({ ...ready, allowed_mime_types: null }).some((e) => /no explicit list/.test(e)), "unrestricted is not explicit");
    assert.ok(checkMediaBucket("not json").length > 0, "malformed");
    assert.deepEqual(REQUIRED_MEDIA_TYPES, ready.allowed_mime_types);
  });

  it("treats a failed configuration read as not ready", async () => {
    assert.deepEqual(await mediaBucketReadiness({ bucketConfig: async () => ready }), []);
    const thrown = await mediaBucketReadiness({ bucketConfig: async () => Promise.reject(new Error("HTTP 500")) });
    assert.ok(thrown.length === 1 && /could not be read/.test(thrown[0]));
    const fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const store = new SupabasePrivateStorage("https://project.supabase.co", "sb_secret_TEST0000notarealkey0000", fetchImpl);
    assert.ok((await mediaBucketReadiness(store)).some((e) => /HTTP 500/.test(e)));
    const okFetch = (async (url: string) => (assert.equal(url, "https://project.supabase.co/storage/v1/bucket/nf-media"), new Response(JSON.stringify(ready), { status: 200 }))) as unknown as typeof fetch;
    assert.deepEqual(await mediaBucketReadiness(new SupabasePrivateStorage("https://project.supabase.co", "sb_secret_TEST0000notarealkey0000", okFetch)), []);
    await assert.rejects(store.bucketConfig("../x"), /Invalid bucket/);
  });

  it("stops a run before any Masky call when storage is not ready", async () => {
    const x = deps({ checkStorage: async () => ["The nf-media bucket does not allow: audio/mpeg."] });
    const r = await generateIdentities(x.d);
    assert.deepEqual([r.failed?.stage, r.completed.length], ["storage", 0]);
    assert.deepEqual(x.masky.calls, [], "no Masky request at all");
    assert.deepEqual([...x.storage.objects.keys()], [], "nothing stored");
    const ok = deps({ checkStorage: async () => [] });
    assert.equal((await generateIdentities(ok.d)).failed, null);
  });

  it("stores audio only under a type the bucket accepts", async () => {
    const alias = deps({ download: async () => ({ bytes: new Uint8Array([1, 2]), contentType: "audio/mp3; charset=binary" }) });
    alias.masky.speech.length = 0;
    const r = await generateIdentities({ ...alias.d, probe: async () => ({ durationSeconds: 5, hasAudio: true, hasVideo: false, width: null, height: null }) });
    assert.equal(r.manifest.entries["content-curator"]?.spoken.mimeType, "audio/mpeg", "audio/mp3 is stored as audio/mpeg");
    const ogg = deps({ download: async () => ({ bytes: new Uint8Array([1, 2]), contentType: "audio/ogg" }) });
    assert.equal((await generateIdentities(ogg.d)).failed?.stage, "download", "a type the bucket refuses is never uploaded");
  });

  it("keeps the bucket migration narrow and idempotent", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261017100000_nf_media_allowed_mime_types.sql"), "utf8");
    const list = "array['video/mp4', 'image/png', 'image/jpeg', 'audio/mpeg', 'audio/mp4', 'audio/wav']::text[]";
    assert.equal(sql.split(list).length - 1, 2, "sets, and compares against, exactly the required list");
    assert.match(sql, /where id = 'nf-media'\s+and public = false\s+and allowed_mime_types is distinct from/);
    assert.match(sql, /raise exception 'bucket nf-media must remain private'/);
    assert.match(sql, /raise exception 'bucket nf-media does not exist'/);
    const setClause = /\bset\b([\s\S]*?)\bwhere\b/i.exec(sql)?.[1] ?? "";
    assert.ok(/allowed_mime_types\s*=/.test(setClause) && !/\bpublic\b|file_size_limit|\bname\b/.test(setClause), "only allowed_mime_types is assigned");
    for (const forbidden of [/\binsert\b/i, /\bdelete\b/i, /\bdrop\b/i, /\bpolicy\b/i, /file_size_limit\s*=/i, /storage\.objects/i]) {
      assert.ok(!forbidden.test(sql), `the migration never matches ${forbidden}`);
    }
  });
});
