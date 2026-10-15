import { validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";

/**
 * Placement plans the Release Governor's handoff gate has accepted from the
 * authenticated Placement Director, keyed by planId. The Governor's tools read
 * plans from here, so a review always checks the exact plan that crossed the
 * authorization boundary, never a copy Claude retyped.
 *
 * With a WorkflowRegistry, accepted plans are also persisted, and a plan not in
 * memory (for example after a restart) is reloaded and revalidated from storage.
 */
const MAX_PLANS = 20;

export class AcceptedPlanRegistry {
  private readonly plans = new Map<string, PlacementPlan>();

  constructor(private readonly workflow?: WorkflowRegistry) {}

  /** Records a plan accepted at the gate. Returns problems persisting it; the plan is kept in memory either way. */
  async record(plan: PlacementPlan): Promise<string[]> {
    if (validatePlacementPlan(plan, plan.caseId).length > 0) return ["Plan does not validate; not recorded."];
    this.remember(plan);
    if (!this.workflow) return [];
    const saved = await this.workflow.savePlan(plan);
    return saved.ok ? [] : saved.errors;
  }

  async lookup(planId: string): Promise<PlacementPlan | null> {
    const cached = this.plans.get(planId);
    if (cached) return structuredClone(cached);
    if (!this.workflow) return null;
    const stored = await this.workflow.loadPlan(planId);
    if (!stored.ok) return null;
    this.remember(stored.value);
    return structuredClone(stored.value);
  }

  private remember(plan: PlacementPlan): void {
    this.plans.delete(plan.planId);
    this.plans.set(plan.planId, structuredClone(plan));
    while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value as string);
  }
}

/** In-memory registry used when no persistent store is configured. */
export const inMemoryAcceptedPlans = new AcceptedPlanRegistry();

/** Records into the in-memory registry (no persistence). */
export function recordAcceptedPlan(plan: PlacementPlan): Promise<string[]> {
  return inMemoryAcceptedPlans.record(plan);
}

/** Looks up the in-memory registry (no persistence). */
export function acceptedPlan(planId: string): Promise<PlacementPlan | null> {
  return inMemoryAcceptedPlans.lookup(planId);
}
