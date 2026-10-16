/**
 * Bounded command: one Reactor Visko Orbis Stable motion preview of the
 * approved LUV v3 edited still, then stop. Only this plan, still, review, and
 * motion prompt are accepted.
 *
 * Without the approval flag it is a read-only preflight: it revalidates the
 * plan, the edited still's record and private bytes, its plan binding, its
 * approved visual review, and the motion prompt hash, and checks the local
 * runtime. It makes no Reactor request (not even pricing), starts no browser,
 * and writes nothing.
 *
 * With --approve-paid-call equal to the exact plan ID it makes at most one
 * Reactor session. The per-second rate is read from Reactor's public pricing
 * endpoint; when none is published, pass --rate-usd-per-second=<decimal> from
 * the Reactor Dashboard, or the command stops before any session.
 *
 * Run (preflight):  npm run media:motion-preview
 * Run (one paid session):
 *   npm run media:motion-preview -- --approve-paid-call=plan:daybreak-cold-brew:luv-scene-1:v3
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { attemptKey, executeMotionPreview, FileAttemptLedger, verifyMotionInputs, type MotionPreviewRequest, type ProviderCostRate } from "@/agents/media/motion-preview";
import { ffprobeVideo } from "@/agents/media/mp4-validate";
import { createReactorProviderFromEnv, fetchOrbisRate, MAX_SESSION_SECONDS, probePageRuntime, REACTOR_API_KEY_ENV, REACTOR_SDK } from "@/agents/media/reactor-provider";
import { CLIP_MARGIN_SECONDS, FRAME_CHUNKS, MAX_CHUNKS, ORBIS_MODEL } from "@/agents/media/reactor-session";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

/** The only accepted preview: everything pinned to the approved v3 records. */
const APPROVED_PREVIEW: Readonly<MotionPreviewRequest> = Object.freeze({
  planId: "plan:daybreak-cold-brew:luv-scene-1:v3",
  editedStillAssetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v3",
  editedStillStorageRef: "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/edited-still-v3.png",
  editedStillChecksum: "sha256:be7a04de0a59446f6a2c47ae5b29d6c3af04a29be1f7d471eb3e12d38e8ab73f",
  visualReviewId: "fd0b60da-42e2-4995-a4da-71cc2b6bbe43",
  motionPromptSha256: "61c714d43c30ad2778be05fda96b893af0557d7bb09a25c334ac64e91020e12b",
  outputAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3",
  outputStorageRef: "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/generated-preview-v3.mp4",
  seed: 42,
  resolution: "1080p",
});
const CHROME = process.env.CHROME_PATH?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LEDGER_DIR = join(homedir(), ".nativeframe", "paid-attempts");
const SESSION_TIMEOUT_MS = 240_000;

const which = (bin: string) => new Promise<boolean>((resolve) => execFile(bin, ["-version"], (error) => resolve(!error)));

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (s: string) => console.log(redactSecrets(s, secrets));
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const req = APPROVED_PREVIEW;
  const approved = arg("approve-paid-call") === req.planId;

  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) return (out("Supabase is not configured (SUPABASE_URL, SUPABASE_SECRET_KEY). Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);

  const inputs = await verifyMotionInputs(req, { workflow, store, storage });
  if (!inputs.ok) return (out(`Preflight failed at ${inputs.stage}: ${inputs.errors.slice(0, 3).join("; ")}. Nothing was done.`), 1);
  out(`Plan ${req.planId} (case ${inputs.caseId}) revalidated; motion prompt ${inputs.prompt.length} characters, sha256 ${req.motionPromptSha256}`);
  out(`Edited still ${req.editedStillAssetId} ${req.editedStillChecksum}: record, plan binding, and private bytes verified (1280×720 PNG)`);
  out(`Visual review ${inputs.review.review_id}: ${inputs.review.decision} for ${inputs.review.asset_checksum}`);
  out(`Provider reactor, model ${ORBIS_MODEL}, SDK ${REACTOR_SDK}; seed ${req.seed}, resolution ${req.resolution}, prompt passthrough, image preprocessing none`);
  out(`Duration: at most ${MAX_CHUNKS} chunks (warm-up + ${FRAME_CHUNKS} frame-bearing), clip = measured frame window + ${CLIP_MARGIN_SECONDS} s, must be 3–5 s; token: 1 session, ≤ ${MAX_SESSION_SECONDS} s`);
  out(`Output: ${req.outputAssetId} at ${req.outputStorageRef}`);

  const existing = await store.getMediaAsset(req.outputAssetId);
  const ledger = new FileAttemptLedger(LEDGER_DIR);
  const claimed = await ledger.has(attemptKey(req));
  out(`State: preview ${existing ? "already registered (a run would reuse it)" : "not registered"}; paid attempt ${claimed ? "already claimed (a run would refuse)" : "not yet made"}`);
  const chrome = await access(CHROME).then(() => true, () => false);
  const ffprobe = await which("ffprobe");
  const key = Boolean(process.env[REACTOR_API_KEY_ENV]?.trim());
  if (!chrome || !ffprobe) return (out(`The local runtime is incomplete (headless Chrome ${chrome ? "found" : "MISSING"}, ffprobe ${ffprobe ? "found" : "MISSING"}). Nothing was done.`), 1);
  // Local only: the bundled SDK page loads in a fresh headless Chrome with WebRTC. No Reactor request.
  const page = await probePageRuntime(CHROME);
  out(`Runtime: SDK page bundle sha256 ${page.bundleSha256} loads in headless Chrome (WebRTC ${page.webrtc ? "available" : "MISSING"}, SDK WebAssembly binding ${page.wasm ? "compiles" : "FAILED"}); ffprobe found; ${REACTOR_API_KEY_ENV} ${key ? "set" : "MISSING"}`);
  out(`Page requests: ${page.requests.length} to the local server, ${page.externalRequests.length} elsewhere`);
  if (!page.webrtc || !page.wasm || page.externalRequests.length > 0) return (out("The page runtime is not as required (WebRTC or the SDK binding missing, or a non-local request). Nothing was done."), 1);

  if (!approved) {
    out(
      claimed && !existing
        ? "Preflight only: no Reactor request was made. A paid run would refuse: this request's single paid attempt is already claimed, and it is never retried."
        : `Preflight only: no Reactor request was made. To run the single paid session, pass --approve-paid-call=${req.planId}.`,
    );
    return 0;
  }
  const provider = createReactorProviderFromEnv(process.env);
  if (!provider) return (out(`${REACTOR_API_KEY_ENV} is not set. Nothing was done.`), 1);
  // A registered preview is reused without any Reactor request, so no rate is needed.
  let costRate: ProviderCostRate | null = existing ? { usdPerSecond: Number.NaN, source: "", retrievedAt: "" } : await fetchOrbisRate();
  const manual = arg("rate-usd-per-second");
  if (!costRate && manual !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(manual)) return (out("--rate-usd-per-second must be a non-negative decimal. Nothing was done."), 1);
    costRate = { usdPerSecond: Number(manual), source: `operator-entered Reactor Dashboard rate (--rate-usd-per-second=${manual}); no public rate was published`, retrievedAt: new Date().toISOString() };
  }
  if (!costRate) return (out("Reactor publishes no per-second rate for this model; pass --rate-usd-per-second=<decimal> from the Dashboard. Nothing was done."), 1);
  if (!existing) out(`Cost rate: ${costRate.usdPerSecond} USD/s (${costRate.source})`);
  out("Approved: making exactly one Reactor session.");
  const result = await executeMotionPreview(req, { workflow, store, storage, provider, ledger, probe: (b) => ffprobeVideo(b), costRate, timeoutMs: SESSION_TIMEOUT_MS });
  const scrub = (s: string) => redactSecrets(s, [...secrets, ...provider.sensitive]);
  if (!result.ok) {
    out(scrub(`STOPPED at ${result.stage}: ${result.errors.slice(0, 5).join("; ")}`));
    const run = result.run;
    if (run) {
      out(scrub(`Failed run: category ${run.errorCategory}; session ${run.sessionId ?? "unknown (not reported)"}; reached ready ${run.reachedReady}; commands sent [${run.commandsSent.join(", ")}]`));
      out(scrub(`Billing: ready-to-close ${run.readyToCloseSeconds ?? "unmeasured"} s, billed ${run.billedSeconds ?? "unknown"} s, generated ${run.generatedSeconds} s, estimated cost ${run.estimatedCostUsd ?? "unknown"} USD at ${run.costRate.usdPerSecond} USD/s (${run.costRate.source})`));
      if (run.resolution) out(scrub(`Resolution: ${JSON.stringify(run.resolution)}`));
      out(scrub(`Start acknowledged by: ${run.startAcknowledgedBy ?? "not acknowledged"}; session closed at ${run.sessionClosedAt ?? "unobserved"}`));
      if (run.clip) out(scrub(`Clip: ${run.clip.kind} markers ${run.clip.startMarker}–${run.clip.endMarker} (now ${run.clip.nowMarker}); expected ready in ${run.clip.predictedReadyInMs ?? "unreported"} ms`));
      if (run.clipRequestAcknowledgedAt) out(scrub(`Clip request acknowledged at ${run.clipRequestAcknowledgedAt}; the session closed before the download`));
      if (run.download) out(scrub(`Post-close download: ${run.download.outcome}; deadline ${run.download.deadlineMs ?? "none"} ms; waited ${run.download.waitMs ?? 0} ms (not billed)`));
      out("The failed attempt and its outcome are retained in the local attempt ledger; no retry will be made.");
    }
    return 1;
  }
  out(scrub(`${result.status === "created" ? "Created" : "Reused"} ${result.assetId}: ${result.checksum}; ${result.durationSeconds.toFixed(3)} s at ${result.width}×${result.height}; estimated cost ${result.costUsd} USD; human preview review pending.`));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`motion-preview failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
