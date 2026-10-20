/**
 * Server-only persistence for NativeFrame's workflow records
 * (PRODUCT_SOURCE_OF_TRUTH.md §10: Supabase Database for cases and decisions,
 * Supabase Storage for media). Rows here are raw storage: nothing read from a
 * store is trusted until workflow.ts revalidates it.
 *
 * Never import this module, or anything under agents/persistence, from app/,
 * components/, or lib/: privileged credentials must not reach browser code.
 */

export type CaseStatus = "open" | "revise-requested" | "awaiting-human-review" | "approved" | "stopped";

export type CaseRow = { case_id: string; title_id: string; status: CaseStatus; created_at: string; updated_at: string };

export type PlanRow = {
  plan_id: string;
  case_id: string;
  title_id: string;
  scene_id: string;
  campaign_id: string;
  version: number;
  plan: unknown;
  validation_status: "valid";
  created_at: string;
};

export const MEDIA_KINDS = ["source-video", "source-frame", "edited-still", "generated-preview", "full-scene-video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export type MediaAssetRow = {
  asset_id: string;
  case_id: string;
  plan_id: string | null;
  kind: MediaKind;
  storage_ref: string;
  mime_type: string;
  duration_seconds: number | null;
  generator: string | null;
  model: string | null;
  generated_at: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  checksum: string;
  provenance: unknown;
  created_at: string;
};

/**
 * Most records a registry lookup may consider. Lookups request one more than
 * this; more than this many matching rows means the lookup fails closed rather
 * than choosing from a truncated result.
 */
export const REGISTRY_LOOKUP_CAP = 20;

export type ReviewDecisionValue = "revise" | "approve-for-human-review" | "stop";

export type ReviewRow = {
  review_id: string;
  case_id: string;
  plan_id: string;
  preview_asset_id: string | null;
  decision: ReviewDecisionValue;
  review: unknown;
  created_at: string;
};

export type ApprovalRow = {
  approval_id: string;
  case_id: string;
  review_id: string;
  preview_asset_id: string;
  reviewer_user_id: string;
  reviewer_name: string;
  decision: "approve";
  /** 1–10 distinct, non-empty reasons of at most 500 characters (20261017000000_human_approval_reasons.sql). */
  reasons: string[];
  created_at: string;
};

export type VisualReviewDecision = "approved" | "approved-with-limitation" | "rejected";

/**
 * A human visual review of one media asset (supabase/migrations/20261016050000_media_visual_reviews.sql).
 * Limitations are non-empty exactly when the decision is approved-with-limitation
 * (20261019000000_full_scene_video_and_review_limitations.sql); earlier reviews read back with none.
 */
export type VisualReviewRow = {
  review_id: string;
  asset_id: string;
  case_id: string;
  decision: VisualReviewDecision;
  reasons: string[];
  limitations: string[];
  asset_checksum: string;
  reviewer_user_id: string;
  reviewer_name: string;
  created_at: string;
};

/** Insert inputs: the store sets created_at (and updated_at for cases). */
export type NewCase = Omit<CaseRow, "created_at" | "updated_at">;
export type NewPlan = Omit<PlanRow, "created_at">;
export type NewMediaAsset = Omit<MediaAssetRow, "created_at">;
export type NewReview = Omit<ReviewRow, "created_at">;
export type NewApproval = Omit<ApprovalRow, "created_at">;
/** Limitations are sent only when present, so other reviews insert unchanged before the migration. */
export type NewVisualReview = Omit<VisualReviewRow, "created_at" | "limitations"> & { limitations?: string[] };

/** A row with that primary or unique key already exists. Duplicates and replays are never overwritten. */
export class DuplicateRecordError extends Error {
  constructor(public readonly table: string) {
    super(`A ${table} record with that key already exists.`);
    this.name = "DuplicateRecordError";
  }
}

/** The store refused a write that would break an integrity rule (foreign key, check, or immutability). */
export class IntegrityError extends Error {
  constructor(public readonly table: string, detail: string) {
    super(`${table}: ${detail}`);
    this.name = "IntegrityError";
  }
}

/**
 * Raw workflow storage. Plans, reviews, and approvals are insert-only; a media
 * asset can be corrected only until a review references it; only a case's
 * status can change. Implementations
 * must reject duplicate keys with DuplicateRecordError and enforce the same
 * constraints as supabase/migrations.
 */
export interface WorkflowStore {
  ensureCase(row: NewCase): Promise<void>;
  setCaseStatus(caseId: string, status: CaseStatus): Promise<void>;
  getCase(caseId: string): Promise<CaseRow | null>;

  insertPlan(row: NewPlan): Promise<void>;
  getPlan(planId: string): Promise<PlanRow | null>;
  /** Up to `limit` plans of a case, oldest first, filtered by the store itself. */
  listPlansForCase(caseId: string, limit: number): Promise<PlanRow[]>;

  insertMediaAsset(row: NewMediaAsset): Promise<void>;
  /**
   * Corrects an asset's metadata before review. Must throw IntegrityError once
   * any Governor review references the asset: referenced media is immutable.
   */
  updateMediaAsset(assetId: string, patch: Partial<Omit<NewMediaAsset, "asset_id">>): Promise<void>;
  getMediaAsset(assetId: string): Promise<MediaAssetRow | null>;
  /** Up to `limit` newest assets of a kind for a plan, filtered by the store itself. */
  listMediaAssetsForPlan(planId: string, kind: MediaKind, limit: number): Promise<MediaAssetRow[]>;
  /** Up to `limit` newest source frames of a case whose provenance names the scene, filtered by the store itself. */
  listSourceFramesForScene(caseId: string, sceneId: string, limit: number): Promise<MediaAssetRow[]>;

  insertReview(row: NewReview): Promise<void>;
  getReview(reviewId: string): Promise<ReviewRow | null>;
  /** Up to `limit` newest Governor reviews of a case, filtered by the store itself. */
  listReviewsForCase(caseId: string, limit: number): Promise<ReviewRow[]>;

  insertApproval(row: NewApproval): Promise<void>;
  getApprovalForReview(reviewId: string): Promise<ApprovalRow | null>;

  /** One append-only human visual review per asset; the reviewed asset then becomes immutable. */
  insertVisualReview(row: NewVisualReview): Promise<void>;
  getVisualReview(assetId: string): Promise<VisualReviewRow | null>;
}
