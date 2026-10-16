import { approvalReasonErrors } from "@/agents/handoff/human-approval";
import {
  DuplicateRecordError,
  IntegrityError,
  type ApprovalRow,
  type CaseRow,
  type CaseStatus,
  type MediaAssetRow,
  type MediaKind,
  type NewApproval,
  type NewCase,
  type NewMediaAsset,
  type NewPlan,
  type NewReview,
  type NewVisualReview,
  type VisualReviewRow,
  type PlanRow,
  type ReviewRow,
  type WorkflowStore,
} from "@/agents/persistence/store";

/**
 * Deterministic in-memory WorkflowStore for tests only. It mirrors the
 * constraints in supabase/migrations: duplicate keys, foreign keys including
 * the composite case-binding keys,
 * generated-preview completeness, review/approval consistency, one approval
 * per review, and media immutability once a review references it.
 * Lives under agents/tests so production code cannot import it.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  readonly cases = new Map<string, CaseRow>();
  readonly plans = new Map<string, PlanRow>();
  readonly media = new Map<string, MediaAssetRow>();
  readonly reviews = new Map<string, ReviewRow>();
  readonly approvals = new Map<string, ApprovalRow>();
  readonly visualReviews = new Map<string, VisualReviewRow>();
  private tick = 0;

  /** Deterministic, strictly increasing timestamps. */
  private now(): string {
    return new Date(Date.UTC(2026, 9, 15, 0, 0, this.tick++)).toISOString();
  }

  async ensureCase(row: NewCase): Promise<void> {
    if (this.cases.has(row.case_id)) return;
    const at = this.now();
    this.cases.set(row.case_id, { ...row, created_at: at, updated_at: at });
  }

  async setCaseStatus(caseId: string, status: CaseStatus): Promise<void> {
    const row = this.cases.get(caseId);
    if (row) this.cases.set(caseId, { ...row, status, updated_at: this.now() });
  }

  async getCase(caseId: string): Promise<CaseRow | null> {
    return clone(this.cases.get(caseId));
  }

  async insertPlan(row: NewPlan): Promise<void> {
    if (this.plans.has(row.plan_id)) throw new DuplicateRecordError("placement_plans");
    const c = this.cases.get(row.case_id);
    if (!c || c.title_id !== row.title_id) throw new IntegrityError("placement_plans", "no case with this case_id and title_id");
    this.plans.set(row.plan_id, structuredClone({ ...row, created_at: this.now() }));
  }

  async getPlan(planId: string): Promise<PlanRow | null> {
    return clone(this.plans.get(planId));
  }

  async insertMediaAsset(row: NewMediaAsset): Promise<void> {
    if (this.media.has(row.asset_id) || [...this.media.values()].some((m) => m.storage_ref === row.storage_ref)) {
      throw new DuplicateRecordError("media_assets");
    }
    if (!this.cases.has(row.case_id)) throw new IntegrityError("media_assets", "unknown case");
    if (row.plan_id && this.plans.get(row.plan_id)?.case_id !== row.case_id) throw new IntegrityError("media_assets", "no plan with this plan_id and case_id");
    if (row.kind === "generated-preview") {
      const prov = row.provenance as Record<string, unknown> | null;
      if (!row.plan_id || !row.generator || !row.model || !row.generated_at || row.latency_ms == null || row.cost_usd == null || prov?.inputPlanId !== row.plan_id) {
        throw new IntegrityError("media_assets", "incomplete generated preview");
      }
    }
    this.media.set(row.asset_id, structuredClone({ ...row, created_at: this.now() }));
  }

  async updateMediaAsset(assetId: string, patch: Partial<Omit<NewMediaAsset, "asset_id">>): Promise<void> {
    const row = this.media.get(assetId);
    if (!row) return;
    if ([...this.reviews.values()].some((r) => r.preview_asset_id === assetId) || this.visualReviews.has(assetId)) {
      throw new IntegrityError("media_assets", "referenced by a Governor review and immutable");
    }
    this.media.set(assetId, structuredClone({ ...row, ...patch }));
  }

  async getMediaAsset(assetId: string): Promise<MediaAssetRow | null> {
    return clone(this.media.get(assetId));
  }

  async listMediaAssetsForPlan(planId: string, kind: MediaKind, limit: number): Promise<MediaAssetRow[]> {
    return [...this.media.values()]
      .filter((m) => m.plan_id === planId && m.kind === kind)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }

  async listSourceFramesForScene(caseId: string, sceneId: string, limit: number): Promise<MediaAssetRow[]> {
    // Same semantics as the Supabase query: case, kind, and provenance->>sceneId (text) filtered before the limit.
    return [...this.media.values()]
      .filter((m) => m.case_id === caseId && m.kind === "source-frame" && textAt(m.provenance, "sceneId") === sceneId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }

  async insertReview(row: NewReview): Promise<void> {
    if (this.reviews.has(row.review_id)) throw new DuplicateRecordError("governor_reviews");
    if (this.plans.get(row.plan_id)?.case_id !== row.case_id) throw new IntegrityError("governor_reviews", "no plan with this plan_id and case_id");
    if (row.decision === "approve-for-human-review" && !row.preview_asset_id) throw new IntegrityError("governor_reviews", "approval needs a preview");
    if (row.preview_asset_id) {
      const asset = this.media.get(row.preview_asset_id);
      if (!asset || asset.kind !== "generated-preview" || asset.plan_id !== row.plan_id || asset.case_id !== row.case_id) {
        throw new IntegrityError("governor_reviews", "preview is not a generated preview of this plan and case");
      }
    }
    this.reviews.set(row.review_id, structuredClone({ ...row, created_at: this.now() }));
  }

  async getReview(reviewId: string): Promise<ReviewRow | null> {
    return clone(this.reviews.get(reviewId));
  }

  async listReviewsForCase(caseId: string, limit: number): Promise<ReviewRow[]> {
    return [...this.reviews.values()]
      .filter((r) => r.case_id === caseId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async insertApproval(row: NewApproval): Promise<void> {
    if (this.approvals.has(row.approval_id) || [...this.approvals.values()].some((a) => a.review_id === row.review_id)) {
      throw new DuplicateRecordError("human_approvals");
    }
    const review = this.reviews.get(row.review_id);
    if (this.media.get(row.preview_asset_id)?.case_id !== row.case_id) throw new IntegrityError("human_approvals", "no asset with this asset_id and case_id");
    if (!review || review.decision !== "approve-for-human-review" || review.case_id !== row.case_id || review.preview_asset_id !== row.preview_asset_id) {
      throw new IntegrityError("human_approvals", "approval does not match an approve-for-human-review");
    }
    // Mirrors 20261017000000_human_approval_reasons.sql: valid reasons, case awaiting review, and an atomic move to approved.
    if (approvalReasonErrors(row.reasons).length > 0) throw new IntegrityError("human_approvals", "reasons must be 1–10 distinct non-empty strings of at most 500 characters");
    const caseRow = this.cases.get(row.case_id);
    if (caseRow?.status !== "awaiting-human-review") throw new IntegrityError("human_approvals", "the case is not awaiting human review");
    this.approvals.set(row.approval_id, structuredClone({ ...row, created_at: this.now() }));
    this.cases.set(row.case_id, { ...caseRow, status: "approved", updated_at: this.now() });
  }

  async getApprovalForReview(reviewId: string): Promise<ApprovalRow | null> {
    return clone([...this.approvals.values()].find((a) => a.review_id === reviewId));
  }

  async insertVisualReview(row: NewVisualReview): Promise<void> {
    if (this.visualReviews.has(row.asset_id) || [...this.visualReviews.values()].some((v) => v.review_id === row.review_id)) throw new DuplicateRecordError("media_visual_reviews");
    const asset = this.media.get(row.asset_id);
    if (!asset || asset.case_id !== row.case_id) throw new IntegrityError("media_visual_reviews", "no asset with this asset_id and case_id");
    if (asset.checksum !== row.asset_checksum) throw new IntegrityError("media_visual_reviews", "review must name the asset's registered checksum");
    if (row.decision === "rejected" && row.reasons.length === 0) throw new IntegrityError("media_visual_reviews", "a rejection must state reasons");
    this.visualReviews.set(row.asset_id, structuredClone({ ...row, created_at: this.now() }));
  }

  async getVisualReview(assetId: string): Promise<VisualReviewRow | null> {
    return clone(this.visualReviews.get(assetId));
  }

  /** Test-only: changes a stored row out of band, as a compromised or hand-edited database could. */
  tamper<K extends "plans" | "media" | "reviews">(table: K, id: string, patch: Record<string, unknown>): void {
    const map = this[table] as Map<string, Record<string, unknown>>;
    const row = map.get(id);
    if (row) map.set(id, { ...row, ...patch });
  }
}

const clone = <T>(v: T | undefined): T | null => (v === undefined ? null : structuredClone(v));

/** Postgres `->>`: a JSON object's field as text (strings as-is, other scalars stringified), else null. */
function textAt(json: unknown, key: string): string | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const v = (json as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}
