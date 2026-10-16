/**
 * Registered source frames a placement plan may bind to instead of the
 * title-artwork stand-in. A record here has already been loaded from the
 * persistent registry and revalidated (persistence/workflow.ts); plans can only
 * name frames by their binding fields, never supply a frame themselves.
 */

/** A source frame that passed registry revalidation, with its full provenance chain. */
export type SourceFrameRecord = {
  assetId: string;
  caseId: string;
  titleId: string;
  sceneId: string;
  sourceAssetId: string;
  timestampSeconds: number;
  storageRef: string;
  checksum: string;
  mimeType: string;
};

/** What the registry knows about a scene's frames: one valid frame, an invalid one (fail closed), or none. */
export type SceneFrameState = { valid: SourceFrameRecord | null; invalid: boolean };

/**
 * Synchronous view over revalidated frames, so the synchronous validators can
 * use it. `forScene` returns null when the scene has not been looked up.
 */
export type SourceFrameRegistry = {
  find(assetId: string): SourceFrameRecord | null;
  forScene(caseId: string, sceneId: string): SceneFrameState | null;
};

/** A registry that can load a scene's frames from storage before validation. */
export type RefreshableSourceFrameRegistry = SourceFrameRegistry & { refreshScene(caseId: string, sceneId: string): Promise<SceneFrameState> };

/** The registry when no persistent store is configured: no frames, scenes unknown. */
export const NO_REGISTERED_SOURCE_FRAMES: SourceFrameRegistry = Object.freeze({ find: () => null, forScene: () => null });

/**
 * The provenance-derived visual disclosure for a plan bound to a registered
 * source frame (agents/media/derived-disclosure.ts), loaded before validation.
 * "unedited": no derived media, so SOURCE_FRAME_DISCLOSURE stays truthful.
 * "derived": that exact disclosure replaces it. "invalid": nothing may be said.
 * null: not loaded, so the historical rule applies.
 */
export type VisualDisclosureState = { status: "unedited" } | { status: "derived"; disclosure: string } | { status: "invalid"; errors: string[] };
export type VisualDisclosureRegistry = { find(planId: string): VisualDisclosureState | null };

/** Exact sentence a result must state when its plan binds a registered source frame with no derived media. */
export const SOURCE_FRAME_DISCLOSURE =
  "The current visual is a registered frame extracted from the selected scene; no edit or generation has been run on it.";

export const FRAME_ASSET_ID = /^asset:[a-z0-9-]+:source-frame:[a-z0-9-]+:v[0-9]+$/;
export const SOURCE_VIDEO_ASSET_ID = /^asset:[a-z0-9-]+:source-video:v[0-9]+$/;
/** A private bucket object: storage://<bucket>/<path>, no traversal, no URLs, paths, or data. */
export const PRIVATE_STORAGE_REF = /^storage:\/\/[a-z0-9][a-z0-9-]{1,62}\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,400}$/;
export const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** The exact fields a plan's registered-frame sourceMedia may carry. */
const FRAME_FIELDS = ["kind", "isSceneFrame", "assetId", "storageRef", "checksum", "sourceAssetId", "timestampSeconds", "note"].sort().join(",");

/**
 * Validates a plan's registered-frame binding against the registry and the
 * plan's own case, title, and recorded scene window. Every field must match
 * the revalidated registry record exactly; nothing the caller supplies is
 * trusted on its own.
 */
export function validateFrameBinding(
  media: Record<string, unknown>,
  plan: { caseId: unknown; titleId: unknown; sceneId: unknown },
  window: { startSeconds: number; endSeconds: number } | undefined,
  frames: SourceFrameRegistry,
): string[] {
  const e: string[] = [];
  if (Object.keys(media).sort().join(",") !== FRAME_FIELDS) e.push(`artifact.sourceMedia for a registered frame must have exactly: ${FRAME_FIELDS}.`);
  if (media.isSceneFrame !== true) e.push("artifact.sourceMedia.isSceneFrame must be true for a registered frame.");
  if (media.note !== SOURCE_FRAME_DISCLOSURE) e.push(`artifact.sourceMedia.note must be exactly: "${SOURCE_FRAME_DISCLOSURE}"`);
  const assetId = typeof media.assetId === "string" ? media.assetId : "";
  if (!FRAME_ASSET_ID.test(assetId)) e.push("artifact.sourceMedia.assetId must be a registered source-frame asset ID.");
  if (typeof media.storageRef !== "string" || !PRIVATE_STORAGE_REF.test(media.storageRef)) {
    e.push("artifact.sourceMedia.storageRef must be a private storage:// reference; URLs, file paths, and inline data are not accepted.");
  }
  if (typeof media.checksum !== "string" || !SHA256.test(media.checksum)) e.push("artifact.sourceMedia.checksum must be sha256:<64 hex characters>.");
  if (typeof media.sourceAssetId !== "string" || !SOURCE_VIDEO_ASSET_ID.test(media.sourceAssetId)) e.push("artifact.sourceMedia.sourceAssetId must be a source-video asset ID.");
  if (typeof media.timestampSeconds !== "number" || !Number.isFinite(media.timestampSeconds)) e.push("artifact.sourceMedia.timestampSeconds must be a number.");
  if (e.length > 0) return e;

  const record = frames.find(assetId);
  if (!record) return [`Source frame ${assetId} is not a registered, revalidated frame; the plan cannot use it.`];
  if (record.caseId !== plan.caseId) e.push("The source frame belongs to another case.");
  if (record.titleId !== plan.titleId) e.push("The source frame belongs to another title.");
  if (record.sceneId !== plan.sceneId) e.push("The source frame was not extracted from the selected scene.");
  if (record.sourceAssetId !== media.sourceAssetId) e.push("artifact.sourceMedia.sourceAssetId does not match the frame's registered source video.");
  if (record.storageRef !== media.storageRef) e.push("artifact.sourceMedia.storageRef does not match the registered frame.");
  if (record.checksum !== media.checksum) e.push("artifact.sourceMedia.checksum does not match the registered frame.");
  if (record.timestampSeconds !== media.timestampSeconds) e.push("artifact.sourceMedia.timestampSeconds does not match the registered frame.");
  if (!window || record.timestampSeconds < window.startSeconds || record.timestampSeconds > window.endSeconds) {
    e.push("The source frame's timestamp is outside the selected scene window.");
  }
  return e;
}
