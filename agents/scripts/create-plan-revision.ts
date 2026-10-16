/**
 * Bounded command: creates a human-directed LUV plan revision from the persisted
 * earlier version: v2 (from v1) or v3 (rebrand the two existing cups, from v2).
 * Without --persist it only validates (read-only). With --persist=<that plan ID>
 * it saves the revision through the production adapter (idempotent; a different
 * stored plan under that ID is refused) and reads it back.
 *
 * Run: npm run media:plan-revision -- --revision=v3
 *      npm run media:plan-revision -- --revision=v3 --persist=plan:daybreak-cold-brew:luv-scene-1:v3
 *      (--revision defaults to v2)
 */
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { validatePlacementPlan } from "@/agents/handoff/placement-plan";
import { sha256Hex } from "@/agents/media/edited-still";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { buildLuvRebrandPlanV3, buildRevisedPlan, LUV_PLAN_V2, LUV_PLAN_V3 } from "@/agents/media/plan-revisions";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { canonical, staticFrameRegistry, WorkflowRegistry } from "@/agents/persistence/workflow";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const store = createWorkflowStoreFromEnv(process.env);
  if (!store) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);
  const which = process.argv.find((a) => a.startsWith("--revision="))?.split("=")[1] ?? "v2";
  const REVISIONS: Record<string, { fromPlanId: string; planId: string; build: (p: PlacementPlan) => PlacementPlan }> = {
    v2: { fromPlanId: LUV_PLAN_V2.fromPlanId, planId: LUV_PLAN_V2.planId, build: (p) => buildRevisedPlan(p, LUV_PLAN_V2) },
    v3: { fromPlanId: LUV_PLAN_V3.fromPlanId, planId: LUV_PLAN_V3.planId, build: buildLuvRebrandPlanV3 },
  };
  const revision = REVISIONS[which];
  if (!revision) return (out(`Unknown revision "${which.slice(0, 20)}"; use v2 or v3. Nothing was done.`), 1);
  const from = await workflow.loadPlan(revision.fromPlanId);
  if (!from.ok) return (out(`${revision.fromPlanId} does not revalidate. Nothing was done.`), 1);
  const plan = revision.build(from.value);
  const frames = staticFrameRegistry(plan.caseId, plan.scene.sceneId, await workflow.loadSourceFramesForScene(plan.caseId, plan.scene.sceneId));
  const errors = validatePlacementPlan(plan, plan.caseId, frames);
  if (errors.length > 0) return (out(`Revised plan does not validate: ${errors.slice(0, 5).join("; ")}. Nothing was done.`), 1);
  out(`${plan.planId} validates; still prompt ${plan.prompts.stillImageEdit.prompt.length} characters, sha256 ${sha256Hex(plan.prompts.stillImageEdit.prompt)}`);
  if (process.argv.find((a) => a.startsWith("--persist="))?.split("=")[1] !== revision.planId) {
    out(`Validation only. To persist, pass --revision=${which} --persist=${revision.planId}.`);
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
