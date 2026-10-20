/** Generates the complete Daybreak-branded demo clip locally. No paid provider is called. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { renderFullSceneOverlay } from "@/agents/media/full-scene-overlay";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const SOURCE_ID = "asset:luv-hypothesis:source-video:v1";
const STILL_ID = "asset:luv-hypothesis:edited-still:luv-scene-1:v3";

async function main() {
  loadLocalEnv();
  const print = (value: string) => console.log(redactSecrets(value, collectSecrets(process.env)));
  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) throw new Error("Supabase is not configured.");
  const [sourceRow, stillRow] = await Promise.all([store.getMediaAsset(SOURCE_ID), store.getMediaAsset(STILL_ID)]);
  if (!sourceRow || sourceRow.kind !== "source-video") throw new Error("The registered source video is unavailable.");
  if (!stillRow || stillRow.kind !== "edited-still") throw new Error("The approved v3 still is unavailable.");
  const [source, still] = await Promise.all([storage.download(sourceRow.storage_ref), storage.download(stillRow.storage_ref)]);
  if (!source || !still) throw new Error("The private source video or approved still could not be read.");
  const outputDir = resolve(process.cwd(), ".demo", "generated");
  const output = resolve(outputDir, "daybreak-full-scene-20s.mp4");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const result = await renderFullSceneOverlay({ sourceVideo: source, approvedStill: still, outputFile: output, expectedDurationSeconds: sourceRow.duration_seconds ?? 20.064 });
  await writeFile(resolve(outputDir, "daybreak-full-scene-20s.json"), `${JSON.stringify({ generator: "local-ffmpeg-fixed-surface-overlay", sourceAssetId: SOURCE_ID, approvedStillAssetId: STILL_ID, disclosure: "Original source motion and audio retained; two fixed cup regions composited from the human-approved v3 still.", ...result }, null, 2)}\n`, { mode: 0o600 });
  print(`Created ${output}`);
  print(`Verified: ${result.durationSeconds.toFixed(3)} s, ${result.width}×${result.height}, ${result.videoCodec}, audio ${result.hasAudio ? "preserved" : "not present in source"}.`);
}

main().catch((error) => { console.error(`full-scene-overlay failed: ${safeErrorMessage(error, collectSecrets(process.env))}`); process.exit(1); });
