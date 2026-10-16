import { AnthropicAdapter, type AnthropicAdapterOptions } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import type { PreviewRegistry } from "@/agents/handoff/governor-review";
import type { SourceFrameRegistry } from "@/agents/handoff/source-frames";
import { canonicalMentions, checkMentions, type MentionArg, type RoomMember } from "@/agents/handoff/mentions";
import { HANDOFF_FENCE, extractHandoffs } from "@/agents/handoff/protocol";
import { stampOutgoingContent } from "@/agents/handoff/stamp";

type AdapterTools = Parameters<AnthropicAdapter["onMessage"]>[1];

const SEND_TOOL = "band_send_message";
const BLOCK = new RegExp("```" + HANDOFF_FENCE + "\\s*\\n[\\s\\S]*?\\n```", "g");

/**
 * Send-boundary options: the preview registry approvals are validated against,
 * and a hook called with each handoff BAND accepted (for example, to persist it).
 */
export type SendBoundaryOptions = {
  previews?: PreviewRegistry;
  /** Registered source frames a posted placement plan may bind to. */
  frames?: SourceFrameRegistry;
  onPosted?: (envelope: HandoffEnvelope) => Promise<void>;
};

/** Who is posting, so mentions can be checked against the room (see mentions.ts). */
export type MentionPolicy = { role: AgentRole; roleByAgentId: ReadonlyMap<string, AgentRole>; humanOnly?: boolean };

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
 * - With a mention policy, a handoff may mention only the human User and its
 *   downstream recipient when that agent is in the room (checkMentions).
 */
export function withHandoffStamping<T extends object>(
  tools: T,
  logger: Logger,
  clock: () => Date = () => new Date(),
  policy?: MentionPolicy,
  options: SendBoundaryOptions = {},
): T {
  /** Reports a posted handoff to onPosted. Failures there never undo or block the post. */
  const afterPost = async (content: string) => {
    if (!options.onPosted) return;
    const [block] = extractHandoffs(content);
    if (!block?.ok) return;
    try {
      await options.onPosted(block.value as HandoffEnvelope);
    } catch (error) {
      logger.warn("Post-send hook failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  };

  /**
   * Checks a post's mentions against the room and returns the list to send:
   * rebuilt from the roster (canonicalMentions), so BAND never receives a
   * model-written id, handle, or name that was not the one checked.
   */
  const checkPostMentions = async (content: string, mentions: unknown): Promise<{ errors: string[]; mentions?: unknown[] }> => {
    if (!policy) return { errors: [] };
    const [block] = extractHandoffs(content);
    if (!block?.ok) return { errors: [] };
    const getParticipants = (tools as { getParticipants?: () => Promise<RoomMember[]> }).getParticipants;
    const members = getParticipants ? await getParticipants.call(tools) : [];
    const list = Array.isArray(mentions) ? mentions : [];
    const errors = checkMentions({
      sender: policy.role,
      envelope: block.value as HandoffEnvelope,
      mentions: list as MentionArg[],
      readable: content.replace(BLOCK, ""),
      members,
      roleByAgentId: policy.roleByAgentId,
      humanOnly: policy.humanOnly,
    });
    return errors.length > 0 ? { errors } : { errors, mentions: canonicalMentions(list, members) };
  };

  const prepare = (content: string) => {
    const handoffs = extractHandoffs(content).length;
    if (handoffs !== 1) {
      return {
        ok: false as const,
        errors: [`A NativeFrame message must contain exactly one ${handoffs === 0 ? "handoff; plain text is not posted" : "handoff, not several"}.`],
      };
    }
    const result = stampOutgoingContent(content, clock(), { previews: options.previews, frames: options.frames });
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
            const checked = await checkPostMentions(prepared.content, args?.mentions);
            if (checked.errors.length > 0) {
              logger.warn("Blocked message at send boundary", { tool: name, errors: checked.errors });
              return handoffSendError(checked.errors);
            }
            const mentions = checked.mentions ? { mentions: checked.mentions } : {};
            const sent = await value.call(target, name, { ...args, content: prepared.content, ...mentions });
            if ((sent as { ok?: unknown } | null)?.ok !== false) await afterPost(prepared.content);
            return sent;
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
          const checked = prepared.ok ? await checkPostMentions(prepared.content, rest[0]) : { errors: [] };
          if (!prepared.ok || checked.errors.length > 0) {
            logger.warn("Blocked message at send boundary", { path: "sendMessage", errors: prepared.ok ? checked.errors : prepared.errors });
            throw new Error("Message failed validation at the send boundary and was not sent.");
          }
          const [, ...others] = rest;
          const sent = checked.mentions ? await value.call(target, prepared.content, checked.mentions, ...others) : await value.call(target, prepared.content, ...rest);
          await afterPost(prepared.content);
          return sent;
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
  private readonly mentionPolicy?: MentionPolicy;
  private readonly sendOptions: SendBoundaryOptions;

  constructor(options: AnthropicAdapterOptions & { logger: Logger; mentionPolicy?: MentionPolicy; sendBoundary?: SendBoundaryOptions }) {
    const { mentionPolicy, sendBoundary, ...adapterOptions } = options;
    super(adapterOptions);
    this.stampLogger = options.logger;
    this.mentionPolicy = mentionPolicy;
    this.sendOptions = sendBoundary ?? {};
  }

  override async onMessage(...args: Parameters<AnthropicAdapter["onMessage"]>): ReturnType<AnthropicAdapter["onMessage"]> {
    const [message, tools, ...rest] = args;
    return super.onMessage(message, withHandoffStamping<AdapterTools>(tools, this.stampLogger, undefined, this.mentionPolicy, this.sendOptions), ...rest);
  }
}
