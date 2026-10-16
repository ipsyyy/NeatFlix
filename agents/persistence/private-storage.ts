import { PRIVATE_STORAGE_REF } from "@/agents/handoff/source-frames";
import { SECRET_KEY_FORMAT, SUPABASE_SECRET_KEY_ENV, SUPABASE_URL_ENV } from "./supabase-store";

/**
 * Server-only private object storage for media. Objects are addressed only by
 * private storage:// references. Uploads never overwrite, and no public or
 * signed URL is ever created. Never import from app/, components/, or lib/.
 */
export interface PrivateStorage {
  /** The object's bytes, or null when no object exists at the reference. */
  download(storageRef: string): Promise<Uint8Array | null>;
  /** Uploads with overwrite disabled: "exists" when an object is already there (nothing is changed). */
  uploadNew(storageRef: string, bytes: Uint8Array, mimeType: string): Promise<"created" | "exists">;
}

/** Splits storage://<bucket>/<path> after validating it as a private reference. */
export function parseStorageRef(storageRef: string): { bucket: string; path: string } {
  if (!PRIVATE_STORAGE_REF.test(storageRef)) throw new Error("Not a private storage:// reference.");
  const rest = storageRef.slice("storage://".length);
  const slash = rest.indexOf("/");
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/** Supabase Storage through its REST API with the server-only secret key (apikey header only). */
export class SupabasePrivateStorage implements PrivateStorage {
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
