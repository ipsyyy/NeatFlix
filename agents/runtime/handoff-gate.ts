import type { Logger } from "@band-ai/sdk/core";
import { DefaultPreprocessor } from "@band-ai/sdk/runtime";
import type { AgentRole } from "@/agents/config/roles";
import { ACCEPTED_INPUTS, canConsume, extractHandoffs } from "@/agents/handoff/protocol";
import { checkHandoffTimestamp } from "@/agents/handoff/timestamps";

type DefaultProcess = DefaultPreprocessor["process"];

/** BAND's sender type for a human account. */
export const BAND_USER_SENDER_TYPE = "User";

/**
 * Who BAND says sent a message. `role` is set only when the authenticated
 * sender ID belongs to one of the five registered NativeFrame agents.
 */
export type MessageSender = { role: AgentRole | null; type: string };

export type ScreenResult =
  | { consume: true; handoffTimestamp?: string; timestampSkewMs?: number }
  | { consume: false; reasons: string[] };

/** Trusted times for a message: BAND's server time for it, and the receiver's clock. */
export type MessageClock = { now: Date; postedAt?: Date | null };

const reject = (...reasons: string[]): ScreenResult => ({ consume: false, reasons });

/**
 * Authorization boundary for every NativeFrame agent (default deny):
 * - Content Curator consumes only a plain-text request from a BAND `User`.
 * - Every other role consumes only one valid structured handoff from its
 *   accepted upstream role, sent by that role's authenticated BAND identity.
 * - Handoff timestamps must be present, ISO 8601 UTC, and fresh relative to
 *   BAND's posting time (see timestamps.ts), checked before anything else.
 * Anything else — unregistered agents, humans messaging downstream roles,
 * missing, malformed, extra, misrouted, spoofed, or stale handoffs — is rejected.
 */
export function screenIncomingMessage(
  consumer: AgentRole,
  content: string,
  sender: MessageSender,
  clock: MessageClock = { now: new Date() },
): ScreenResult {
  if (sender.role === consumer) return reject("Agents do not consume their own messages.");

  const blocks = extractHandoffs(content);
  const policy = ACCEPTED_INPUTS[consumer];

  if (policy.humanRequest) {
    if (sender.role !== null) return reject(`${consumer} accepts no input from ${sender.role}.`);
    if (sender.type !== BAND_USER_SENDER_TYPE) {
      return reject(`${consumer} accepts plain-text requests only from BAND users, not sender type "${sender.type.slice(0, 20)}".`);
    }
    if (blocks.length > 0) return reject("A user request must be plain text, not a handoff envelope.");
    return { consume: true };
  }

  if (sender.role === null) {
    return reject(`${consumer} accepts only structured handoffs from NativeFrame agents; sender is not a registered agent.`);
  }
  if (blocks.length === 0) return reject(`Message from ${sender.role} has no handoff envelope.`);
  if (blocks.length > 1) return reject("A message must carry exactly one handoff envelope.");

  const [block] = blocks;
  if (!block.ok) return reject(block.error);
  const stamp = checkHandoffTimestamp((block.value as { timestamp?: unknown } | null)?.timestamp, clock);
  if (!stamp.ok) return reject(stamp.reason);
  const result = canConsume(consumer, block.value, sender.role);
  return result.ok
    ? { consume: true, handoffTimestamp: stamp.timestamp, timestampSkewMs: stamp.skewMs }
    : reject(...result.errors);
}

/** Marks a rejected message as handled at BAND so it is not delivered again. */
export type CloseRejectedMessage = (roomId: string, messageId: string) => Promise<void>;

/**
 * BAND preprocessor that runs the SDK's default processing, then screens the
 * message before the adapter (and Claude) can see it. Rejected messages are
 * logged by sender and reason only; their content is never logged or forwarded.
 *
 * The SDK leaves a message pending when a preprocessor drops it, so BAND would
 * redeliver it on every restart. A rejection is a final decision, so the gate
 * closes the message (processing → processed) through the receiving agent's own
 * BAND identity. Closing never lets the message through, even if it fails.
 */
export class HandoffGate {
  private readonly inner = new DefaultPreprocessor();

  constructor(
    private readonly consumer: AgentRole,
    private readonly roleByAgentId: ReadonlyMap<string, AgentRole>,
    private readonly logger: Logger,
    private readonly closeRejected?: CloseRejectedMessage,
  ) {}

  process: DefaultProcess = async (context, event, agentId) => {
    const input = await this.inner.process(context, event, agentId);
    if (!input) return input;
    const { message } = input;
    const sender: MessageSender = {
      role: this.roleByAgentId.get(message.senderId) ?? null,
      type: message.senderType,
    };
    const screen = screenIncomingMessage(this.consumer, message.content, sender, {
      now: new Date(),
      postedAt: message.createdAt,
    });
    if (!screen.consume) {
      this.logger.warn("Rejected message at handoff boundary", {
        room: message.roomId,
        message: message.id,
        senderRole: sender.role ?? "unregistered",
        senderType: sender.type.slice(0, 20),
        reasons: screen.reasons,
      });
      if (this.closeRejected && message.id) {
        try {
          await this.closeRejected(message.roomId, message.id);
          this.logger.info("Closed rejected message at BAND", { room: message.roomId, message: message.id });
        } catch (error) {
          this.logger.warn("Could not close rejected message; it may be screened again", {
            room: message.roomId,
            message: message.id,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      return null;
    }
    this.logger.info("Accepted message at handoff boundary", {
      room: message.roomId,
      message: message.id,
      senderRole: sender.role ?? "human-user",
      senderType: sender.type.slice(0, 20),
      ...(screen.handoffTimestamp
        ? {
            handoffTimestamp: screen.handoffTimestamp,
            postedAt: message.createdAt.toISOString(),
            timestampSkewMs: screen.timestampSkewMs,
          }
        : {}),
    });
    return input;
  };
}
