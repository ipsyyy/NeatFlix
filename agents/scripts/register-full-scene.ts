/**
 * Bounded command: registers the one human-accepted Runway Aleph full-scene
 * edit (.demo/runway/daybreak-aleph-attempt-1.mp4) as the immutable asset
 * asset:luv-hypothesis:full-scene-video:luv-scene-1:v4-runway. It calls no
 * provider: the local bytes, the attempt ledger, and the registry must agree
 * with the pinned attempt (agents/media/runway-full-scene.ts) first.
 *
 * Without --register it is a read-only preflight. With --register equal to the
 * exact asset ID it uploads privately without overwriting, registers once, and
 * reads back. The human visual review is recorded separately and append-only
 * with npm run media:visual-review.
 *
 * Run (preflight): npm run media:register-full-scene
 * Run (register):  npm run media:register-full-scene -- --register=asset:luv-hypothesis:full-scene-video:luv-scene-1:v4-runway
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { sha256Hex } from "@/agents/media/edited-still";
import { ffprobeVideo } from "@/agents/media/mp4-validate";
import { identityProblems, LUV_V4_RUNWAY, ledgerProblems, registerFullScene } from "@/agents/media/runway-full-scene";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const RUN_DIR = resolve(process.cwd(), ".demo", "runway");
const OUTPUT = resolve(RUN_DIR, "daybreak-aleph-attempt-1.mp4");
const LEDGER = resolve(RUN_DIR, "attempt.json");

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const req = LUV_V4_RUNWAY;
  const idErrors = identityProblems(req);
  if (idErrors.length > 0) return (out(`${idErrors.join(" ")} Nothing was done.`), 1);

  const ledger = JSON.parse(await readFile(LEDGER, "utf8")) as unknown;
  const ledgerErrors = ledgerProblems(ledger, req);
  if (ledgerErrors.length > 0) return (out(`${ledgerErrors.join(" ")} Nothing was done.`), 1);
  const bytes = new Uint8Array(await readFile(OUTPUT));
  const checksum = `sha256:${sha256Hex(bytes)}`;
  out(`Local output ${OUTPUT}: ${checksum} (${checksum === req.outputChecksum ? "matches" : "DOES NOT match"} the accepted output)`);
  if (checksum !== req.outputChecksum) return (out("Nothing was done."), 1);
  const probe = await ffprobeVideo(bytes);
  out(`Probe: ${probe.durationSeconds} s; video ${JSON.stringify(probe.video)}; audio ${JSON.stringify(probe.audio)}`);
  out(`Runway task ${req.taskId}, model ${req.model}, ${req.chargedCredits} credits charged; no provider is called here.`);

  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) return (out("Supabase is not configured. Nothing was done."), 1);
  const migrated = await store.reviewLimitationsAvailable();
  out(`Full-scene migration (20261019000000_full_scene_video_and_review_limitations.sql): ${migrated ? "applied" : "NOT applied"}`);
  const existing = await store.getMediaAsset(req.outputAssetId);
  out(`${req.outputAssetId}: ${existing ? "registered (a run would revalidate and reuse it)" : "not registered"}`);

  const register = process.argv.find((a) => a.startsWith("--register="))?.slice("--register=".length);
  if (register !== req.outputAssetId) {
    out(`Preflight only: nothing uploaded or registered. To register, pass --register=${req.outputAssetId}.`);
    return 0;
  }
  if (!migrated) return (out("Apply the migration before registering. Nothing was done."), 1);
  const result = await registerFullScene(
    { workflow: new WorkflowRegistry(store), store, storage },
    { bytes, probe, ledger, generatedAt: (await stat(OUTPUT)).mtime },
    req,
  );
  if (!result.ok) return (out(`STOPPED at ${result.stage}: ${result.errors.slice(0, 5).join("; ")}. Nothing further was done.`), 1);
  const v = result.video;
  out(`${result.status === "created" ? "Registered" : "Reused"} ${result.row.asset_id}: ${result.row.checksum}`);
  out(`Video: ${v.durationSeconds} s (source ${v.sourceDurationSeconds} s, Δ ${v.durationDeltaSeconds} s), ${v.width}×${v.height} ${v.codec} ${v.frameRate} fps, ${v.frameCount} frames, audio ${v.audio.codec} ${v.audio.sampleRate} Hz ${v.audio.channels} ch, ${v.bytes} bytes`);
  out(`Cost: $${Number(result.row.cost_usd).toFixed(2)} (${req.chargedCredits} credits). Human visual review: pending until recorded with npm run media:visual-review.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`register-full-scene failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
