import { GoogleGenAI } from "@google/genai";

/**
 * Server-only Gemini image-edit provider (Nano Banana), via the official
 * @google/genai SDK's Interactions API. Reads only GEMINI_API_KEY, never logs
 * it, and never returns it in errors. Never import from app/, components/, or lib/.
 */

/** Current documented Nano Banana image-edit model (ai.gemini docs: stable, released 2026-10-06). */
export const GEMINI_IMAGE_EDIT_MODEL = "gemini-nano-banana-2.1";
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

export type ProviderImage = { mimeType: string; data: Uint8Array };
export type ProviderUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
export type ProviderEditResult = { responseId: string | null; images: ProviderImage[]; text: string | null; usage: ProviderUsage | null };

/** One image edit: input pixels plus prompt in, a parsed provider result out. */
export interface ImageEditProvider {
  readonly provider: "google-gemini";
  readonly model: string;
  edit(input: { image: Uint8Array; mimeType: string; prompt: string }, options: { timeoutMs: number }): Promise<ProviderEditResult>;
}

/** Raised for any provider-side failure. Its message never includes request data or credentials. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses an Interactions API response into images. Image blocks are read from
 * model_output steps; output_image is used only when no step carries an image
 * (it duplicates the last one otherwise). Inline base64 data is required.
 */
export function parseInteraction(interaction: unknown): ProviderEditResult {
  if (typeof interaction !== "object" || interaction === null) throw new ProviderError("Malformed provider response.");
  const it = interaction as Record<string, unknown>;
  if (it.status !== undefined && it.status !== "completed") throw new ProviderError(`Provider interaction did not complete (status ${String(it.status).slice(0, 30)}).`);
  const blocks: Record<string, unknown>[] = [];
  for (const step of Array.isArray(it.steps) ? it.steps : []) {
    const s = step as Record<string, unknown>;
    if (s?.type !== "model_output") continue;
    if (s.error) throw new ProviderError("Provider reported an error in its output.");
    for (const c of Array.isArray(s.content) ? s.content : []) if ((c as Record<string, unknown>)?.type === "image") blocks.push(c as Record<string, unknown>);
  }
  if (blocks.length === 0 && it.output_image && typeof it.output_image === "object") blocks.push(it.output_image as Record<string, unknown>);
  const images = blocks.map((b) => {
    if (typeof b.data !== "string" || b.data.length === 0 || !BASE64.test(b.data)) throw new ProviderError("Provider image is missing inline base64 data.");
    return { mimeType: typeof b.mime_type === "string" ? b.mime_type : "application/octet-stream", data: new Uint8Array(Buffer.from(b.data, "base64")) };
  });
  const usage = it.usage && typeof it.usage === "object" ? (it.usage as Record<string, unknown>) : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    responseId: typeof it.id === "string" && it.id.trim() ? it.id : null,
    images,
    text: typeof it.output_text === "string" && it.output_text.trim() ? it.output_text : null,
    usage: usage ? { inputTokens: num(usage.total_input_tokens), outputTokens: num(usage.total_output_tokens), totalTokens: num(usage.total_tokens) } : null,
  };
}

/** The production Gemini provider. The API key stays inside the SDK client. */
export class GeminiImageEditProvider implements ImageEditProvider {
  readonly provider = "google-gemini" as const;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, readonly model: string = GEMINI_IMAGE_EDIT_MODEL) {
    if (!apiKey.trim()) throw new ProviderError(`${GEMINI_API_KEY_ENV} is not set.`);
    this.client = new GoogleGenAI({ apiKey });
  }

  async edit(input: { image: Uint8Array; mimeType: string; prompt: string }, options: { timeoutMs: number }): Promise<ProviderEditResult> {
    let interaction: unknown;
    try {
      interaction = await this.client.interactions.create(
        {
          model: this.model,
          input: [
            { type: "text", text: input.prompt },
            { type: "image", mime_type: input.mimeType, data: Buffer.from(input.image).toString("base64") },
          ],
          response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
        } as never,
        { timeout: options.timeoutMs, maxRetries: 0 },
      );
    } catch (error) {
      // Report only the error class and HTTP status, never request contents or headers.
      const status = (error as { status?: unknown })?.status;
      throw new ProviderError(`Gemini request failed (${error instanceof Error ? error.name : "error"}${typeof status === "number" ? `, HTTP ${status}` : ""}).`);
    }
    return parseInteraction(interaction);
  }
}

/** The production provider from server env, or null when GEMINI_API_KEY is not set. */
export function createGeminiProviderFromEnv(env: Record<string, string | undefined>): GeminiImageEditProvider | null {
  const key = env[GEMINI_API_KEY_ENV]?.trim();
  return key ? new GeminiImageEditProvider(key) : null;
}
