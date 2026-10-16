import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { MaskyClient, MaskyError, type MaskyApi, type MaskyVoice, type SpeakState } from "@/agents/masky/client";
import {
  EMPTY_MANIFEST,
  estimateCredits,
  FALLBACK_DISCLOSURE,
  generateIdentities,
  presentIdentity,
  resolveVoices,
  validateManifest,
  type GenerationDeps,
  type IdentityManifest,
} from "@/agents/masky/generate";
import { AGENT_IDENTITIES, portraitSvg, validateIdentities, type AgentIdentity } from "@/agents/masky/identities";
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
    return { avatarId: `av-${this.avatarInputs.length}` };
  }
  async primaryImageAssetId(avatarId: string) {
    this.calls.push("images");
    return `asset-${avatarId}`;
  }
  async startSpeech(avatarId: string, text: string, output: "audio" | "video") {
    this.calls.push("speak");
    this.speech.push({ text, output });
    return { generationId: `gen-${avatarId}`, reused: false };
  }
  async speechStatus(generationId: string): Promise<SpeakState> {
    this.calls.push("status");
    const n = (this.polls.get(generationId) ?? 0) + 1;
    this.polls.set(generationId, n);
    const role = AGENT_ROLES[Number(generationId.split("-").pop()) - 1];
    if (role === this.failSpeechFor) return { state: "failed", status: "error" };
    return n <= this.pendingPolls ? { state: "pending", status: "pending" } : { state: "done", status: "ready", mediaUrl: MEDIA_URL };
  }
}

function deps(over: Partial<GenerationDeps> = {}) {
  const masky = new FakeMasky();
  const storage = new FakeStorage();
  const downloads: string[] = [];
  let current: "audio" | "video" = "audio";
  const d: GenerationDeps = {
    masky,
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
  return { d, masky, storage, downloads };
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
      assert.ok(!/masky|MASKY_API_KEY|@\/agents/i.test(src), `${file} must not reference Masky or server agent code`);
    }
    assert.match(readFileSync("eslint.config.mjs", "utf8"), /"@\/agents\/\*"/);
    const bundle = ".next/static";
    for (const file of files(bundle).filter((f) => f.endsWith(".js"))) {
      assert.ok(!/masky\.ai|MASKY_API_KEY|mky_/.test(readFileSync(file, "utf8")), `${file} must not contain Masky code`);
    }
  });
});
