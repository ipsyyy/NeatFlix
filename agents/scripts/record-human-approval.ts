/**
 * Bounded command: records the human owner's final approval of the stored
 * Release Governor review of LUV plan v3 (case NF-DEMO-0001), pinned to exact
 * records, with exactly the six authorized reasons.
 *
 * Preflight (default, read-only): checks the supplied reasons against the
 * authorized reasons, that the reasons migration is applied, and every pinned
 * record (plan hash, stored approve-for-human-review and its revalidation,
 * registered preview, checksum, approved visual review, case awaiting human
 * review, no existing approval). Supabase reads only: no BAND call, no write.
 *
 * Record (only with --record=<the exact review ID>): repeats the preflight,
 * makes one read-only BAND owner-identity lookup, inserts one approval with the
 * reasons (the case moves to approved in the same transaction), and reads it
 * back. Starts no agent and creates no room.
 *
 * Run: npm run agents:record-human-approval -- --reason="<1>" … --reason="<6>" [--record=review:plan:daybreak-cold-brew:luv-scene-1:v3:r1]
 */
import { bandClientFor } from "@/agents/band/case-room";
import { collectSecrets, loadLocalEnv, readAllCredentials, readBandUrls } from "@/agents/config/env";
import { evaluatePreviewEvidence } from "@/agents/media/preview-evidence";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { checkApprovalReasons, preflightHumanApproval, recordPinnedHumanApproval } from "@/agents/runtime/human-approval-recorder";
import { AUTHORIZED_REASONS, PIN } from "@/agents/runtime/plan-v3-approval";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (s: string) => console.log(redactSecrets(s, secrets));
  const values = (name: string) => process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const reasons = values("reason");
  const records = values("record");
  if (records.length > 1 || (records.length === 1 && records[0] !== PIN.reviewId)) return (out(`--record must repeat the exact review ID ${PIN.reviewId}. Nothing was done.`), 1);
  const reasonErrors = checkApprovalReasons(reasons, AUTHORIZED_REASONS);
  if (reasonErrors.length > 0) return (out(`${reasonErrors.join(" ")} Nothing was done.`), 1);
  out(`Reasons: exactly the ${AUTHORIZED_REASONS.length} authorized reasons, in order.`);

  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);
  const deps = { workflow, store, evidence: (planId: string) => evaluatePreviewEvidence({ workflow, store, storage }, planId) };
  const migrated = await store.approvalReasonsAvailable();
  out(`Reasons migration (20261017000000_human_approval_reasons.sql): ${migrated ? "applied" : "NOT applied"}`);
  const pre = await preflightHumanApproval(deps, PIN);
  if (!pre.ok) return (out(`Preflight FAILED:\n  - ${pre.errors.join("\n  - ")}\nNothing was done.`), 1);
  out(`Preflight passed: plan ${PIN.planId} (sha256 ${PIN.planSha256}); review ${PIN.reviewId} approve-for-human-review revalidates; preview ${PIN.previewAssetId} ${PIN.previewChecksum} with approved visual review ${PIN.visualReviewId}; case ${PIN.caseId} awaiting-human-review; no approval exists.`);
  if (records.length === 0) {
    out(`Preflight only: no BAND call and no write.${migrated ? "" : " Apply the migration before recording."} To record: add --record=${PIN.reviewId}.`);
    return 0;
  }
  if (!migrated) return (out("The reasons migration is not applied. Nothing was done."), 1);

  const director = readAllCredentials(process.env).find((c) => c.role === "placement-director")!;
  const me = await bandClientFor(director, readBandUrls(process.env)).agentApiIdentity.getAgentMe();
  const ownerUserId = me.data.owner_uuid ?? "";
  if (!ownerUserId) return (out("BAND did not report the agents' human owner. Nothing was done."), 1);
  out(`Approver: the human owner of the NativeFrame BAND agents (${ownerUserId}).`);
  const r = await recordPinnedHumanApproval(deps, PIN, {
    sender: { id: ownerUserId, type: "User", role: null },
    ownerUserId,
    approverName: "NativeFrame project owner",
    reasons,
    expectedReasons: AUTHORIZED_REASONS,
  });
  if (!r.ok) return (out(`Not recorded: ${r.errors.slice(0, 5).join("; ")}`), 1);
  out(`Human approval recorded: ${r.value.approval.approval_id} at ${r.value.approval.created_at}; case ${PIN.caseId} is ${r.value.caseStatus}.`);
  out(JSON.stringify(r.value.approval, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`record-human-approval failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
