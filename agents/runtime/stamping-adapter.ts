import { AnthropicAdapter, type AnthropicAdapterOptions } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { extractHandoffs } from "@/agents/handoff/protocol";
import { stampOutgoingContent } from "@/agents/handoff/stamp";

type AdapterTools = Parameters<AnthropicAdapter["onMessage"]>[1];

const SEND_TOOL = "band_send_message";

/**
 * Platform tools the model may call besides band_send_message. Both are
 * read-only or post nothing. Every other platform tool — band_send_event
 * (thoughts, status), participant, room, contact, and memory tools — is
 * refused at the send boundary regardless of what the prompt says.
 */
export const PERMITTED_PLATFORM_TOOLS: ReadonlySet<string> = new Set(["band_get_participants", "band_no_reply"]);

/** The only room event type that may be posted: the SDK's own error reports. */
const PERMITTED_EVENT_TYPE = "error";

function refusal(errorType: string, toolName: string, message: string) {
  return { ok: false, errorType, toolName, message };
}

/** Error returned to the model when its handoff fails validation at the send boundary. */
export function handoffSendError(errors: string[]) {
  return refusal("HandoffValidationError", SEND_TOOL, `Handoff not sent. Fix and resend: ${errors.join(" ")}`);
}

/**
 * Wraps the BAND tools for one turn so every outgoing post is checked at the
 * send boundary, in code rather than by prompt:
 * - band_send_message must carry exactly one handoff; it is stamped with the
 *   runtime timestamp (overwriting any model-written one) and fully validated.
 * - band_send_event and all other platform tools except PERMITTED_PLATFORM_TOOLS
 *   are refused; nothing is posted.
 * - Direct SDK sends: error events and failure reports pass; other events and
 *   notices are suppressed; messages without a valid handoff are refused.
 */
export function withHandoffStamping<T extends object>(tools: T, logger: Logger, clock: () => Date = () => new Date()): T {
  const prepare = (content: string) => {
    const handoffs = extractHandoffs(content).length;
    if (handoffs !== 1) {
      return {
        ok: false as const,
        errors: [`A NativeFrame message must contain exactly one ${handoffs === 0 ? "handoff; plain text is not posted" : "handoff, not several"}.`],
      };
    }
    const result = stampOutgoingContent(content, clock());
    if (result.ok && result.timestamp) {
      logger.info("Stamped handoff at send boundary", { timestamp: result.timestamp, handoffs: result.handoffs });
    }
    return result;
  };

  return new Proxy(tools, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;

      if (prop === "executeToolCall") {
        return async (name: string, args: Record<string, unknown>) => {
          if (name === SEND_TOOL) {
            const prepared = prepare(typeof args?.content === "string" ? args.content : "");
            if (!prepared.ok) {
              logger.warn("Blocked message at send boundary", { tool: name, errors: prepared.errors });
              return handoffSendError(prepared.errors);
            }
            return value.call(target, name, { ...args, content: prepared.content });
          }
          if (PERMITTED_PLATFORM_TOOLS.has(name)) return value.call(target, name, args);
          logger.warn("Blocked platform tool at send boundary", { tool: String(name).slice(0, 60) });
          return refusal(
            "ToolNotPermitted",
            String(name),
            `${String(name)} is not available to NativeFrame agents. Post only your result and its handoff with ${SEND_TOOL}.`,
          );
        };
      }

      if (prop === "sendMessage") {
        return async (content: string, ...rest: unknown[]) => {
          const prepared = prepare(content);
          if (!prepared.ok) {
            logger.warn("Blocked message at send boundary", { path: "sendMessage", errors: prepared.errors });
            throw new Error("Message failed validation at the send boundary and was not sent.");
          }
          return value.call(target, prepared.content, ...rest);
        };
      }

      if (prop === "sendNotice") {
        return async () => {
          logger.info("Suppressed notice at send boundary");
          return { ok: false, status: "suppressed" };
        };
      }

      if (prop === "sendEvent") {
        return async (content: string, messageType: string, ...rest: unknown[]) => {
          if (messageType === PERMITTED_EVENT_TYPE) return value.call(target, content, messageType, ...rest);
          logger.info("Suppressed event at send boundary", { messageType: String(messageType).slice(0, 30) });
          return { ok: false, status: "suppressed" };
        };
      }

      return value.bind(target);
    },
  });
}

/** BAND's Anthropic adapter with the NativeFrame send boundary applied on every turn. */
export class StampingAnthropicAdapter extends AnthropicAdapter {
  private readonly stampLogger: Logger;

  constructor(options: AnthropicAdapterOptions & { logger: Logger }) {
    super(options);
    this.stampLogger = options.logger;
  }

  override async onMessage(...args: Parameters<AnthropicAdapter["onMessage"]>): ReturnType<AnthropicAdapter["onMessage"]> {
    const [message, tools, ...rest] = args;
    return super.onMessage(message, withHandoffStamping<AdapterTools>(tools, this.stampLogger), ...rest);
  }
}
