import { open } from "node:fs/promises";
import { join } from "node:path";
import { cache } from "react";
import { selectPrimaryVideo } from "@/lib/demo/snapshot";
import {
  PLACEMENT_RESULT_MEDIA_KEY,
  SOURCE_VIDEO_DIR,
  TITLE_SOURCE_VIDEOS,
  type CaseEvidence,
  type SourceVideoCheck,
  type TitleMedia,
} from "@/lib/catalogue/title-media";
import { loadDemoMedia, loadDemoSnapshot } from "./demo/load-snapshot";

/** Brands browsers play as MP4 (H.264/AAC in an ISO base media file). */
const PLAYABLE_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "]);

/**
 * Checks a source clip's top-level MP4 boxes without reading its media data:
 * ftyp first with a playable brand, moov and mdat present, and box sizes that
 * account for every byte. A missing, empty, truncated, or non-MP4 file fails.
 */
export async function checkSourceVideo(path: string, file: string): Promise<SourceVideoCheck> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { ok: false, file, reason: "The source video file is missing." };
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { ok: false, file, reason: "The source video file is empty." };
    const header = Buffer.alloc(16);
    const types: string[] = [];
    let offset = 0;
    while (offset < size) {
      if (size - offset < 8) return { ok: false, file, reason: "The source video has trailing bytes after its last box." };
      await handle.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) return { ok: false, file, reason: "The source video is not an MP4 file." };
      if (types.length === 0) {
        if (type !== "ftyp") return { ok: false, file, reason: "The source video is not an MP4 file." };
        await handle.read(header, 0, 4, offset + 8);
        if (!PLAYABLE_BRANDS.has(header.toString("latin1", 0, 4))) return { ok: false, file, reason: "The source video's MP4 brand is not browser playable." };
      }
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      if (boxSize < 8 || offset + boxSize > size) return { ok: false, file, reason: "The source video is truncated." };
      types.push(type);
      offset += boxSize;
    }
    if (!types.includes("moov") || !types.includes("mdat")) return { ok: false, file, reason: "The source video has no playable media." };
    return { ok: true, file, bytes: size };
  } catch {
    return { ok: false, file, reason: "The source video could not be read." };
  } finally {
    await handle.close();
  }
}

/** The recorded case and its approved result, from the verified demo snapshot only. */
async function loadCaseEvidence(): Promise<CaseEvidence> {
  const loaded = await loadDemoSnapshot();
  if (!loaded.ok) return { loaded: false, reason: loaded.reason };
  const s = loaded.snapshot;
  const full = s.fullScene;
  // Show the result only if the snapshot selects it and its bytes still match the checksum now,
  // so the player is never pointed at a route that would 404.
  const playable = selectPrimaryVideo(s).mediaKey === PLACEMENT_RESULT_MEDIA_KEY && full != null && (await loadDemoMedia(PLACEMENT_RESULT_MEDIA_KEY)) !== null;
  return {
    loaded: true,
    recordedCase: {
      caseId: s.case.caseId,
      status: s.case.status,
      titleId: s.case.titleId,
      sceneName: s.case.sceneName,
      product: s.case.product,
      result: playable ? { label: full.label, decision: full.decision, limitations: full.limitations, disclosure: full.disclosure } : null,
    },
  };
}

/** Per-request title media evidence; shared by every reader in one render. */
export const loadTitleMedia = cache(async (): Promise<TitleMedia> => {
  const dir = join(process.cwd(), "public", SOURCE_VIDEO_DIR);
  const entries = Object.entries(TITLE_SOURCE_VIDEOS);
  const [checks, cases] = await Promise.all([
    Promise.all(entries.map(([, file]) => checkSourceVideo(join(dir, file), file))),
    loadCaseEvidence(),
  ]);
  return { sourceVideos: Object.fromEntries(entries.map(([id], i) => [id, checks[i]])), cases };
});
