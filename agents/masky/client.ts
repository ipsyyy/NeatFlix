import { z } from "zod";

/**
 * Minimal server-only Masky HTTP client (https://masky.ai/masky-api.md) for the
 * calls NativeFrame uses: list voices, create an avatar, list its images, and
 * one-shot speech. The key travels only in the Authorization header. Responses
 * are validated; errors carry only the HTTP status and a short provider
 * message with URLs removed. Provider URLs are returned to the caller for an
 * immediate server-side download and are never logged or persisted.
 * Never import from app/, components/, lib/, or data/.
 */

export const MASKY_API_BASE = "https://masky.ai/api";
export const MASKY_API_KEY_ENV = "MASKY_API_KEY";
export const MASKY_KEY_FORMAT = /^mky_[A-Za-z0-9_-]{8,}$/;

export class MaskyError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(`Masky request failed with HTTP ${status}${detail ? `: ${detail}` : ""}.`);
    this.name = "MaskyError";
  }
}

const id = z.string().min(1).max(200);
const VoicesResponse = z.object({ voices: z.array(z.object({ id, name: z.string().max(200), source: z.string().max(60).optional() }).passthrough()) }).passthrough();
const AvatarIds = z.object({ avatarId: id, avatarOwnerUserId: id.optional() }).passthrough();
const CreateAvatarResponse = z.object({ avatar: AvatarIds.optional(), avatarId: id.optional() }).passthrough();
const ImagesResponse = z.object({ images: z.array(z.object({ url: z.string().url(), assetId: id.optional(), isPrimary: z.boolean().optional() }).passthrough()) }).passthrough();
const SpeakStart = z.object({ generationId: id.optional(), id: id.optional(), reused: z.boolean().optional() }).passthrough();
const SpeakStatus = z
  .object({ status: z.string().max(40), audioUrl: z.string().url().nullish(), videoUrl: z.string().url().nullish(), error: z.unknown().optional() })
  .passthrough();

export type MaskyVoice = { id: string; name: string; source?: string };
export type SpeakOutput = "audio" | "video";
export type SpeakState = { state: "pending"; status: string } | { state: "done"; status: string; mediaUrl: string } | { state: "failed"; status: string };

export interface MaskyApi {
  listVoices(): Promise<MaskyVoice[]>;
  createAvatar(input: { displayName: string; imageUrl: string; personalityPrompt: string; voiceId: string }): Promise<{ avatarId: string }>;
  primaryImageAssetId(avatarId: string): Promise<string | null>;
  startSpeech(avatarId: string, text: string, output: SpeakOutput): Promise<{ generationId: string; reused: boolean }>;
  speechStatus(generationId: string, output: SpeakOutput): Promise<SpeakState>;
}

const scrub = (s: string) => s.replace(/https?:\/\/\S+/g, "<url>").replace(/mky_[A-Za-z0-9_-]+/g, "<key>").slice(0, 200);

export class MaskyClient implements MaskyApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!MASKY_KEY_FORMAT.test(apiKey)) throw new Error(`${MASKY_API_KEY_ENV} must be a Masky API key (mky_...).`);
  }

  private async call<T>(schema: z.ZodType<T>, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${MASKY_API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const message = typeof (json as { error?: unknown } | null)?.error === "string" ? scrub((json as { error: string }).error) : "";
      throw new MaskyError(res.status, message);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new MaskyError(res.status, `unexpected response shape for ${method} ${path.replace(/\/[^/]{12,}/g, "/<id>")}`);
    return parsed.data;
  }

  async listVoices(): Promise<MaskyVoice[]> {
    return (await this.call(VoicesResponse, "GET", "/voices")).voices.map((v) => ({ id: v.id, name: v.name, source: v.source }));
  }

  async createAvatar(input: { displayName: string; imageUrl: string; personalityPrompt: string; voiceId: string }): Promise<{ avatarId: string }> {
    const r = await this.call(CreateAvatarResponse, "POST", "/avatars", { ...input, publiclyRenderable: false });
    const avatarId = r.avatar?.avatarId ?? r.avatarId;
    if (!avatarId) throw new MaskyError(200, "avatar response had no avatar id");
    return { avatarId };
  }

  async primaryImageAssetId(avatarId: string): Promise<string | null> {
    const r = await this.call(ImagesResponse, "GET", `/avatars/${encodeURIComponent(avatarId)}/images`);
    return (r.images.find((i) => i.isPrimary) ?? r.images[0])?.assetId ?? null;
  }

  async startSpeech(avatarId: string, text: string, output: SpeakOutput): Promise<{ generationId: string; reused: boolean }> {
    const r = await this.call(SpeakStart, "POST", `/avatars/${encodeURIComponent(avatarId)}/speak`, { text, textMode: "literal", output });
    const generationId = r.generationId ?? r.id;
    if (!generationId) throw new MaskyError(200, "speech response had no generation id");
    return { generationId, reused: r.reused === true };
  }

  async speechStatus(generationId: string, output: SpeakOutput): Promise<SpeakState> {
    const r = await this.call(SpeakStatus, "GET", `/avatars/speak/${encodeURIComponent(generationId)}`);
    if (r.status === "error" || r.status === "failed") return { state: "failed", status: r.status };
    const mediaUrl = output === "video" ? r.videoUrl : r.audioUrl;
    return mediaUrl && mediaUrl.startsWith("https://") ? { state: "done", status: r.status, mediaUrl } : { state: "pending", status: r.status };
  }
}

/** The client from server env, or null when no Masky key is configured. */
export function createMaskyClientFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): MaskyClient | null {
  const key = env[MASKY_API_KEY_ENV]?.trim();
  return key ? new MaskyClient(key, fetchImpl) : null;
}
