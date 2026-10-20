import { createHash } from "node:crypto";
import RunwayML, { toFile } from "@runwayml/sdk";

export const RUNWAY_MODEL = "aleph2" as const;
export const RUNWAY_CREDITS_PER_SECOND = 28;
export const RUNWAY_USD_PER_CREDIT = 0.01;
export const RUNWAY_MAX_COST_USD = 6;
export const RUNWAY_TIMEOUT_MS = 12 * 60 * 1000;
export const RUNWAY_API_KEY_ENV = "RUNWAYML_API_SECRET";

export const ALEPH_EDIT_PROMPT = [
  "Edit only the printed branding on the two existing brown takeaway coffee cups when the cups are visible.",
  "Make both existing cups carry the supplied Daybreak Cold Brew branding, following each cup's surface, perspective, lighting, shadows, focus, motion blur and occlusion.",
  "Preserve the exact original video duration, shot sequence, camera motion, original audio, actors, identities, faces, hands, clothing, expressions, dialogue, table, pastry and background.",
  "Do not add, remove, duplicate or move any cup, product, person, object, logo or text.",
  "Do not modify shots in which the cups are not visible.",
].join(" ");

export type AlephRequest = {
  sourceVideo: Uint8Array;
  referenceImage: Uint8Array;
  durationSeconds: number;
  sourceChecksum: string;
  referenceChecksum: string;
};

export type AlephResult = { taskId: string; estimatedCredits: number; chargedCredits: number; outputUrl: string };

export interface AlephProvider {
  generate(request: AlephRequest): Promise<AlephResult>;
}

export function estimateAlephCost(durationSeconds: number) {
  const credits = Math.ceil(durationSeconds * RUNWAY_CREDITS_PER_SECOND);
  return { credits, usd: credits * RUNWAY_USD_PER_CREDIT };
}

export function preflightProblems(request: Pick<AlephRequest, "durationSeconds" | "sourceChecksum" | "referenceChecksum">): string[] {
  const errors: string[] = [];
  if (request.durationSeconds < 2 || request.durationSeconds > 30) errors.push("Aleph requires a source video from 2 to 30 seconds.");
  for (const [name, value] of [["source", request.sourceChecksum], ["reference", request.referenceChecksum]] as const) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) errors.push(`${name} checksum is invalid.`);
  }
  const cost = estimateAlephCost(request.durationSeconds);
  if (cost.usd > RUNWAY_MAX_COST_USD) errors.push(`Estimated maximum $${cost.usd.toFixed(2)} exceeds the $${RUNWAY_MAX_COST_USD.toFixed(2)} ceiling.`);
  return errors;
}

export const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export class RunwayAlephProvider implements AlephProvider {
  private readonly client: RunwayML;
  constructor(apiKey: string) {
    if (!apiKey.trim()) throw new Error(`${RUNWAY_API_KEY_ENV} is missing.`);
    this.client = new RunwayML({ apiKey });
  }

  async generate(request: AlephRequest): Promise<AlephResult> {
    const video = await this.client.uploads.createEphemeral({ file: await toFile(request.sourceVideo, "source.mp4", { type: "video/mp4" }) });
    const reference = await this.client.uploads.createEphemeral({ file: await toFile(request.referenceImage, "daybreak-reference.png", { type: "image/png" }) });
    const task = this.client.videoToVideo.create({
      model: RUNWAY_MODEL,
      videoUri: video.uri,
      promptText: ALEPH_EDIT_PROMPT,
      outputFormat: "mp4",
      seed: 20261019,
      keyframes: [{ seconds: 8, uri: reference.uri, range: { start_seconds: 4, end_seconds: 15 } }],
    });
    const accepted = await task;
    const maximumUsd = accepted.estimatedCost.credits * RUNWAY_USD_PER_CREDIT;
    if (maximumUsd > RUNWAY_MAX_COST_USD) {
      await this.client.tasks.delete(accepted.id).catch(() => undefined);
      throw new Error(`Runway quoted $${maximumUsd.toFixed(2)}, above the $${RUNWAY_MAX_COST_USD.toFixed(2)} ceiling; the task was cancelled.`);
    }
    const finished = await task.waitForTaskOutput({ timeout: RUNWAY_TIMEOUT_MS });
    const outputUrl = finished.output[0];
    if (!outputUrl || new URL(outputUrl).protocol !== "https:") throw new Error("Runway returned no HTTPS output.");
    return { taskId: finished.id, estimatedCredits: accepted.estimatedCost.credits, chargedCredits: finished.cost.credits, outputUrl };
  }
}
