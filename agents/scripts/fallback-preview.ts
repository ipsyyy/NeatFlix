/**
 * Bounded command: one deterministic local FFmpeg fallback preview of the
 * approved LUV v3 edited still, registered under its own disclosed identity
 * (…:v3-fallback). It makes no provider or network request other than the
 * private Supabase registry and storage, and never touches the identity
 * reserved for a Reactor preview (…:v3-reactor).
 *
 * Without --generate it is a read-only preflight. With --generate equal to the
 * exact fallback asset ID it renders (twice, bit-identical), validates every
 * frame, uploads privately without overwriting, registers once, reads back,
 * and writes an inspection copy and contact sheet to --inspect-dir.
 *
 * Run (preflight): npm run media:fallback-preview
 * Run (generate):  npm run media:fallback-preview -- --generate=asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback --inspect-dir=<dir outside the repo>
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { executeFallbackPreview, filterGraph, identityProblems, localFfmpeg, MOVEMENT, windowAt, type FallbackRequest } from "@/agents/media/fallback-preview";
import { verifyMotionInputs } from "@/agents/media/motion-preview";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const FALLBACK: Readonly<FallbackRequest> = Object.freeze({
  planId: "plan:daybreak-cold-brew:luv-scene-1:v3",
  editedStillAssetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v3",
  editedStillStorageRef: "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/edited-still-v3.png",
  editedStillChecksum: "sha256:be7a04de0a59446f6a2c47ae5b29d6c3af04a29be1f7d471eb3e12d38e8ab73f",
  visualReviewId: "fd0b60da-42e2-4995-a4da-71cc2b6bbe43",
  motionPromptSha256: "61c714d43c30ad2778be05fda96b893af0557d7bb09a25c334ac64e91020e12b",
  outputAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback",
  outputStorageRef: "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/generated-preview-v3-fallback.mp4",
  reservedReactorAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-reactor",
  reservedReactorStorageRef: "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/generated-preview-v3-reactor.mp4",
});

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const req = FALLBACK;
  const idErrors = identityProblems(req);
  if (idErrors.length > 0) return (out(`${idErrors.join(" ")} Nothing was done.`), 1);
  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);

  const inputs = await verifyMotionInputs(req, { workflow, store, storage });
  if (!inputs.ok) return (out(`Preflight failed at ${inputs.stage}: ${inputs.errors.slice(0, 3).join("; ")}. Nothing was done.`), 1);
  out(`Plan ${req.planId} (case ${inputs.caseId}) revalidated; motion prompt sha256 ${req.motionPromptSha256}`);
  out(`Source ${req.editedStillAssetId} ${req.editedStillChecksum}: record, binding, and private bytes verified; review ${inputs.review.review_id} ${inputs.review.decision}`);
  out(`FFmpeg: ${await localFfmpeg.version()}`);
  out(`Movement: ${MOVEMENT.frames} frames at ${MOVEMENT.fps} fps; final window ${JSON.stringify(windowAt(MOVEMENT.frames - 1))}`);
  out(`Filter graph: ${filterGraph()}`);
  const fallbackRow = await store.getMediaAsset(req.outputAssetId);
  const reactorRow = await store.getMediaAsset(req.reservedReactorAssetId);
  const reactorObject = await storage.download(req.reservedReactorStorageRef);
  out(`Fallback ${req.outputAssetId}: ${fallbackRow ? "registered (a run would revalidate and reuse it)" : "not registered"}`);
  out(`Reserved Reactor identity ${req.reservedReactorAssetId}: ${reactorRow || reactorObject ? "IN USE" : "unused"} (never touched here)`);

  if (arg("generate") !== req.outputAssetId) {
    out(`Preflight only: nothing rendered, uploaded, or registered. To generate, pass --generate=${req.outputAssetId} --inspect-dir=<dir outside the repo>.`);
    return 0;
  }
  const inspect = arg("inspect-dir");
  if (!inspect || resolve(inspect).startsWith(resolve(process.cwd()) + sep) || resolve(inspect) === resolve(process.cwd())) return (out("--inspect-dir must name a directory outside the repository. Nothing was done."), 1);
  await mkdir(inspect, { recursive: true, mode: 0o700 });
  const result = await executeFallbackPreview(req, { workflow, store, storage, keepDir: inspect });
  if (!result.ok) return (out(`STOPPED at ${result.stage}: ${result.errors.slice(0, 5).join("; ")}. Nothing further was done.`), 1);
  out(`${result.status === "created" ? "Created" : "Reused"} ${result.assetId}: ${result.checksum}`);
  out(`Video: ${result.video.durationSeconds} s, ${result.video.width}×${result.video.height}, ${result.video.codec} ${result.video.profile}, ${result.video.pixelFormat}, ${result.video.frameRate} fps CFR, ${result.video.frameCount} frames, no audio, fast-start`);
  out(`Checks: ${JSON.stringify(result.provenance.checks)}`);
  if (result.localCopy) {
    const sheet = resolve(inspect, "generated-preview-v3-fallback-contact-sheet.png");
    await new Promise<void>((ok, fail) =>
      execFile("ffmpeg", ["-v", "error", "-nostdin", "-n", "-i", result.localCopy!, "-vf", `select='eq(n\\,0)+eq(n\\,${(MOVEMENT.frames - 1) >> 1})+eq(n\\,${MOVEMENT.frames - 1})',scale=640:360,tile=3x1`, "-frames:v", "1", sheet], (e) => (e ? fail(e) : ok())),
    );
    out(`Inspection copy: ${result.localCopy}`);
    out(`Contact sheet (first, middle, final): ${sheet}`);
  }
  out("Human visual review: pending. Release status: not reviewed and not approved.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`fallback-preview failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
