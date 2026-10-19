import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEMO_MEDIA_KEYS, validateDemoSnapshot, type DemoMedia, type DemoSnapshot } from "@/lib/demo/snapshot";

/**
 * Server-only access to the local, git-ignored demo snapshot (.demo/), built by
 * `npm run demo:snapshot`. NATIVEFRAME_DEMO_DIR (server-only) can point the
 * browser tests at another snapshot directory.
 */
const DIR = process.env.NATIVEFRAME_DEMO_DIR?.trim() || join(process.cwd(), ".demo");

export async function loadDemoSnapshot(): Promise<{ ok: true; snapshot: DemoSnapshot } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(join(DIR, "snapshot.json"), "utf8");
  } catch {
    return { ok: false, reason: "No demo snapshot has been prepared on this machine." };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const errors = validateDemoSnapshot(parsed);
    return errors.length === 0 ? { ok: true, snapshot: parsed as DemoSnapshot } : { ok: false, reason: "The demo snapshot failed validation." };
  } catch {
    return { ok: false, reason: "The demo snapshot is unreadable." };
  }
}

/** A snapshot media file's bytes, only when it is listed, was verified, and still matches its checksum. */
export async function loadDemoMedia(key: string): Promise<{ media: DemoMedia; bytes: Uint8Array } | null> {
  if (!(DEMO_MEDIA_KEYS as readonly string[]).includes(key)) return null;
  const loaded = await loadDemoSnapshot();
  if (!loaded.ok) return null;
  const media = loaded.snapshot.media.find((m) => m.key === key && m.verified);
  if (!media) return null;
  try {
    const bytes = new Uint8Array(await readFile(join(DIR, "media", media.file)));
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}` === media.sha256 ? { media, bytes } : null;
  } catch {
    return null;
  }
}
