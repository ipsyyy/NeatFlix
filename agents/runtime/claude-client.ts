import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicAdapterOptions } from "@band-ai/sdk";
import type { AgentRole } from "@/agents/config/roles";

/** Metadata about one completed Claude call. Never contains prompts, outputs, or reasoning. */
export type ClaudeCallRecord = {
  role: AgentRole;
  model: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  at: string;
};

export type ClaudeCallListener = (record: ClaudeCallRecord) => void;

type ClaudeClientFactory = NonNullable<AnthropicAdapterOptions["clientFactory"]>;
type ClaudeClient = Awaited<ReturnType<ClaudeClientFactory>>;
type ClaudeResponse = Awaited<ReturnType<ClaudeClient["messages"]["create"]>>;

/**
 * Client factory for the BAND Anthropic adapter: the official Anthropic SDK
 * client, with each completed `messages.create` reported as metadata only.
 */
export function instrumentedClaudeFactory(
  role: AgentRole,
  onCall: ClaudeCallListener,
): ClaudeClientFactory {
  return async ({ apiKey }) => {
    const client = new Anthropic({ apiKey });
    return {
      messages: {
        create: async (params, options) => {
          const started = Date.now();
          const response = await client.messages.create(
            params as unknown as Anthropic.MessageCreateParamsNonStreaming,
            options,
          );
          onCall({
            role,
            model: response.model,
            stopReason: response.stop_reason,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            durationMs: Date.now() - started,
            at: new Date().toISOString(),
          });
          return response as unknown as ClaudeResponse;
        },
      },
    };
  };
}
