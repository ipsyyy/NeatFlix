/**
 * Bounded command: records the project owner's human visual rejection of
 * edited-still v1 (append-only; the asset's own record is never changed).
 * Without --record it only verifies (read-only). The reviewer is the human
 * owner of the NativeFrame BAND agents, read with a read-only identity lookup;
 * no agent is started.
 *
 * Run: npm run media:visual-review
 *      npm run media:visual-review -- --record=asset:luv-hypothesis:edited-still:luv-scene-1:v1
 */
import { bandClientFor } from "@/agents/band/case-room";
import { collectSecrets, loadLocalEnv, readAllCredentials, readBandUrls } from "@/agents/config/env";
import { loadVerifiedEditedStill } from "@/agents/media/edited-still";
import { currentVisualDecision, recordVisualReview } from "@/agents/media/visual-review";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

/** The owner's decision, as given in the review instruction. Fixed here; nothing is taken from arguments. */
const REVIEW = Object.freeze({
  assetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v1",
  decision: "rejected" as const,
  reasons: [
    "The inserted Daybreak Cold Brew cup visually overlaps and hides part of the woman’s left forearm and sweater sleeve.",
    "The inserted cup appears approximately 20–25% taller than the existing takeaway cups and is too prominent.",
  ],
});

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const store = createWorkflowStoreFromEnv(process.env);
  if (!store) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);
  const verified = await loadVerifiedEditedStill(workflow, store, REVIEW.assetId);
  if (!verified.ok) return (out(`${REVIEW.assetId} does not revalidate. Nothing was done.`), 1);
  out(`${REVIEW.assetId} revalidates (${verified.row.checksum}); current decision: ${await currentVisualDecision(store, REVIEW.assetId)}`);

  const director = readAllCredentials(process.env).find((c) => c.role === "placement-director")!;
  const me = await bandClientFor(director, readBandUrls(process.env)).agentApiIdentity.getAgentMe();
  const ownerUserId = me.data.owner_uuid ?? "";
  if (!ownerUserId) return (out("BAND did not report the agents' human owner. Nothing was done."), 1);
  out(`Reviewer: the human owner of the NativeFrame BAND agents (${ownerUserId}).`);
  if (process.argv.find((a) => a.startsWith("--record="))?.split("=")[1] !== REVIEW.assetId) {
    out(`Verification only. To record the rejection, pass --record=${REVIEW.assetId}.`);
    return 0;
  }
  const r = await recordVisualReview({
    workflow,
    store,
    assetId: REVIEW.assetId,
    decision: REVIEW.decision,
    reasons: [...REVIEW.reasons],
    reviewer: { id: ownerUserId, type: "User", role: null, name: "NativeFrame project owner" },
    ownerUserId,
  });
  if (!r.ok) return (out(`Not recorded: ${r.errors.slice(0, 3).join("; ")}`), 1);
  out(`Visual review ${r.status}: ${r.review.decision} for ${r.review.asset_id} (${r.review.asset_checksum}), review ${r.review.review_id} at ${r.review.created_at}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`visual review failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
