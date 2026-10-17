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
} from "./store";

/**
 * WorkflowStore backed by Supabase Database through its PostgREST API, using a
 * server-only Supabase secret key (sb_secret_...). Secret keys act as the
 * service_role Postgres role and bypass row-level security, so they are sent
 * only in the apikey header (they are not JWTs and never go in Authorization).
 * Server code only: never import from app/,
 * components/, or lib/. Errors carry only the HTTP status and Postgres error
 * code, never the key, request headers, or row contents.
 */

/** Server-only environment variable names (never NEXT_PUBLIC_). */
export const SUPABASE_URL_ENV = "SUPABASE_URL";
export const SUPABASE_SECRET_KEY_ENV = "SUPABASE_SECRET_KEY";

/** Current Supabase secret key format. Publishable keys and legacy JWT keys are refused. */
export const SECRET_KEY_FORMAT = /^sb_secret_[A-Za-z0-9_-]{16,}$/;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export class SupabaseWorkflowStore implements WorkflowStore {
  private readonly rest: string;

  constructor(
    url: string,
    private readonly secretKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error(`${SUPABASE_URL_ENV} must be an https URL.`);
    // Never echo the key: report only that its format is wrong.
    if (!SECRET_KEY_FORMAT.test(secretKey)) throw new Error(`${SUPABASE_SECRET_KEY_ENV} must be a Supabase secret key (sb_secret_...).`);
    this.rest = `${parsed.origin}/rest/v1`;
  }

  private async request(table: string, init: { method: string; query?: string; body?: unknown; prefer?: string }): Promise<unknown> {
    const res = await this.fetchImpl(`${this.rest}/${table}${init.query ? `?${init.query}` : ""}`, {
      method: init.method,
      headers: {
        apikey: this.secretKey,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
    let code = "";
    try {
      const body = (await res.json()) as { code?: unknown };
      code = typeof body?.code === "string" ? body.code.replace(/[^\w]/g, "").slice(0, 10) : "";
    } catch {
      // Body is not JSON; keep only the status.
    }
    if (res.status === 409 && (code === "23505" || code === "")) throw new DuplicateRecordError(table);
    if (["23503", "23514", "23502", "P0001"].includes(code)) throw new IntegrityError(table, `rejected by the database (${code})`);
    throw new Error(`Supabase request to ${table} failed with HTTP ${res.status}${code ? ` (${code})` : ""}.`);
  }

  private async one<T>(table: string, column: string, value: string): Promise<T | null> {
    const rows = (await this.request(table, { method: "GET", query: `${column}=eq.${encodeURIComponent(value)}&select=*&limit=1` })) as T[] | null;
    return rows?.[0] ?? null;
  }

  private insert(table: string, row: unknown): Promise<unknown> {
    return this.request(table, { method: "POST", body: row, prefer: "return=minimal" });
  }

  async ensureCase(row: NewCase): Promise<void> {
    await this.request("cases", { method: "POST", body: row, prefer: "resolution=ignore-duplicates,return=minimal" });
  }

  async setCaseStatus(caseId: string, status: CaseStatus): Promise<void> {
    await this.request("cases", { method: "PATCH", query: `case_id=eq.${encodeURIComponent(caseId)}`, body: { status }, prefer: "return=minimal" });
  }

  getCase(caseId: string): Promise<CaseRow | null> {
    return this.one<CaseRow>("cases", "case_id", caseId);
  }

  async insertPlan(row: NewPlan): Promise<void> {
    await this.insert("placement_plans", row);
  }

  getPlan(planId: string): Promise<PlanRow | null> {
    return this.one<PlanRow>("placement_plans", "plan_id", planId);
  }

  async listPlansForCase(caseId: string, limit: number): Promise<PlanRow[]> {
    const rows = (await this.request("placement_plans", {
      method: "GET",
      query: `case_id=eq.${encodeURIComponent(caseId)}&select=*&order=created_at.asc&limit=${safeLimit(limit)}`,
    })) as PlanRow[] | null;
    return rows ?? [];
  }

  async insertMediaAsset(row: NewMediaAsset): Promise<void> {
    await this.insert("media_assets", row);
  }

  async updateMediaAsset(assetId: string, patch: Partial<Omit<NewMediaAsset, "asset_id">>): Promise<void> {
    await this.request("media_assets", { method: "PATCH", query: `asset_id=eq.${encodeURIComponent(assetId)}`, body: patch, prefer: "return=minimal" });
  }

  async getMediaAsset(assetId: string): Promise<MediaAssetRow | null> {
    const row = await this.one<MediaAssetRow>("media_assets", "asset_id", assetId);
    return row ? normalizeMedia(row) : null;
  }

  async listMediaAssetsForPlan(planId: string, kind: MediaKind, limit: number): Promise<MediaAssetRow[]> {
    const rows = (await this.request("media_assets", {
      method: "GET",
      query: `plan_id=eq.${encodeURIComponent(planId)}&kind=eq.${encodeURIComponent(kind)}&select=*&order=created_at.desc&limit=${safeLimit(limit)}`,
    })) as MediaAssetRow[] | null;
    return (rows ?? []).map(normalizeMedia);
  }

  async listSourceFramesForScene(caseId: string, sceneId: string, limit: number): Promise<MediaAssetRow[]> {
    // The scene filter runs in the database (JSON path on provenance), not after a capped fetch.
    const rows = (await this.request("media_assets", {
      method: "GET",
      query:
        `case_id=eq.${encodeURIComponent(caseId)}&kind=eq.source-frame&provenance->>sceneId=eq.${encodeURIComponent(sceneId)}` +
        `&select=*&order=created_at.desc&limit=${safeLimit(limit)}`,
    })) as MediaAssetRow[] | null;
    return (rows ?? []).map(normalizeMedia);
  }

  async insertReview(row: NewReview): Promise<void> {
    await this.insert("governor_reviews", row);
  }

  getReview(reviewId: string): Promise<ReviewRow | null> {
    return this.one<ReviewRow>("governor_reviews", "review_id", reviewId);
  }

  async listReviewsForCase(caseId: string, limit: number): Promise<ReviewRow[]> {
    const rows = (await this.request("governor_reviews", {
      method: "GET",
      query: `case_id=eq.${encodeURIComponent(caseId)}&select=*&order=created_at.desc&limit=${safeLimit(limit)}`,
    })) as ReviewRow[] | null;
    return rows ?? [];
  }

  async insertApproval(row: NewApproval): Promise<void> {
    await this.insert("human_approvals", row);
  }

  getApprovalForReview(reviewId: string): Promise<ApprovalRow | null> {
    return this.one<ApprovalRow>("human_approvals", "review_id", reviewId);
  }

  /** Whether human_approvals has its reasons column (20261017000000_human_approval_reasons.sql). Read-only: selects no rows. */
  async approvalReasonsAvailable(): Promise<boolean> {
    try {
      await this.request("human_approvals", { method: "GET", query: "select=reasons&limit=0" });
      return true;
    } catch {
      return false;
    }
  }

  async insertVisualReview(row: NewVisualReview): Promise<void> {
    await this.insert("media_visual_reviews", row);
  }

  getVisualReview(assetId: string): Promise<VisualReviewRow | null> {
    return this.one<VisualReviewRow>("media_visual_reviews", "asset_id", assetId);
  }
}

/** A positive integer row limit for a query string. */
function safeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid lookup limit.");
  return limit;
}

/** Postgres numeric columns may arrive as strings; normalize before validation. */
function normalizeMedia(row: MediaAssetRow): MediaAssetRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { ...row, duration_seconds: num(row.duration_seconds), latency_ms: num(row.latency_ms), cost_usd: num(row.cost_usd) };
}

/**
 * The production store, built only from server environment variables. Returns
 * null when Supabase is not configured: callers then persist nothing and use
 * NO_GENERATED_PREVIEWS. Never falls back to an in-memory or test store.
 */
export function createWorkflowStoreFromEnv(env: Env, fetchImpl?: Fetch): SupabaseWorkflowStore | null {
  const url = env[SUPABASE_URL_ENV]?.trim();
  const key = env[SUPABASE_SECRET_KEY_ENV]?.trim();
  if (!url || !key) return null;
  return new SupabaseWorkflowStore(url, key, fetchImpl);
}
