/**
 * Read-only by default. An exact --approve-paid-call token permits one Aleph
 * task; no retry is performed. The result is downloaded locally for human
 * review but is not registered or approved automatically.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { ALEPH_EDIT_PROMPT, estimateAlephCost, preflightProblems, RunwayAlephProvider, RUNWAY_API_KEY_ENV, sha256 } from "@/agents/media/runway-aleph";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const AUTHORIZATION = "plan:daybreak-cold-brew:luv-scene-1:v4-runway";
const SOURCE_ID = "asset:luv-hypothesis:source-video:v1";
const REFERENCE_ID = "asset:luv-hypothesis:edited-still:luv-scene-1:v3";
const RUN_DIR = resolve(process.cwd(), ".demo", "runway");
const LEDGER = resolve(RUN_DIR, "attempt.json");

async function main() {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (line: string) => console.log(redactSecrets(line, secrets));
  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) throw new Error("Supabase is not configured.");
  const [sourceRow, referenceRow, review] = await Promise.all([store.getMediaAsset(SOURCE_ID), store.getMediaAsset(REFERENCE_ID), store.getVisualReview(REFERENCE_ID)]);
  if (!sourceRow || sourceRow.kind !== "source-video" || !sourceRow.duration_seconds) throw new Error("The registered source video is unavailable.");
  if (!referenceRow || referenceRow.kind !== "edited-still") throw new Error("The approved Daybreak reference still is unavailable.");
  if (!review || review.decision !== "approved" || review.asset_checksum !== referenceRow.checksum) throw new Error("The Daybreak reference still lacks an exact approved human visual review.");
  const [sourceVideo, referenceImage] = await Promise.all([storage.download(sourceRow.storage_ref), storage.download(referenceRow.storage_ref)]);
  if (!sourceVideo || !referenceImage) throw new Error("Private source or reference bytes are unavailable.");
  if (sha256(sourceVideo) !== sourceRow.checksum || sha256(referenceImage) !== referenceRow.checksum) throw new Error("Private media checksum verification failed.");
  const request = { sourceVideo, referenceImage, durationSeconds: sourceRow.duration_seconds, sourceChecksum: sourceRow.checksum, referenceChecksum: referenceRow.checksum };
  const errors = preflightProblems(request);
  if (errors.length) throw new Error(errors.join(" "));
  const cost = estimateAlephCost(request.durationSeconds);
  out(`Runway Aleph preflight passed: ${request.durationSeconds.toFixed(3)} s source; approved keyframe at 8 s; edit window 4–15 s.`);
  out(`Estimated maximum: ${cost.credits} credits, approximately $${cost.usd.toFixed(2)}; hard ceiling $6.00; no automatic retry.`);
  out(`Prompt: ${ALEPH_EDIT_PROMPT}`);
  out(`Key: ${process.env[RUNWAY_API_KEY_ENV]?.trim() ? "configured" : "MISSING"}. No provider request has been made yet.`);
  const approval = process.argv.find((arg) => arg.startsWith("--approve-paid-call="))?.slice("--approve-paid-call=".length);
  if (approval !== AUTHORIZATION) {
    out(`To authorize exactly one paid task, rerun with --approve-paid-call=${AUTHORIZATION}`);
    return;
  }
  if (!process.env[RUNWAY_API_KEY_ENV]?.trim()) throw new Error(`${RUNWAY_API_KEY_ENV} is missing.`);
  await mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  try {
    await readFile(LEDGER);
    throw new Error("An Aleph attempt is already recorded; refusing a duplicate paid call.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(LEDGER, `${JSON.stringify({ state: "authorized", authorization: AUTHORIZATION, at: new Date().toISOString(), sourceChecksum: request.sourceChecksum, referenceChecksum: request.referenceChecksum })}\n`, { flag: "wx", mode: 0o600 });
  const provider = new RunwayAlephProvider(process.env[RUNWAY_API_KEY_ENV]!);
  const result = await provider.generate(request);
  const response = await fetch(result.outputUrl, { redirect: "error" });
  if (!response.ok || !/^video\//.test(response.headers.get("content-type") ?? "")) throw new Error(`Runway output download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const output = resolve(RUN_DIR, "daybreak-aleph-attempt-1.mp4");
  await writeFile(output, bytes, { mode: 0o600 });
  await writeFile(LEDGER, `${JSON.stringify({ state: "downloaded-pending-human-review", authorization: AUTHORIZATION, taskId: result.taskId, estimatedCredits: result.estimatedCredits, chargedCredits: result.chargedCredits, outputChecksum: sha256(bytes), output }, null, 2)}\n`, { mode: 0o600 });
  out(`Downloaded one Aleph result to ${output}. Charged ${result.chargedCredits} credits. Human visual review is pending; nothing was registered or approved.`);
}

main().catch((error) => { console.error(`full-scene-edit failed: ${safeErrorMessage(error, collectSecrets(process.env))}`); process.exit(1); });
