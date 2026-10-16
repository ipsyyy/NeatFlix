import type { Logger } from "@band-ai/sdk/core";
import { DefaultPreprocessor, HistoryProvider } from "@band-ai/sdk/runtime";
import type { AgentRole } from "@/agents/config/roles";
import { ACCEPTED_INPUTS, canConsume, extractHandoffs } from "@/agents/handoff/protocol";
import { checkHandoffTimestamp } from "@/agents/handoff/timestamps";
import type { HandoffEnvelope, ValidationRegistries } from "@/agents/handoff/envelope";
import type { RefreshableSourceFrameRegistry } from "@/agents/handoff/source-frames";
import { inMemoryAcceptedPlans, type AcceptedPlanRegistry } from "./accepted-plans";

/** Release Governor stores the gate fills: accepted plans, and previews revalidated for them. */
export type GovernorIntake = {
  plans?: AcceptedPlanRegistry;
  previews?: { refresh(planId: string): Promise<unknown> };
  /** Registered source frames, refreshed for the handoff's scene before it is screened. */
  frames?: RefreshableSourceFrameRegistry;
};

/** The case and scene a handoff concerns: a placement plan's scene, a match's scene, or a review's subject. */
function handoffScene(value: unknown): { caseId: string; sceneId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const h = value as Record<string, unknown>;
  if (typeof h.caseId !== "string") return null;
  const artifact = h.artifact as Record<string, unknown> | undefined;
  const fromArtifact = (artifact?.scene as Record<string, unknown> | undefined)?.sceneId ?? (artifact?.subject as Record<string, unknown> | undefined)?.sceneId;
  if (typeof fromArtifact === "string") return { caseId: h.caseId, sceneId: fromArtifact };
  const match = typeof h.artifactId === "string" ? /^match:[a-z0-9-]+:([a-z0-9-]+)$/.exec(h.artifactId) : null;
  return match ? { caseId: h.caseId, sceneId: match[1] } : null;
}

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
  registries: ValidationRegistries = {},
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
  const result = canConsume(consumer, block.value, sender.role, registries);
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
 *
 * Evidence isolation: a downstream role receives only the authenticated handoff.
 * Its room history is withheld, so earlier messages (from other agents or other
 * runs) cannot be used as evidence; facts must come from the handoff and tools.
 */
export class HandoffGate {
  private readonly inner = new DefaultPreprocessor();

  constructor(
    private readonly consumer: AgentRole,
    private readonly roleByAgentId: ReadonlyMap<string, AgentRole>,
    private readonly logger: Logger,
    private readonly closeRejected?: CloseRejectedMessage,
    private readonly intake: GovernorIntake = {},
  ) {}

  process: DefaultProcess = async (context, event, agentId) => {
    const input = await this.inner.process(context, event, agentId);
    if (!input) return input;
    const { message } = input;
    const sender: MessageSender = {
      role: this.roleByAgentId.get(message.senderId) ?? null,
      type: message.senderType,
    };
    // Load the scene's registered source frames first, so plans naming a frame can be checked.
    if (this.intake.frames) {
      const [block] = extractHandoffs(message.content);
      const target = block?.ok ? handoffScene(block.value) : null;
      if (target) await this.intake.frames.refreshScene(target.caseId, target.sceneId);
    }
    const screen = screenIncomingMessage(
      this.consumer,
      message.content,
      sender,
      { now: new Date(), postedAt: message.createdAt },
      { frames: this.intake.frames },
    );
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
    // Keep the authenticated plan for the Governor's tools (see accepted-plans.ts).
    // Persisting or refreshing may fail; the plan stays in memory and an
    // unrefreshed preview cache only keeps approval impossible (fail closed).
    if (this.consumer === "release-governor") {
      const [block] = extractHandoffs(message.content);
      const artifact = block?.ok ? (block.value as HandoffEnvelope).artifact : undefined;
      if (artifact?.kind === "placement-plan") {
        try {
          const problems = await (this.intake.plans ?? inMemoryAcceptedPlans).record(artifact);
          if (problems.length > 0) this.logger.warn("Accepted plan was not persisted", { plan: artifact.planId, problems: problems.length });
          await this.intake.previews?.refresh(artifact.planId);
        } catch (error) {
          this.logger.warn("Could not persist the accepted plan or refresh its preview", { plan: artifact.planId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    const isolate = !ACCEPTED_INPUTS[this.consumer].humanRequest;
    this.logger.info("Accepted message at handoff boundary", {
      room: message.roomId,
      message: message.id,
      senderRole: sender.role ?? "human-user",
      senderType: sender.type.slice(0, 20),
      ...(isolate ? { historyWithheld: input.history?.length ?? 0 } : {}),
      ...(screen.handoffTimestamp
        ? {
            handoffTimestamp: screen.handoffTimestamp,
            postedAt: message.createdAt.toISOString(),
            timestampSkewMs: screen.timestampSkewMs,
          }
        : {}),
    });
    return isolate ? { ...input, history: new HistoryProvider([]) } : input;
  };
}
