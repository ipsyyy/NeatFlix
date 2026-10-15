import type { PlacementPlan } from "@/agents/handoff/placement-plan";

/**
 * Placement plans the Release Governor's handoff gate has accepted from the
 * authenticated Placement Director in this process, keyed by planId. The
 * Governor's tools read plans from here, so a review always checks the exact
 * plan that crossed the authorization boundary, never a copy Claude retyped.
 */
const MAX_PLANS = 20;
const plans = new Map<string, PlacementPlan>();

export function recordAcceptedPlan(plan: PlacementPlan): void {
  plans.delete(plan.planId);
  plans.set(plan.planId, structuredClone(plan));
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value as string);
}

export function acceptedPlan(planId: string): PlacementPlan | null {
  const plan = plans.get(planId);
  return plan ? structuredClone(plan) : null;
}
