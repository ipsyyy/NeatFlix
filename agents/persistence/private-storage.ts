import { PRIVATE_STORAGE_REF } from "@/agents/handoff/source-frames";
import { SECRET_KEY_FORMAT, SUPABASE_SECRET_KEY_ENV, SUPABASE_URL_ENV } from "./supabase-store";

/**
 * Server-only private object storage for media. Objects are addressed only by
 * private storage:// references. Uploads never overwrite, and no public URL is
 * ever created. The single exception to "no signed URL" is
 * createPortraitHandoffUrl: a 5-minute read URL for an agent portrait
 * NativeFrame rendered itself, so Masky can fetch it once when an avatar is
 * created. That URL is never logged or stored. Never import from app/,
 * components/, or lib/.
 */
export interface PrivateStorage {
  /** The object's bytes, or null when no object exists at the reference. */
  download(storageRef: string): Promise<Uint8Array | null>;
  /** Uploads with overwrite disabled: "exists" when an object is already there (nothing is changed). */
  uploadNew(storageRef: string, bytes: Uint8Array, mimeType: string): Promise<"created" | "exists">;
}

/** The only objects a short-lived handoff URL may be created for, and its lifetime. */
export const PORTRAIT_HANDOFF_PREFIX = "storage://nf-media/agents/portraits/";
export const PORTRAIT_HANDOFF_TTL_SECONDS = 300;
export const isPortraitHandoffRef = (ref: string) => ref.startsWith(PORTRAIT_HANDOFF_PREFIX) && /^[a-z0-9-]+\.png$/.test(ref.slice(PORTRAIT_HANDOFF_PREFIX.length));

/** Storage that can also hand one agent portrait to a provider for a few minutes. */
export interface PortraitHandoffStorage extends PrivateStorage {
  createPortraitHandoffUrl(storageRef: string): Promise<string>;
}

/** Splits storage://<bucket>/<path> after validating it as a private reference. */
export function parseStorageRef(storageRef: string): { bucket: string; path: string } {
  if (!PRIVATE_STORAGE_REF.test(storageRef)) throw new Error("Not a private storage:// reference.");
  const rest = storageRef.slice("storage://".length);
  const slash = rest.indexOf("/");
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/** Supabase Storage through its REST API with the server-only secret key (apikey header only). */
export class SupabasePrivateStorage implements PortraitHandoffStorage {
  private readonly base: string;

  constructor(
    url: string,
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error(`${SUPABASE_URL_ENV} must be an https URL.`);
    if (!SECRET_KEY_FORMAT.test(secretKey)) throw new Error(`${SUPABASE_SECRET_KEY_ENV} must be a Supabase secret key (sb_secret_...).`);
    this.base = `${parsed.origin}/storage/v1`;
  }

  private objectUrl(kind: "authenticated" | "upload", storageRef: string): string {
    const { bucket, path } = parseStorageRef(storageRef);
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return kind === "authenticated" ? `${this.base}/object/authenticated/${bucket}/${encoded}` : `${this.base}/object/${bucket}/${encoded}`;
  }

  async download(storageRef: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(this.objectUrl("authenticated", storageRef), { headers: { apikey: this.secretKey } });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    const body = (await res.json().catch(() => ({}))) as { statusCode?: unknown; error?: unknown };
    if (res.status === 404 || String(body.statusCode) === "404" || /not.?found/i.test(String(body.error ?? ""))) return null;
    throw new Error(`Private storage download failed with HTTP ${res.status}.`);
  }

  /** A bucket's configuration (read-only): whether it is public and which MIME types it accepts. */
  async bucketConfig(bucket: string): Promise<unknown> {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) throw new Error("Invalid bucket name.");
    const res = await this.fetchImpl(`${this.base}/bucket/${bucket}`, { headers: { apikey: this.secretKey } });
    if (!res.ok) throw new Error(`Bucket configuration read failed with HTTP ${res.status}.`);
    return res.json();
  }

  /** A 5-minute signed read URL, only for an agent portrait (see the module comment). Never log or store it. */
  async createPortraitHandoffUrl(storageRef: string): Promise<string> {
    if (!isPortraitHandoffRef(storageRef)) throw new Error("Only an agent portrait may be handed off.");
    const { bucket, path } = parseStorageRef(storageRef);
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchImpl(`${this.base}/object/sign/${bucket}/${encoded}`, {
      method: "POST",
      headers: { apikey: this.secretKey, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: PORTRAIT_HANDOFF_TTL_SECONDS }),
    });
    const body = (await res.json().catch(() => ({}))) as { signedURL?: unknown };
    if (!res.ok || typeof body.signedURL !== "string" || !body.signedURL.startsWith("/")) throw new Error(`Portrait handoff URL failed with HTTP ${res.status}.`);
    return `${this.base}${body.signedURL}`;
  }

  async uploadNew(storageRef: string, bytes: Uint8Array, mimeType: string): Promise<"created" | "exists"> {
    const res = await this.fetchImpl(this.objectUrl("upload", storageRef), {
      method: "POST",
      headers: { apikey: this.secretKey, "Content-Type": mimeType, "x-upsert": "false", "cache-control": "no-cache" },
      body: new Blob([new Uint8Array(bytes)], { type: mimeType }),
    });
    if (res.ok) {
      await res.body?.cancel();
      return "created";
    }
    const body = (await res.json().catch(() => ({}))) as { statusCode?: unknown; error?: unknown };
    if (res.status === 409 || String(body.statusCode) === "409" || /duplicate|already exists/i.test(String(body.error ?? ""))) return "exists";
    throw new Error(`Private storage upload failed with HTTP ${res.status}.`);
  }
}

/** The production private storage from server env, or null when Supabase is not configured. */
export function createPrivateStorageFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): SupabasePrivateStorage | null {
  const url = env[SUPABASE_URL_ENV]?.trim();
  const key = env[SUPABASE_SECRET_KEY_ENV]?.trim();
  if (!url || !key) return null;
  return new SupabasePrivateStorage(url, key, fetchImpl);
}
