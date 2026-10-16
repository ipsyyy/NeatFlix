/**
 * Bounded command: records the project owner's human visual review of one
 * explicitly named, registered edited still (append-only; the asset's own
 * record is never changed). Without --record it only verifies (read-only).
 * The reviewer is the human owner of the NativeFrame BAND agents, read with a
 * read-only identity lookup; no agent is started.
 *
 * Run: npm run media:visual-review -- --asset=<id> --decision=rejected --reason="..." [--reason="..."]
 *      add --record=<the same id> to write the review
 */
import { bandClientFor } from "@/agents/band/case-room";
import { collectSecrets, loadLocalEnv, readAllCredentials, readBandUrls } from "@/agents/config/env";
import { loadVerifiedEditedStill } from "@/agents/media/edited-still";
import { currentVisualDecision, parseReviewArgs, recordVisualReview } from "@/agents/media/visual-review";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const args = parseReviewArgs(process.argv.slice(2));
  if (!args.ok) return (out(`${args.errors.join(" ")} Nothing was done.`), 1);
  const { assetId, decision, reasons, record } = args.value;
  const store = createWorkflowStoreFromEnv(process.env);
  if (!store) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);
  const verified = await loadVerifiedEditedStill(workflow, store, assetId);
  if (!verified.ok) return (out(`${assetId} is not a registered edited still that revalidates. Nothing was done.`), 1);
  out(`${assetId} revalidates (case ${verified.row.case_id}, plan ${verified.row.plan_id}, ${verified.row.checksum}); current decision: ${await currentVisualDecision(store, assetId)}`);
  out(`Review to record: ${decision}, ${reasons.length} reason(s).`);

  const director = readAllCredentials(process.env).find((c) => c.role === "placement-director")!;
  const me = await bandClientFor(director, readBandUrls(process.env)).agentApiIdentity.getAgentMe();
  const ownerUserId = me.data.owner_uuid ?? "";
  if (!ownerUserId) return (out("BAND did not report the agents' human owner. Nothing was done."), 1);
  out(`Reviewer: the human owner of the NativeFrame BAND agents (${ownerUserId}).`);
  if (!record) {
    out(`Verification only. To record this review, add --record=${assetId}.`);
    return 0;
  }
  const r = await recordVisualReview({
    workflow,
    store,
    assetId,
    decision,
    reasons,
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
