import { randomUUID } from "node:crypto";
import type { HandoffEnvelope, ValidationResult } from "@/agents/handoff/envelope";
import { NO_GENERATED_PREVIEWS, validateGovernorReview, type GovernorReview, type PreviewRecord, type PreviewRegistry } from "@/agents/handoff/governor-review";
import { approvalReasonErrors, isRecordedApproval, type HumanApproval } from "@/agents/handoff/human-approval";
import { validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { validateOutgoing } from "@/agents/handoff/protocol";
import {
  FRAME_ASSET_ID,
  NO_REGISTERED_SOURCE_FRAMES,
  PRIVATE_STORAGE_REF,
  type SceneFrameState,
  type SourceFrameRecord,
  type SourceFrameRegistry,
} from "@/agents/handoff/source-frames";
import { getSceneReview } from "@/data/scene-candidates";
import {
  DuplicateRecordError,
  MEDIA_KINDS,
  REGISTRY_LOOKUP_CAP,
  type CaseStatus,
  type MediaAssetRow,
  type MediaKind,
  type NewMediaAsset,
  type PlanRow,
  type WorkflowStore,
} from "./store";

/**
 * Trust layer over a WorkflowStore. Every record is validated with
 * NativeFrame's runtime validators before it is written, and every row is
 * revalidated after it is read: a database row alone is never trusted evidence.
 */

export const STORAGE_REF = /^(https:\/\/\S+|storage:\/\/\S+)$/;
export const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
export const ASSET_ID = /^asset:[A-Za-z0-9:._-]{1,190}$/;
const MIME_FOR_KIND: Record<MediaKind, RegExp> = {
  "source-video": /^video\/[a-z0-9.+-]+$/,
  "source-frame": /^image\/[a-z0-9.+-]+$/,
  "edited-still": /^image\/[a-z0-9.+-]+$/,
  "generated-preview": /^video\/[a-z0-9.+-]+$/,
  "full-scene-video": /^video\/mp4$/,
};

type Result<T> = ValidationResult<T>;
const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isoUtc = (v: unknown): string | null => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return null;
  return new Date(v).toISOString();
};
/** Canonical JSON with sorted keys, so stored and received documents compare by content. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const planVersion = (planId: string) => Number(/:v(\d+)$/.exec(planId)?.[1] ?? NaN);

/** Input for registering a media asset. Binaries stay in object storage; only the reference is recorded. */
export type MediaAssetInput = {
  assetId?: string;
  caseId: string;
  planId?: string | null;
  kind: MediaKind;
  storageRef: string;
  mimeType: string;
  durationSeconds?: number | null;
  generator?: string | null;
  model?: string | null;
  generatedAt?: string | null;
  latencyMs?: number | null;
  costUsd?: number | null;
  checksum: string;
  provenance: Record<string, unknown>;
};

/** Validates a media asset row, whether about to be written or just read back. */
export function validateMediaRow(row: unknown): string[] {
  if (!isObj(row)) return ["Media asset must be an object."];
  const e: string[] = [];
  const kind = row.kind as MediaKind;
  if (!str(row.asset_id, 200) || !ASSET_ID.test(row.asset_id)) e.push("asset_id must look like asset:<id>.");
  if (!str(row.case_id, 100)) e.push("case_id is required.");
  if (!MEDIA_KINDS.includes(kind)) e.push(`kind must be one of: ${MEDIA_KINDS.join(", ")}.`);
  if (!str(row.storage_ref) || !STORAGE_REF.test(row.storage_ref)) e.push("storage_ref must be an https:// or storage:// reference.");
  if (!str(row.mime_type, 100) || (MEDIA_KINDS.includes(kind) && !MIME_FOR_KIND[kind].test(row.mime_type))) e.push("mime_type does not match the asset kind.");
  if (row.duration_seconds != null && !(typeof row.duration_seconds === "number" && row.duration_seconds > 0)) e.push("duration_seconds must be positive.");
  if (!str(row.checksum, 80) || !CHECKSUM.test(row.checksum)) e.push("checksum must be sha256:<64 hex characters>.");
  if (!isObj(row.provenance)) e.push("provenance must be an object.");
  if (row.latency_ms != null && !(Number.isInteger(row.latency_ms) && (row.latency_ms as number) >= 0)) e.push("latency_ms must be a non-negative integer.");
  if (row.cost_usd != null && !(typeof row.cost_usd === "number" && row.cost_usd >= 0)) e.push("cost_usd must be non-negative.");
  if (row.generated_at != null && !isoUtc(row.generated_at)) e.push("generated_at must be a timestamp.");

  if (kind === "generated-preview" || kind === "full-scene-video") {
    const prov = isObj(row.provenance) ? row.provenance : {};
    const what = kind === "generated-preview" ? "A generated preview" : "A full-scene video";
    if (!str(row.plan_id, 200)) e.push(`${what} must name its plan_id.`);
    if (!str(row.generator, 120) || !str(row.model, 120)) e.push(`${what} needs generator and model.`);
    if (!isoUtc(row.generated_at)) e.push(`${what} needs generated_at.`);
    if (row.latency_ms == null || row.cost_usd == null) e.push(`${what} needs latency_ms and cost_usd.`);
    if (kind === "full-scene-video" && row.duration_seconds == null) e.push("A full-scene video needs duration_seconds.");
    if (prov.inputPlanId !== row.plan_id) e.push("provenance.inputPlanId must equal plan_id.");
    if (prov.generator !== row.generator) e.push("provenance.generator must equal generator.");
    if (isoUtc(prov.generatedAt) === null || isoUtc(prov.generatedAt) !== isoUtc(row.generated_at)) e.push("provenance.generatedAt must equal generated_at.");
  }
  return e;
}

export class WorkflowRegistry {
  constructor(private readonly store: WorkflowStore) {}

  /** Persists a validated placement plan. The same plan again is accepted once; a different plan under its ID is refused. */
  async savePlan(input: unknown): Promise<Result<{ planId: string; created: boolean }>> {
    const errors = validatePlacementPlan(input, undefined, await this.frameRegistryFor(input));
    if (errors.length > 0) return fail(...errors);
    const plan = input as PlacementPlan;
    const same = async (): Promise<Result<{ planId: string; created: boolean }>> => {
      const stored = await this.loadPlan(plan.planId);
      if (!stored.ok) return fail(`A plan is already stored under ${plan.planId} but it does not revalidate.`, ...stored.errors);
      return canonical(stored.value) === canonical(plan)
        ? { ok: true, value: { planId: plan.planId, created: false } }
        : fail(`A different plan is already stored under ${plan.planId}; plans are immutable.`);
    };
    if (await this.store.getPlan(plan.planId)) return same();

    const row: Omit<PlanRow, "created_at"> = {
      plan_id: plan.planId,
      case_id: plan.caseId,
      title_id: plan.sourceArtifacts.titleId,
      scene_id: plan.scene.sceneId,
      campaign_id: plan.product.campaignId,
      version: planVersion(plan.planId),
      plan,
      validation_status: "valid",
    };
    if (!Number.isInteger(row.version) || row.version < 1) return fail("planId must end with :v<version>.");
    // A case belongs to one title: never attach another title's plan to an existing case.
    const existingCase = await this.store.getCase(plan.caseId);
    if (existingCase && existingCase.title_id !== row.title_id) return fail(`Case ${plan.caseId} belongs to another title; its plans must be for ${existingCase.title_id}.`);
    await this.store.ensureCase({ case_id: plan.caseId, title_id: row.title_id, status: "open" });
    const ensured = await this.store.getCase(plan.caseId);
    if (!ensured || ensured.title_id !== row.title_id) return fail(`Case ${plan.caseId} belongs to another title.`);
    try {
      await this.store.insertPlan(row);
    } catch (error) {
      if (error instanceof DuplicateRecordError) return same();
      throw error;
    }
    return { ok: true, value: { planId: plan.planId, created: true } };
  }

  /** Reads a plan and revalidates the stored document and its columns. */
  async loadPlan(planId: string): Promise<Result<PlacementPlan>> {
    const row = await this.store.getPlan(planId);
    if (!row) return fail(`No plan is stored under ${planId}.`);
    const errors = validatePlacementPlan(row.plan, row.case_id, await this.frameRegistryFor(row.plan));
    if (errors.length > 0) return fail(...errors);
    const plan = row.plan as PlacementPlan;
    if (
      row.validation_status !== "valid" ||
      row.plan_id !== planId ||
      plan.planId !== planId ||
      plan.sourceArtifacts.titleId !== row.title_id ||
      plan.scene.sceneId !== row.scene_id ||
      plan.product.campaignId !== row.campaign_id ||
      planVersion(planId) !== row.version
    ) {
      return fail("Stored plan columns do not match its document.");
    }
    return { ok: true, value: structuredClone(plan) };
  }

  /** Registers a media asset (server-side only). Binaries are never stored here. */
  async registerMediaAsset(input: MediaAssetInput): Promise<Result<{ assetId: string }>> {
    const row: NewMediaAsset = {
      asset_id: input.assetId ?? `asset:${input.kind}:${randomUUID()}`,
      case_id: input.caseId,
      plan_id: input.planId ?? null,
      kind: input.kind,
      storage_ref: input.storageRef,
      mime_type: input.mimeType,
      duration_seconds: input.durationSeconds ?? null,
      generator: input.generator ?? null,
      model: input.model ?? null,
      generated_at: input.generatedAt ? isoUtc(input.generatedAt) : null,
      latency_ms: input.latencyMs ?? null,
      cost_usd: input.costUsd ?? null,
      checksum: input.checksum,
      provenance: input.provenance,
    };
    const errors = validateMediaRow(row);
    if (errors.length > 0) return fail(...errors);
    if (row.plan_id) {
      const plan = await this.loadPlan(row.plan_id);
      if (!plan.ok) return fail(`Media must reference a stored, valid plan: ${plan.errors[0]}`);
      if (plan.value.caseId !== row.case_id) return fail("Media case_id must match its plan's case.");
    } else if (!(await this.store.getCase(row.case_id))) {
      return fail("Media must reference an existing case.");
    }
    try {
      await this.store.insertMediaAsset(row);
    } catch (error) {
      if (error instanceof DuplicateRecordError) return fail("A media asset with that ID or storage reference is already registered.");
      throw error;
    }
    return { ok: true, value: { assetId: row.asset_id } };
  }

  /**
   * Loads a registered source frame and revalidates its whole provenance chain:
   * the media row itself, a private storage reference, the registered source
   * video it cites (same case, same storage reference and checksum), the title
   * through that video and the case, and an extraction timestamp inside the
   * recorded scene window. Nothing is trusted from the row alone.
   */
  async loadSourceFrame(assetId: string): Promise<Result<SourceFrameRecord>> {
    if (!FRAME_ASSET_ID.test(assetId)) return fail("Not a source-frame asset ID.");
    const row = await this.store.getMediaAsset(assetId);
    if (!row) return fail(`No source frame is registered as ${assetId}.`);
    const errors = validateMediaRow(row);
    if (row.kind !== "source-frame") errors.push("Asset is not a source frame.");
    if (!PRIVATE_STORAGE_REF.test(row.storage_ref)) errors.push("Source frame must use a private storage:// reference.");
    if (errors.length > 0) return fail(...errors);
    const prov = row.provenance as Record<string, unknown>;
    const sourceAssetId = typeof prov.sourceAssetId === "string" ? prov.sourceAssetId : "";
    const sceneId = typeof prov.sceneId === "string" ? prov.sceneId : "";
    const timestampSeconds = prov.timestampSeconds;
    if (!sourceAssetId || !sceneId || typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) {
      return fail("Source frame provenance must cite sourceAssetId, sceneId, and timestampSeconds.");
    }
    const source = await this.store.getMediaAsset(sourceAssetId);
    if (!source || source.kind !== "source-video" || validateMediaRow(source).length > 0) return fail("Source frame cites a missing or invalid source video.");
    if (source.case_id !== row.case_id) return fail("Source frame and its source video belong to different cases.");
    if (prov.sourceStorageRef !== source.storage_ref || prov.sourceChecksum !== source.checksum) return fail("Source frame provenance does not match its registered source video.");
    const titleId = (source.provenance as Record<string, unknown>).titleId;
    const caseRow = await this.store.getCase(row.case_id);
    if (typeof titleId !== "string" || !caseRow || caseRow.title_id !== titleId) return fail("Source frame's title does not match its case.");
    const scene = getSceneReview(titleId)?.scenes.find((s) => s.id === sceneId);
    if (!scene) return fail("Source frame cites a scene that is not recorded for its title.");
    if (timestampSeconds < scene.startSeconds || timestampSeconds > scene.endSeconds) return fail("Source frame timestamp is outside its scene window.");
    return {
      ok: true,
      value: { assetId, caseId: row.case_id, titleId, sceneId, sourceAssetId, timestampSeconds, storageRef: row.storage_ref, checksum: row.checksum, mimeType: row.mime_type },
    };
  }

  /** A scene's registered frames: exactly one valid frame, invalid (any frame fails, or several), or none. */
  async loadSourceFramesForScene(caseId: string, sceneId: string): Promise<SceneFrameState> {
    const rows = await this.store.listSourceFramesForScene(caseId, sceneId, REGISTRY_LOOKUP_CAP + 1);
    // More than the cap means the result may be truncated: fail closed, choose nothing.
    if (rows.length > REGISTRY_LOOKUP_CAP) return { valid: null, invalid: true };
    // Defense in depth: the store filtered these; reject the lookup if any row disagrees.
    if (rows.some((r) => r.case_id !== caseId || r.kind !== "source-frame" || (r.provenance as Record<string, unknown> | null)?.sceneId !== sceneId)) {
      return { valid: null, invalid: true };
    }
    if (rows.length === 0) return { valid: null, invalid: false };
    const loaded = await Promise.all(rows.map((r) => this.loadSourceFrame(r.asset_id)));
    const valid = loaded.filter((r) => r.ok).map((r) => (r as { ok: true; value: SourceFrameRecord }).value);
    if (valid.length !== 1 || loaded.some((r) => !r.ok)) return { valid: null, invalid: true };
    return { valid: valid[0], invalid: false };
  }

  /** A one-scene registry snapshot for validating a stored or incoming plan. */
  private async frameRegistryFor(plan: unknown): Promise<SourceFrameRegistry> {
    if (!isObj(plan) || typeof plan.caseId !== "string" || !isObj(plan.scene) || typeof plan.scene.sceneId !== "string") return NO_REGISTERED_SOURCE_FRAMES;
    return staticFrameRegistry(plan.caseId, plan.scene.sceneId, await this.loadSourceFramesForScene(plan.caseId, plan.scene.sceneId));
  }

  /** The newest generated preview for a plan that revalidates, or why none does. */
  async loadGeneratedPreview(planId: string): Promise<Result<PreviewRecord & { assetId: string }>> {
    const plan = await this.loadPlan(planId);
    if (!plan.ok) return fail(`The preview's plan does not revalidate: ${plan.errors[0]}`);
    const fetched = await this.store.listMediaAssetsForPlan(planId, "generated-preview", REGISTRY_LOOKUP_CAP + 1);
    // Never choose from a truncated result.
    if (fetched.length > REGISTRY_LOOKUP_CAP) return fail(`More than ${REGISTRY_LOOKUP_CAP} previews are registered for ${planId}; refusing to choose from a truncated lookup.`);
    // Until previews are selected by asset ID, never choose between several: a fallback must not stand in silently.
    if (fetched.length > 1) return fail(`${fetched.length} previews are registered for ${planId}; select one by asset ID before review.`);
    const rows = [...fetched].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const problems: string[] = [];
    for (const row of rows) {
      const errors = validateMediaRow(row);
      if (row.kind !== "generated-preview" || row.plan_id !== planId) errors.push("Row is not a generated preview of this plan.");
      if (row.case_id !== plan.value.caseId) errors.push("Preview case does not match its plan.");
      if (errors.length > 0) {
        problems.push(`${row.asset_id}: ${errors.join(" ")}`);
        continue;
      }
      return { ok: true, value: toPreviewRecord(row) };
    }
    return fail(rows.length === 0 ? `No generated preview is registered for ${planId}.` : `No registered preview revalidates: ${problems.join("; ")}`);
  }

  /**
   * Persists a Release Governor handoff's review after validating the whole
   * handoff against the persisted preview (if any). Reviews are append-only.
   */
  async saveGovernorReview(handoff: unknown): Promise<Result<{ reviewId: string }>> {
    const planId = isObj(handoff) && typeof handoff.artifactId === "string" ? handoff.artifactId : "";
    const preview = await this.loadGeneratedPreview(planId);
    const previews = snapshotRegistry(preview.ok ? preview.value : null);
    const checked = validateOutgoing(handoff, { previews });
    if (!checked.ok) return checked;
    const env: HandoffEnvelope = checked.value;
    if (env.senderRole !== "release-governor" || env.artifact?.kind !== "governor-review") return fail("Only a Release Governor handoff with its review can be stored.");
    const review: GovernorReview = env.artifact;
    const plan = await this.loadPlan(review.subject.planId);
    if (!plan.ok) return fail(`The reviewed plan is not stored and valid: ${plan.errors[0]}`);
    // Case isolation: the reviewed plan must belong to the handoff's case.
    if (plan.value.caseId !== env.caseId || review.caseId !== env.caseId) return fail("The reviewed plan belongs to another case.");
    const previewAssetId = review.preview.status === "provided" && preview.ok ? preview.value.assetId : null;
    if (review.preview.status === "provided" && !previewAssetId) return fail("The review's preview is not a registered generated preview.");
    if (previewAssetId) {
      const asset = await this.store.getMediaAsset(previewAssetId);
      if (!asset || asset.case_id !== env.caseId || asset.plan_id !== review.subject.planId) return fail("The review's preview belongs to another case or plan.");
    }
    try {
      await this.store.insertReview({
        review_id: review.reviewId,
        case_id: env.caseId,
        plan_id: review.subject.planId,
        preview_asset_id: previewAssetId,
        decision: review.decision,
        review,
      });
    } catch (error) {
      if (error instanceof DuplicateRecordError) return fail(`Review ${review.reviewId} is already stored; reviews are immutable.`);
      throw error;
    }
    const status: CaseStatus = review.decision === "revise" ? "revise-requested" : review.decision === "stop" ? "stopped" : "awaiting-human-review";
    await this.store.setCaseStatus(env.caseId, status);
    return { ok: true, value: { reviewId: review.reviewId } };
  }

  /**
   * Persists a human approval with its reasons. It must be a record created by
   * recordHumanApproval (or recordHumanApprovalOfStoredReview) for the
   * authenticated owner, for a stored and revalidated approve-for-human-review
   * whose case is awaiting human review. A replayed approval is refused. The
   * store moves the case to approved atomically with the insert.
   */
  async saveHumanApproval(approval: HumanApproval, reasons: readonly string[]): Promise<Result<{ reviewId: string }>> {
    if (!isRecordedApproval(approval)) return fail("Human approval was not recorded by the authenticated human owner.");
    const reasonErrors = approvalReasonErrors(reasons);
    if (reasonErrors.length > 0) return fail(...reasonErrors);
    const row = await this.store.getReview(approval.reviewId);
    if (!row) return fail("The approved review is not stored.");
    const preview = await this.loadGeneratedPreview(row.plan_id);
    const errors = validateGovernorReview(row.review, { caseId: row.case_id, decision: row.decision, artifactId: row.plan_id }, snapshotRegistry(preview.ok ? preview.value : null));
    if (errors.length > 0) return fail("The stored review does not revalidate.", ...errors);
    if (row.decision !== "approve-for-human-review" || !row.preview_asset_id) return fail("Only an approve-for-human-review with a preview can be approved.");
    if (!preview.ok || preview.value.assetId !== row.preview_asset_id) return fail("The approved preview is not the registered preview for this plan.");
    if (approval.caseId !== row.case_id || approval.artifactId !== row.plan_id) return fail("Human approval does not match the stored review.");
    // Case isolation: the review's plan and preview must belong to the approval's case.
    const plan = await this.loadPlan(row.plan_id);
    const asset = await this.store.getMediaAsset(row.preview_asset_id);
    if (!plan.ok || plan.value.caseId !== row.case_id || (row.review as GovernorReview).caseId !== row.case_id) {
      return fail("The approved review's plan belongs to another case.");
    }
    if (!asset || asset.case_id !== row.case_id || asset.plan_id !== row.plan_id) return fail("The approved preview belongs to another case or plan.");
    if (await this.store.getApprovalForReview(row.review_id)) return fail("This review has already been approved; approvals cannot be replayed.");
    if ((await this.store.getCase(row.case_id))?.status !== "awaiting-human-review") return fail("The case is not awaiting human review.");
    try {
      await this.store.insertApproval({
        approval_id: randomUUID(),
        case_id: row.case_id,
        review_id: row.review_id,
        preview_asset_id: row.preview_asset_id,
        reviewer_user_id: approval.approverUserId,
        reviewer_name: approval.approverName,
        decision: "approve",
        reasons: [...reasons],
      });
    } catch (error) {
      if (error instanceof DuplicateRecordError) return fail("This review has already been approved; approvals cannot be replayed.");
      throw error;
    }
    if ((await this.store.getCase(row.case_id))?.status !== "approved") return fail("The approval was stored but the case did not move to approved.");
    return { ok: true, value: { reviewId: row.review_id } };
  }
}

function toPreviewRecord(row: MediaAssetRow): PreviewRecord & { assetId: string } {
  const generatedAt = isoUtc(row.generated_at)!;
  return {
    assetId: row.asset_id,
    planId: row.plan_id!,
    assetRef: row.storage_ref,
    provenance: { generator: row.generator!, generatedAt, inputPlanId: row.plan_id! },
    generationMetadata: { model: row.model!, latencyMs: row.latency_ms!, costUsd: Number(row.cost_usd) },
  };
}

/** A read-only frame registry for one scene's already-revalidated state. */
export function staticFrameRegistry(caseId: string, sceneId: string, state: SceneFrameState): SourceFrameRegistry {
  const frozen = structuredClone(state);
  return Object.freeze({
    find: (assetId: string) => (frozen.valid && frozen.valid.assetId === assetId ? structuredClone(frozen.valid) : null),
    forScene: (c: string, s: string) => (c === caseId && s === sceneId ? structuredClone(frozen) : null),
  });
}

/** A read-only registry holding at most one already-validated preview. */
function snapshotRegistry(record: PreviewRecord | null): PreviewRegistry {
  if (!record) return NO_GENERATED_PREVIEWS;
  const frozen = structuredClone(record);
  return Object.freeze({ find: (planId: string) => (planId === frozen.planId ? structuredClone(frozen) : null) });
}

/**
 * Release Governor's preview registry backed by persistence. Lookups are
 * synchronous (the validators are), so previews are loaded and revalidated by
 * refresh() at the authenticated boundary; find() returns only those.
 */
export class PersistentPreviewRegistry implements PreviewRegistry {
  private readonly cache = new Map<string, PreviewRecord>();

  constructor(private readonly workflow: WorkflowRegistry) {}

  async refresh(planId: string): Promise<PreviewRecord | null> {
    const result = await this.workflow.loadGeneratedPreview(planId);
    if (!result.ok) {
      this.cache.delete(planId);
      return null;
    }
    const { assetId: _assetId, ...record } = result.value;
    void _assetId;
    this.cache.set(planId, record);
    return structuredClone(record);
  }

  find(planId: string): PreviewRecord | null {
    const record = this.cache.get(planId);
    return record ? structuredClone(record) : null;
  }
}
