/**
 * Bounded command: executes exactly one approved Gemini (Nano Banana) still
 * edit for the persisted LUV placement plan, then stops. It makes at most one
 * paid provider call, and only with the explicit approval flag naming the plan.
 * Without the flag it makes no provider call and no write: it only verifies the
 * plan and source frame (read-only) and prints what it would do.
 *
 * Run (verification only):  npm run media:edit-still
 * Run (one paid call):      npm run media:edit-still -- --approve-paid-call=plan:daybreak-cold-brew:luv-scene-1:v1
 *
 * Prints only identifiers, hashes, resolutions, and latency. Never keys.
 */
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { editContextFor } from "@/agents/media/edited-still";
import { createGeminiProviderFromEnv, GEMINI_API_KEY_ENV, GEMINI_IMAGE_EDIT_MODEL } from "@/agents/media/gemini-provider";
import { executeStillEdit, type StillEditRequest } from "@/agents/media/still-edit";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

/** The one approved edit. These identifiers are fixed; nothing here is taken from arguments. */
const APPROVED_EDIT: StillEditRequest = Object.freeze({
  planId: "plan:daybreak-cold-brew:luv-scene-1:v1",
  sourceFrameAssetId: "asset:luv-hypothesis:source-frame:luv-scene-1:v1",
  sourceFrameStorageRef: "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png",
  outputAssetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v1",
  outputStorageRef: "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v1/edited-still-v1.png",
});
const PROVIDER_TIMEOUT_MS = 180_000;

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (s: string) => console.log(redactSecrets(s, secrets));
  const approval = process.argv.find((a) => a.startsWith("--approve-paid-call="))?.split("=")[1];
  const approved = approval === APPROVED_EDIT.planId;

  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) {
    out("Supabase is not configured (SUPABASE_URL, SUPABASE_SECRET_KEY). Nothing was done.");
    return 1;
  }
  const workflow = new WorkflowRegistry(store);
  const ctx = await editContextFor(workflow, APPROVED_EDIT.planId);
  if (!ctx.ok) {
    out(`Plan or source frame does not revalidate: ${ctx.errors.slice(0, 3).join("; ")}. Nothing was done.`);
    return 1;
  }
  out(`Plan ${APPROVED_EDIT.planId} (case ${ctx.value.caseId}) revalidated; source frame ${ctx.value.sourceFrame.assetId} ${ctx.value.sourceFrame.checksum}`);
  out(`Prompt: ${ctx.value.prompt.length} characters, sha256 ${ctx.value.promptSha256}; model ${GEMINI_IMAGE_EDIT_MODEL}`);
  out(`Output: ${APPROVED_EDIT.outputAssetId} at ${APPROVED_EDIT.outputStorageRef}`);
  if (!approved) {
    out(`Verification only. To make the single paid call, pass --approve-paid-call=${APPROVED_EDIT.planId}.`);
    return 0;
  }
  const provider = createGeminiProviderFromEnv(process.env);
  if (!provider) {
    out(`${GEMINI_API_KEY_ENV} is not set. Nothing was done.`);
    return 1;
  }
  out("Approved: making exactly one Gemini still-edit call.");
  const result = await executeStillEdit(APPROVED_EDIT, { workflow, store, storage, provider, timeoutMs: PROVIDER_TIMEOUT_MS });
  if (!result.ok) {
    out(`STOPPED at ${result.stage}: ${result.errors.slice(0, 5).join("; ")}`);
    return 1;
  }
  out(`${result.status === "created" ? "Created" : "Reused"} ${result.assetId}: ${result.checksum}; provider image ${result.originalResolution.width}×${result.originalResolution.height}, normalization ${result.normalization}; human visual review pending.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`edit-still failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
