/**
 * Bounded command: creates the human-directed LUV plan v2 from the persisted v1.
 * Without --persist it only validates (read-only). With
 * --persist=plan:daybreak-cold-brew:luv-scene-1:v2 it saves v2 through the
 * production adapter (idempotent; a different stored v2 is refused) and reads it back.
 *
 * Run: npm run media:plan-revision
 *      npm run media:plan-revision -- --persist=plan:daybreak-cold-brew:luv-scene-1:v2
 */
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { validatePlacementPlan } from "@/agents/handoff/placement-plan";
import { sha256Hex } from "@/agents/media/edited-still";
import { buildRevisedPlan, LUV_PLAN_V2 } from "@/agents/media/plan-revisions";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { canonical, staticFrameRegistry, WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const store = createWorkflowStoreFromEnv(process.env);
  if (!store) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);
  const from = await workflow.loadPlan(LUV_PLAN_V2.fromPlanId);
  if (!from.ok) return (out(`${LUV_PLAN_V2.fromPlanId} does not revalidate. Nothing was done.`), 1);
  const plan = buildRevisedPlan(from.value, LUV_PLAN_V2);
  const frames = staticFrameRegistry(plan.caseId, plan.scene.sceneId, await workflow.loadSourceFramesForScene(plan.caseId, plan.scene.sceneId));
  const errors = validatePlacementPlan(plan, plan.caseId, frames);
  if (errors.length > 0) return (out(`Revised plan does not validate: ${errors.slice(0, 5).join("; ")}. Nothing was done.`), 1);
  out(`${plan.planId} validates; still prompt ${plan.prompts.stillImageEdit.prompt.length} characters, sha256 ${sha256Hex(plan.prompts.stillImageEdit.prompt)}`);
  if (process.argv.find((a) => a.startsWith("--persist="))?.split("=")[1] !== LUV_PLAN_V2.planId) {
    out(`Validation only. To persist, pass --persist=${LUV_PLAN_V2.planId}.`);
    return 0;
  }
  const saved = await workflow.savePlan(plan);
  if (!saved.ok) return (out(`Not persisted: ${saved.errors.slice(0, 3).join("; ")}`), 1);
  const back = await workflow.loadPlan(plan.planId);
  const identical = back.ok && canonical(back.value) === canonical(plan);
  out(`${plan.planId}: ${saved.value.created ? "created" : "already stored (identical)"}; read-back ${identical ? "identical" : "DIFFERS"}`);
  return identical ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`plan revision failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
