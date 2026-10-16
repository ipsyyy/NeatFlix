import { validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { canonical, type WorkflowRegistry } from "@/agents/persistence/workflow";

/**
 * Placement plans the Release Governor's handoff gate has accepted from the
 * authenticated Placement Director, keyed by planId. The Governor's tools read
 * plans from here, so a review always checks the exact plan that crossed the
 * authorization boundary, never a copy Claude retyped.
 *
 * With a WorkflowRegistry, storage is the only source of truth: a plan is
 * available only once it is persisted (or an identical copy is already stored),
 * and every lookup reloads and revalidates it from storage. A lookup returns
 * the stored plan only if it is the plan this process accepted, and a planId
 * whose save failed or conflicted is unavailable, so a different stored plan
 * is never evaluated in its place. Without a WorkflowRegistry
 * (tests, local fallback), plans are kept in memory only.
 */
const MAX_PLANS = 20;

export class AcceptedPlanRegistry {
  private readonly plans = new Map<string, PlacementPlan>();
  /** With storage: content of each plan this process persisted, and planIds whose save failed. */
  private readonly persisted = new Map<string, string>();
  private readonly refused = new Set<string>();

  constructor(private readonly workflow?: WorkflowRegistry) {}

  /** Records a plan accepted at the gate. Returns why it was not recorded; nothing is recorded on failure. */
  async record(plan: PlacementPlan): Promise<string[]> {
    if (!this.workflow) {
      // Memory only: no registry, so a plan naming a registered frame fails closed here.
      if (validatePlacementPlan(plan, plan.caseId).length > 0) return ["Plan does not validate; not recorded."];
      this.remember(plan);
      return [];
    }
    // With storage, savePlan validates against the revalidated source frames for the plan's scene.
    let saved: Awaited<ReturnType<WorkflowRegistry["savePlan"]>>;
    try {
      saved = await this.workflow.savePlan(plan);
    } catch (error) {
      this.refuse(plan.planId);
      throw error;
    }
    if (!saved.ok) {
      this.refuse(plan.planId);
      return saved.errors;
    }
    this.refused.delete(plan.planId);
    this.persisted.set(plan.planId, canonical(plan));
    while (this.persisted.size > MAX_PLANS) this.persisted.delete(this.persisted.keys().next().value as string);
    return [];
  }

  async lookup(planId: string): Promise<PlacementPlan | null> {
    if (!this.workflow) {
      const cached = this.plans.get(planId);
      return cached ? structuredClone(cached) : null;
    }
    if (this.refused.has(planId)) return null;
    const stored = await this.workflow.loadPlan(planId);
    if (!stored.ok) return null;
    const accepted = this.persisted.get(planId);
    if (accepted !== undefined && accepted !== canonical(stored.value)) return null;
    return stored.value;
  }

  private refuse(planId: string): void {
    this.persisted.delete(planId);
    this.refused.delete(planId);
    this.refused.add(planId);
    while (this.refused.size > MAX_PLANS * 5) this.refused.delete(this.refused.values().next().value as string);
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
