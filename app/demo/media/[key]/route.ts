import { loadDemoMedia } from "../../load-snapshot";

/**
 * Serves one verified demo media file by key. The bytes are re-checked
 * against the snapshot checksum on every request; anything else is a 404.
 * No storage path or provider URL is ever exposed.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const found = await loadDemoMedia(key);
  if (!found) return new Response("Not available", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  return new Response(Buffer.from(found.bytes), {
    headers: {
      "Content-Type": found.media.mimeType,
      "Content-Length": String(found.bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
