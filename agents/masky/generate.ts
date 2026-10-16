import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import type { PortraitHandoffStorage } from "@/agents/persistence/private-storage";
import type { MaskyApi, MaskyVoice, SpeakOutput } from "./client";
import { AGENT_IDENTITIES, estimateSpeechSeconds, identitySpecSha256, portraitSvg, validateIdentities, type AgentIdentity } from "./identities";

/**
 * One bounded Masky run for the five agent identities, and the deterministic
 * local fallback the demo uses whenever a Masky identity is missing or invalid.
 *
 * Per role, in order, stopping at the first failure: render the portrait
 * locally and store it privately; hand Masky a 5-minute read URL for it and
 * create a non-publicly-renderable avatar with the chosen voice and
 * personality; request the one spoken line verbatim; download the result
 * server-side, validate it, and store it privately. Only Masky identifiers
 * and safe metadata are recorded: never a key, token, or provider URL.
 */

export const IDENTITY_MANIFEST_VERSION = 1;
export const AGENT_MEDIA_PREFIX = "storage://nf-media/agents/";
/** Masky's published rates (credits; 1 credit = $1): one-shot speech audio and talking-head video, per second of speech. */
export const MASKY_RATES = Object.freeze({ audioPerSecond: 0.0015, videoPerSecond: 0.0265 });
export const MAX_SPOKEN_BYTES = 25 * 1024 * 1024;
const SPOKEN_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
});

export type IdentityManifestEntry = {
  role: AgentRole;
  characterName: string;
  specSha256: string;
  voice: { id: string; name: string };
  avatar: { maskyAvatarId: string; maskyPrimaryImageAssetId: string | null; publiclyRenderable: false };
  portrait: { storageRef: string; checksum: string; mimeType: "image/png"; width: 1024; height: 1024 };
  spoken: { output: SpeakOutput; text: string; maskyGenerationId: string; reused: boolean; storageRef: string; checksum: string; mimeType: string; durationSeconds: number };
  provenance: { provider: "masky"; api: "masky.ai/api"; createdAt: string; estimatedCredits: number };
};
export type IdentityManifest = { version: typeof IDENTITY_MANIFEST_VERSION; entries: Partial<Record<AgentRole, IdentityManifestEntry>> };
export const EMPTY_MANIFEST: IdentityManifest = Object.freeze({ version: IDENTITY_MANIFEST_VERSION, entries: {} });

const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const UNSAFE = /https?:|www\.|mky_|sb_secret_|sk-ant-|token=|key=|signedurl|\/object\/sign\//i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MASKY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Estimated credits for one identity's spoken result, from Masky's published per-second rates. */
export function estimateCredits(identity: AgentIdentity): number {
  const rate = identity.spokenOutput === "video" ? MASKY_RATES.videoPerSecond : MASKY_RATES.audioPerSecond;
  return Math.round(estimateSpeechSeconds(identity.spokenLine) * rate * 10_000) / 10_000;
}

/**
 * Chooses five distinct voices: an override when given, otherwise the first
 * preset whose name matches a role's hints (in hint order), otherwise the next
 * unused preset by id. Fails closed if five distinct voices are not available.
 */
export function resolveVoices(voices: readonly MaskyVoice[], overrides: Partial<Record<AgentRole, string>> = {}): { ok: true; value: Record<AgentRole, MaskyVoice> } | { ok: false; errors: string[] } {
  const byId = new Map(voices.map((v) => [v.id, v] as const));
  const presets = [...voices].filter((v) => !v.source || v.source === "preset").sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set<string>();
  const chosen: Partial<Record<AgentRole, MaskyVoice>> = {};
  const errors: string[] = [];
  for (const role of AGENT_ROLES) {
    const override = overrides[role];
    if (override) {
      const v = byId.get(override);
      if (!v) errors.push(`${role}: voice ${override} is not in Masky's voice list.`);
      else if (used.has(v.id)) errors.push(`${role}: voice ${override} is already used.`);
      else {
        chosen[role] = v;
        used.add(v.id);
      }
    }
  }
  for (const role of AGENT_ROLES) {
    if (chosen[role] || overrides[role]) continue;
    const hinted = AGENT_IDENTITIES[role].voiceHints.map((h) => presets.find((v) => !used.has(v.id) && v.name.toLowerCase().includes(h.toLowerCase()))).find(Boolean);
    const v = hinted ?? presets.find((p) => !used.has(p.id));
    if (!v) {
      errors.push(`${role}: no distinct voice is available.`);
      continue;
    }
    chosen[role] = v;
    used.add(v.id);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: chosen as Record<AgentRole, MaskyVoice> };
}

/** Why a manifest is not safe and consistent: only identifiers and safe metadata, tied to the current specs. */
export function validateManifest(manifest: unknown): string[] {
  if (!isObj(manifest) || manifest.version !== IDENTITY_MANIFEST_VERSION || !isObj(manifest.entries)) return ["The identity manifest is malformed."];
  const e: string[] = [];
  if (UNSAFE.test(JSON.stringify(manifest))) e.push("The identity manifest may hold only identifiers and safe metadata (no URLs, keys, or tokens).");
  for (const [role, entry] of Object.entries(manifest.entries)) e.push(...entryErrors(role, entry));
  const avatars = Object.values(manifest.entries).map((x) => (isObj(x) && isObj(x.avatar) ? x.avatar.maskyAvatarId : null));
  const voices = Object.values(manifest.entries).map((x) => (isObj(x) && isObj(x.voice) ? x.voice.id : null));
  if (new Set(avatars).size !== avatars.length || new Set(voices).size !== voices.length) e.push("Avatars and voices must be distinct across identities.");
  return e;
}

function entryErrors(role: string, entry: unknown): string[] {
  const identity = (AGENT_IDENTITIES as Record<string, AgentIdentity | undefined>)[role];
  if (!identity) return [`${role}: not an agent role.`];
  if (!isObj(entry)) return [`${role}: entry is malformed.`];
  const e: string[] = [];
  const v = isObj(entry.voice) ? entry.voice : {};
  const a = isObj(entry.avatar) ? entry.avatar : {};
  const p = isObj(entry.portrait) ? entry.portrait : {};
  const s = isObj(entry.spoken) ? entry.spoken : {};
  const prov = isObj(entry.provenance) ? entry.provenance : {};
  if (entry.role !== role || entry.characterName !== identity.characterName || entry.specSha256 !== identitySpecSha256(identity)) e.push(`${role}: entry does not match the current identity spec.`);
  if (typeof v.id !== "string" || !MASKY_ID.test(v.id) || typeof v.name !== "string") e.push(`${role}: voice is missing.`);
  if (typeof a.maskyAvatarId !== "string" || !MASKY_ID.test(a.maskyAvatarId) || a.publiclyRenderable !== false) e.push(`${role}: avatar is missing or renderable by others.`);
  if (a.maskyPrimaryImageAssetId !== null && (typeof a.maskyPrimaryImageAssetId !== "string" || !MASKY_ID.test(a.maskyPrimaryImageAssetId))) e.push(`${role}: portrait asset id is malformed.`);
  if (p.storageRef !== `${AGENT_MEDIA_PREFIX}portraits/${role}-v1.png` || typeof p.checksum !== "string" || !SHA256.test(p.checksum) || p.mimeType !== "image/png") e.push(`${role}: portrait record is invalid.`);
  const ext = SPOKEN_TYPES[String(s.mimeType)];
  if (s.output !== identity.spokenOutput || s.text !== identity.spokenLine || typeof s.maskyGenerationId !== "string" || !MASKY_ID.test(s.maskyGenerationId)) e.push(`${role}: spoken result does not match the identity.`);
  if (!ext || s.storageRef !== `${AGENT_MEDIA_PREFIX}spoken/${role}-v1.${ext}` || typeof s.checksum !== "string" || !SHA256.test(s.checksum)) e.push(`${role}: spoken media record is invalid.`);
  if ((s.output === "video") !== (s.mimeType === "video/mp4")) e.push(`${role}: spoken media type does not match its output.`);
  if (!(typeof s.durationSeconds === "number" && s.durationSeconds >= 1 && s.durationSeconds <= 30)) e.push(`${role}: spoken duration is outside 1–30 seconds.`);
  if (prov.provider !== "masky" || prov.api !== "masky.ai/api" || Number.isNaN(Date.parse(String(prov.createdAt)))) e.push(`${role}: provenance is incomplete.`);
  return e;
}

/** What the demo shows for an agent: its Masky identity when recorded and valid, otherwise the deterministic local fallback. */
export type IdentityPresentation = {
  role: AgentRole;
  characterName: string;
  title: string;
  personality: string;
  prominence: "primary" | "standard";
  caption: string;
} & (
  | { mode: "masky"; portraitStorageRef: string; spoken: { storageRef: string; mimeType: string; output: SpeakOutput; durationSeconds: number } }
  | { mode: "fallback"; portraitSvg: string; spoken: null; disclosure: string }
);

export const FALLBACK_DISCLOSURE = "Masky identity unavailable: showing NativeFrame's local portrait and the result as a caption, without voice.";

export function presentIdentity(role: AgentRole, manifest: unknown): IdentityPresentation {
  const identity = AGENT_IDENTITIES[role];
  const base = { role, characterName: identity.characterName, title: identity.title, personality: identity.personality, prominence: identity.prominence, caption: identity.spokenLine };
  const entry = isObj(manifest) && isObj(manifest.entries) ? (manifest.entries as Record<string, unknown>)[role] : undefined;
  if (entry !== undefined && validateManifest({ version: IDENTITY_MANIFEST_VERSION, entries: { [role]: entry } }).length === 0) {
    const e = entry as IdentityManifestEntry;
    return { ...base, mode: "masky", portraitStorageRef: e.portrait.storageRef, spoken: { storageRef: e.spoken.storageRef, mimeType: e.spoken.mimeType, output: e.spoken.output, durationSeconds: e.spoken.durationSeconds } };
  }
  return { ...base, mode: "fallback", portraitSvg: portraitSvg(identity), spoken: null, disclosure: FALLBACK_DISCLOSURE };
}

export type MediaProbe = { durationSeconds: number; hasAudio: boolean; hasVideo: boolean; width: number | null; height: number | null };

export type GenerationDeps = {
  masky: MaskyApi;
  storage: PortraitHandoffStorage;
  renderPng: (svg: string) => Promise<Uint8Array>;
  /** Downloads provider media server-side. The URL is never logged or stored. */
  download: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  probe: (bytes: Uint8Array) => Promise<MediaProbe>;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  log?: (line: string) => void;
};

export type GenerationResult = { manifest: IdentityManifest; completed: AgentRole[]; failed: { role: AgentRole; stage: string; error: string } | null; voices: Record<AgentRole, MaskyVoice> | null };

/** Stores bytes at a private reference, accepting only an identical existing object. */
async function storeOnce(storage: PortraitHandoffStorage, ref: string, bytes: Uint8Array, mime: string): Promise<void> {
  if ((await storage.uploadNew(ref, bytes, mime)) === "exists") {
    const existing = await storage.download(ref);
    if (!existing || sha(existing) !== sha(bytes)) throw new Error(`A different object already exists at ${ref}.`);
  }
}

export async function generateIdentities(deps: GenerationDeps, options: { existing?: IdentityManifest; voiceOverrides?: Partial<Record<AgentRole, string>> } = {}): Promise<GenerationResult> {
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const manifest: IdentityManifest = { version: IDENTITY_MANIFEST_VERSION, entries: {} };
  const result = (failed: GenerationResult["failed"], voices: GenerationResult["voices"] = null): GenerationResult => ({ manifest, completed: Object.keys(manifest.entries) as AgentRole[], failed, voices });

  const specErrors = validateIdentities();
  if (specErrors.length > 0) return result({ role: "content-curator", stage: "identities", error: specErrors.join(" ") });
  // Masky documents no avatar deletion, so a recorded identity is never recreated by this run.
  if (options.existing && Object.keys(options.existing.entries).length > 0) {
    return result({ role: Object.keys(options.existing.entries)[0] as AgentRole, stage: "existing", error: "Identities are already recorded; this run never creates a second avatar." });
  }
  let voices: Record<AgentRole, MaskyVoice>;
  try {
    const resolved = resolveVoices(await deps.masky.listVoices(), options.voiceOverrides);
    if (!resolved.ok) return result({ role: "content-curator", stage: "voices", error: resolved.errors.join(" ") });
    voices = resolved.value;
  } catch (error) {
    return result({ role: "content-curator", stage: "voices", error: error instanceof Error ? error.message : "unknown error" });
  }

  for (const role of AGENT_ROLES) {
    const identity = AGENT_IDENTITIES[role];
    let stage = "portrait";
    try {
      const png = await deps.renderPng(portraitSvg(identity));
      const portraitRef = `${AGENT_MEDIA_PREFIX}portraits/${role}-v1.png`;
      await storeOnce(deps.storage, portraitRef, png, "image/png");

      stage = "avatar";
      const handoff = await deps.storage.createPortraitHandoffUrl(portraitRef);
      const { avatarId } = await deps.masky.createAvatar({ displayName: `${identity.characterName}, NativeFrame ${identity.title}`, imageUrl: handoff, personalityPrompt: identity.personality, voiceId: voices[role].id });
      const assetId = await deps.masky.primaryImageAssetId(avatarId);
      log(`${role}: avatar ${avatarId} with voice ${voices[role].name}`);

      stage = "speech";
      const started = await deps.masky.startSpeech(avatarId, identity.spokenLine, identity.spokenOutput);
      let mediaUrl: string | null = null;
      for (let i = 0; i < (deps.maxPolls ?? 60) && !mediaUrl; i++) {
        const s = await deps.masky.speechStatus(started.generationId, identity.spokenOutput);
        if (s.state === "failed") throw new Error(`Masky speech ended with status "${s.status}".`);
        if (s.state === "done") mediaUrl = s.mediaUrl;
        else await sleep(deps.pollIntervalMs ?? 5_000);
      }
      if (!mediaUrl) throw new Error("Masky speech did not finish within the polling limit.");

      stage = "download";
      const media = await deps.download(mediaUrl);
      mediaUrl = null;
      const mime = media.contentType.split(";")[0].trim().toLowerCase();
      const ext = SPOKEN_TYPES[mime];
      if (!ext || (identity.spokenOutput === "video") !== (mime === "video/mp4")) throw new Error(`Unexpected spoken media type ${mime}.`);
      if (media.bytes.length === 0 || media.bytes.length > MAX_SPOKEN_BYTES) throw new Error("Spoken media is empty or too large.");
      const probe = await deps.probe(media.bytes);
      if (!probe.hasAudio || (identity.spokenOutput === "video" && !probe.hasVideo) || !(probe.durationSeconds >= 1 && probe.durationSeconds <= 30)) throw new Error("Spoken media failed validation (audio, video, or 1–30 s duration).");
      const spokenRef = `${AGENT_MEDIA_PREFIX}spoken/${role}-v1.${ext}`;
      await storeOnce(deps.storage, spokenRef, media.bytes, mime);

      manifest.entries[role] = {
        role,
        characterName: identity.characterName,
        specSha256: identitySpecSha256(identity),
        voice: { id: voices[role].id, name: voices[role].name },
        avatar: { maskyAvatarId: avatarId, maskyPrimaryImageAssetId: assetId, publiclyRenderable: false },
        portrait: { storageRef: portraitRef, checksum: sha(png), mimeType: "image/png", width: 1024, height: 1024 },
        spoken: { output: identity.spokenOutput, text: identity.spokenLine, maskyGenerationId: started.generationId, reused: started.reused, storageRef: spokenRef, checksum: sha(media.bytes), mimeType: mime, durationSeconds: Math.round(probe.durationSeconds * 1000) / 1000 },
        provenance: { provider: "masky", api: "masky.ai/api", createdAt: clock().toISOString(), estimatedCredits: estimateCredits(identity) },
      };
      const errors = validateManifest(manifest);
      if (errors.length > 0) {
        delete manifest.entries[role];
        throw new Error(errors.join(" "));
      }
      log(`${role}: ${identity.spokenOutput} stored privately (${manifest.entries[role]!.spoken.checksum})`);
    } catch (error) {
      return result({ role, stage, error: error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "<url>") : "unknown error" }, voices);
    }
  }
  return result(null, voices);
}

/** Server-side probe of downloaded media with local ffprobe (no network). */
export async function ffprobeMedia(bytes: Uint8Array): Promise<MediaProbe> {
  const dir = await mkdtemp(join(tmpdir(), "nf-masky-"));
  try {
    const file = join(dir, "media");
    await writeFile(file, bytes);
    const json = await new Promise<string>((ok, fail) =>
      execFile("ffprobe", ["-v", "error", "-of", "json", "-show_streams", "-show_format", file], { maxBuffer: 4 * 1024 * 1024 }, (e, out) => (e ? fail(e) : ok(out))),
    );
    const parsed = JSON.parse(json) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    return {
      durationSeconds: Number(parsed.format?.duration ?? NaN),
      hasAudio: Boolean(parsed.streams?.some((s) => s.codec_type === "audio")),
      hasVideo: Boolean(video),
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
