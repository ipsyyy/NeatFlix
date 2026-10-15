/**
 * Bounded live test: Content Curator → Scene Scout for case NF-DEMO-0001.
 *
 * 1. Creates or reuses the BAND room titled with the case ID, owned by the
 *    Content Curator, and makes sure Scene Scout and the human owner are members.
 * 2. Starts only the Content Curator and Scene Scout agents.
 * 3. Waits for a real BAND `User` to post the case request in the room.
 * 4. Observes the room through both agents' own REST context (read-only;
 *    this script never posts messages).
 * 5. Stops both agents after Scene Scout responds, or when time runs out.
 *
 * Prints only room/message IDs, sender names and handles, roles, decisions,
 * timestamps, and Claude call metadata. Never message bodies, keys, or reasoning.
 *
 * Run: npm run agents:handoff-test               (setup + bounded run)
 *      npm run agents:handoff-test -- --setup-only
 *      npm run agents:handoff-test -- --wait-minutes=15
 *      npm run agents:handoff-test -- --room-title=NF-DEMO-0001-R2   (fresh room, same case)
 */
import type { Logger } from "@band-ai/sdk/core";
import { bandClientFor, ensureCaseRoom, type RoomParticipant } from "@/agents/band/case-room";
import {
  collectSecrets,
  ConfigError,
  loadLocalEnv,
  readAllCredentials,
  readAnthropicKey,
  readBandUrls,
  type RoleCredentials,
} from "@/agents/config/env";
import { AGENT_MODEL } from "@/agents/config/model";
import { AGENT_REGISTRY, type AgentRole } from "@/agents/config/roles";
import { extractHandoffs, validateOutgoing } from "@/agents/handoff/protocol";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { CLOCK_SKEW_MS, checkHandoffTimestamp } from "@/agents/handoff/timestamps";
import type { ClaudeCallRecord } from "@/agents/runtime/claude-client";
import { createNativeFrameAgents, type NativeFrameAgent } from "@/agents/runtime/create-agents";
import { createRedactingLogger, safeErrorMessage } from "@/agents/security/redact";

const CASE_ID = "NF-DEMO-0001";
const ACTIVE_ROLES: AgentRole[] = ["content-curator", "scene-scout"];
const POLL_MS = 4_000;
const SCOUT_SETTLE_MS = 6_000;
const STOP_TIMEOUT_MS = 10_000;

const setupOnly = process.argv.includes("--setup-only");
const waitArg = process.argv.find((a) => a.startsWith("--wait-minutes="));
const waitMinutes = Math.min(Math.max(Number(waitArg?.split("=")[1] ?? 20) || 20, 1), 30);
const roomTitleArg = process.argv.find((a) => a.startsWith("--room-title="))?.split("=")[1]?.trim();
const ROOM_TITLE = roomTitleArg && /^[\w.-]{1,120}$/.test(roomTitleArg) ? roomTitleArg : CASE_ID;

type GateEvent = {
  role: AgentRole;
  accepted: boolean;
  senderRole: string;
  senderType: string;
  message: string;
  reasons?: string[];
  handoffTimestamp?: string;
  postedAt?: string;
  timestampSkewMs?: number;
  at: number;
};

type StampEvent = { role: AgentRole; timestamp: string; at: number };

type RoomMessage = {
  id: string;
  senderId: string;
  senderType: string;
  senderName: string;
  at: string;
  content: string;
  messageType: string;
};

function teeLogger(role: AgentRole, base: Logger, gateEvents: GateEvent[], stampEvents: StampEvent[]): Logger {
  const capture = (accepted: boolean, ctx?: Record<string, unknown>) =>
    gateEvents.push({
      role,
      accepted,
      senderRole: String(ctx?.senderRole ?? "?"),
      senderType: String(ctx?.senderType ?? "?"),
      message: String(ctx?.message ?? "?"),
      reasons: Array.isArray(ctx?.reasons) ? (ctx.reasons as string[]) : undefined,
      handoffTimestamp: typeof ctx?.handoffTimestamp === "string" ? ctx.handoffTimestamp : undefined,
      postedAt: typeof ctx?.postedAt === "string" ? ctx.postedAt : undefined,
      timestampSkewMs: typeof ctx?.timestampSkewMs === "number" ? ctx.timestampSkewMs : undefined,
      at: Date.now(),
    });
  return {
    debug: (m, c) => base.debug(m, c),
    info: (m, c) => {
      if (m === "Accepted message at handoff boundary") capture(true, c);
      if (m === "Stamped handoff at send boundary" && typeof c?.timestamp === "string") {
        stampEvents.push({ role, timestamp: c.timestamp, at: Date.now() });
      }
      base.info(m, c);
    },
    warn: (m, c) => {
      if (m === "Rejected message at handoff boundary") capture(false, c);
      base.warn(m, c);
    },
    error: (m, c) => base.error(m, c),
  };
}

function label(p: RoomParticipant | undefined, fallback: string): string {
  return p ? `${p.name}${p.handle ? ` (@${p.handle.replace(/^@/, "")})` : ""}` : fallback;
}

function summarizeEnvelope(e: HandoffEnvelope): string {
  return [
    `${e.senderRole} → ${e.recipientRole}`,
    `decision=${e.decision}`,
    `case=${e.caseId}`,
    `artifact=${e.artifactId}`,
    `confidence=${e.confidence}`,
    `evidence=${e.evidence.length}`,
    `blockers=${e.blockers.length}`,
    `timestamp=${e.timestamp}`,
  ].join(", ");
}

/** Validated envelope from a message, or the reason it is not one. */
function envelopeOf(content: string): { envelope: HandoffEnvelope } | { error: string } {
  const blocks = extractHandoffs(content);
  if (blocks.length !== 1) return { error: `${blocks.length} handoff blocks` };
  const [block] = blocks;
  if (!block.ok) return { error: block.error };
  const result = validateOutgoing(block.value);
  return result.ok ? { envelope: result.value } : { error: result.errors.join("; ") };
}

async function readRoom(creds: RoleCredentials[], urls: ReturnType<typeof readBandUrls>, roomId: string): Promise<RoomMessage[]> {
  const seen = new Map<string, RoomMessage>();
  for (const c of creds) {
    const res = await bandClientFor(c, urls).agentApiContext.getAgentChatContext(roomId, { page: 1, page_size: 50 });
    for (const m of res.data) {
      seen.set(m.id, {
        id: m.id,
        senderId: m.sender_id,
        senderType: m.sender_type,
        senderName: m.sender_name ?? m.sender_type,
        at: m.inserted_at ?? "",
        content: m.content,
        messageType: m.message_type,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
}

async function stopAll(agents: NativeFrameAgent[], secrets: string[]): Promise<boolean> {
  const results = await Promise.allSettled(agents.map(({ agent }) => agent.stop(STOP_TIMEOUT_MS)));
  let clean = true;
  results.forEach((r, i) => {
    const name = AGENT_REGISTRY[agents[i].role].displayName.padEnd(20);
    if (r.status === "rejected") {
      clean = false;
      console.log(`  ${name} stop failed: ${safeErrorMessage(r.reason, secrets)}`);
    } else {
      if (!r.value) clean = false;
      console.log(`  ${name} ${r.value ? "stopped" : "stop timed out"}`);
    }
  });
  return clean;
}

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  let credentials: RoleCredentials[];
  let urls: ReturnType<typeof readBandUrls>;
  let anthropicApiKey: string;
  try {
    credentials = readAllCredentials(process.env);
    urls = readBandUrls(process.env);
    anthropicApiKey = readAnthropicKey(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const byRole = new Map(credentials.map((c) => [c.role, c] as const));
  const curator = byRole.get("content-curator")!;
  const scout = byRole.get("scene-scout")!;
  const activeCreds = [curator, scout];

  // 1. Room
  const room = await ensureCaseRoom({
    caseId: CASE_ID,
    title: ROOM_TITLE,
    owner: curator,
    urls,
    memberIds: (ownerUserId) => [scout.agentId, ownerUserId],
  });
  const participantById = new Map(room.participants.map((p) => [p.id, p] as const));
  console.log(`BAND room "${room.title}" for case ${CASE_ID} ${room.created ? "created" : "reused"}: ${room.roomId}`);
  console.log(`  Added this run: ${room.added.length}`);
  for (const p of room.participants) console.log(`  participant: ${label(p, p.id)} [${p.type}]`);
  const human = room.participants.find((p) => p.type === "User");
  const curatorP = participantById.get(curator.agentId);
  if (setupOnly) return 0;

  // 2. Start only the two agents under test
  const gateEvents: GateEvent[] = [];
  const stampEvents: StampEvent[] = [];
  const claudeCalls: ClaudeCallRecord[] = [];
  const agents = createNativeFrameAgents({
    credentials,
    roles: ACTIVE_ROLES,
    urls,
    anthropicApiKey,
    loggerFor: (role) => teeLogger(role, createRedactingLogger(role, secrets), gateEvents, stampEvents),
    onClaudeCall: (r) => {
      claudeCalls.push(r);
      console.log(`  [claude] ${AGENT_REGISTRY[r.role].displayName}: ${r.model}, stop=${r.stopReason}, tokens in/out=${r.inputTokens}/${r.outputTokens}, ${r.durationMs} ms`);
    },
  });
  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nInterrupted. Stopping agents");
    await stopAll(agents, secrets);
    process.exit(130);
  };
  process.once("SIGINT", () => void onSignal());
  process.once("SIGTERM", () => void onSignal());

  // A request posted while no agent was online stays pending for the Content
  // Curator; BAND delivers it when the Curator connects, so it belongs to this run.
  const pending = await bandClientFor(curator, urls).agentApiMessages.listAgentMessages(room.roomId, {
    status: "pending",
    page: 1,
    page_size: 50,
  });
  const pendingIds = new Set(pending.data.map((m) => m.id));
  if (pendingIds.size > 0) console.log(`\n${pendingIds.size} message(s) already pending for Content Curator: ${[...pendingIds].join(", ")}`);

  const startedAt = new Date();
  console.log(`\nStarting ${agents.length} agents (model ${AGENT_MODEL}); Campaign Matcher and later roles are not started.`);
  const started = await Promise.allSettled(agents.map(({ agent }) => agent.start()));
  started.forEach((r, i) =>
    console.log(`  ${AGENT_REGISTRY[agents[i].role].displayName.padEnd(20)} ${r.status === "fulfilled" ? agents[i].agent.state.status : `failed: ${safeErrorMessage(r.reason, secrets)}`}`),
  );
  if (started.some((r) => r.status === "rejected")) {
    await stopAll(agents, secrets);
    return 1;
  }

  console.log(`\nWaiting up to ${waitMinutes} min for a BAND user to post the case request in "${room.title}"`);
  console.log(`  mentioning ${label(curatorP, "Content Curator")}. This script posts nothing itself.\n`);

  // 3–4. Observe the real room
  const reported = new Set<string>();
  const agentEvents: RoomMessage[] = [];
  let humanRequest: RoomMessage | null = null;
  let curatorMsg: (RoomMessage & { envelope?: HandoffEnvelope; error?: string }) | null = null;
  let scoutMsg: (RoomMessage & { envelope?: HandoffEnvelope; error?: string }) | null = null;
  const deadline = Date.now() + waitMinutes * 60_000;
  const since = startedAt.getTime() - 5_000;

  while (Date.now() < deadline && !scoutMsg) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let messages: RoomMessage[];
    try {
      messages = await readRoom(activeCreds, urls, room.roomId);
    } catch (error) {
      console.log(`  room read failed: ${safeErrorMessage(error, secrets)}`);
      continue;
    }
    for (const m of messages) {
      if (reported.has(m.id) || (Date.parse(m.at) < since && !pendingIds.has(m.id))) continue;
      reported.add(m.id);
      const who = label(participantById.get(m.senderId), m.senderName);
      if (m.messageType !== "text") {
        if (m.senderType === "Agent") agentEvents.push(m);
        console.log(`  ${m.at}  item ${m.id}  from ${who} [${m.senderType}]: ${m.messageType} event`);
        continue;
      }
      if (m.senderType === "User" && !humanRequest) {
        humanRequest = m;
        console.log(`  ${m.at}  message ${m.id}  from ${who} [User]: case request`);
      } else if (m.senderId === curator.agentId && !curatorMsg) {
        const parsed = envelopeOf(m.content);
        curatorMsg = { ...m, ...parsed };
        console.log(`  ${m.at}  message ${m.id}  from ${who} [Agent]: ${"envelope" in parsed ? summarizeEnvelope(parsed.envelope) : `no valid handoff (${parsed.error})`}`);
      } else if (m.senderId === scout.agentId && !scoutMsg) {
        const parsed = envelopeOf(m.content);
        scoutMsg = { ...m, ...parsed };
        console.log(`  ${m.at}  message ${m.id}  from ${who} [Agent]: ${"envelope" in parsed ? summarizeEnvelope(parsed.envelope) : `no valid handoff (${parsed.error})`}`);
      } else {
        console.log(`  ${m.at}  message ${m.id}  from ${who} [${m.senderType}]: additional message`);
      }
    }
  }
  if (scoutMsg) await new Promise((r) => setTimeout(r, SCOUT_SETTLE_MS));

  // 5. Stop and report
  console.log("\nStopping agents");
  const clean = await stopAll(agents, secrets);
  const finalParticipants = (await ensureCaseRoom({ caseId: CASE_ID, title: ROOM_TITLE, owner: curator, urls, memberIds: () => [] }))
    .participants;
  // Final read after shutdown, so late events are counted too.
  try {
    for (const m of await readRoom(activeCreds, urls, room.roomId)) {
      if (Date.parse(m.at) >= since && m.messageType !== "text" && m.senderType === "Agent" && !agentEvents.some((e) => e.id === m.id)) {
        agentEvents.push(m);
      }
    }
  } catch (error) {
    console.log(`  final room read failed: ${safeErrorMessage(error, secrets)}`);
  }

  console.log("\nHandoff boundary decisions");
  for (const e of gateEvents) {
    const time = e.handoffTimestamp ? ` (handoff ${e.handoffTimestamp}, BAND posted ${e.postedAt}, skew ${e.timestampSkewMs} ms)` : "";
    console.log(`  ${AGENT_REGISTRY[e.role].displayName.padEnd(20)} ${e.accepted ? "ACCEPTED" : "REJECTED"} message ${e.message} from ${e.senderRole} [${e.senderType}]${time}${e.reasons ? `: ${e.reasons.join("; ")}` : ""}`);
  }

  console.log("\nRuntime timestamps vs BAND posting times");
  const freshness = (m: typeof curatorMsg) => {
    if (!m?.envelope) return null;
    const check = checkHandoffTimestamp(m.envelope.timestamp, { now: new Date(), postedAt: new Date(m.at) });
    const stampedByRuntime = stampEvents.some((s) => s.timestamp === m.envelope!.timestamp);
    console.log(`  message ${m.id}: runtime stamp ${m.envelope.timestamp}, BAND posted ${m.at}, ${check.ok ? `skew ${check.skewMs} ms, fresh (tolerance ±${CLOCK_SKEW_MS / 1000}s)` : `FAILED: ${check.reason}`}, stamped by runtime at send: ${stampedByRuntime}`);
    return check.ok && stampedByRuntime;
  };
  const curatorFresh = freshness(curatorMsg);
  const scoutFresh = freshness(scoutMsg);
  const scoutGate = gateEvents.find((e) => e.role === "scene-scout" && e.accepted && e.message === curatorMsg?.id);
  const firstScoutClaude = claudeCalls.find((c) => c.role === "scene-scout");
  const gateBeforeClaude = Boolean(scoutGate && firstScoutClaude && scoutGate.at <= Date.parse(firstScoutClaude.at));
  console.log("\nClaude calls");
  for (const role of ACTIVE_ROLES) {
    const calls = claudeCalls.filter((c) => c.role === role);
    console.log(`  ${AGENT_REGISTRY[role].displayName.padEnd(20)} ${calls.length} call(s), stop reasons: ${calls.map((c) => c.stopReason).join(", ") || "none"}`);
  }

  const curatorAccepted = gateEvents.some((e) => e.role === "content-curator" && e.accepted && e.senderType === "User" && e.message === humanRequest?.id);
  const scoutAccepted = gateEvents.some((e) => e.role === "scene-scout" && e.accepted && e.senderRole === "content-curator" && e.message === curatorMsg?.id);
  const scoutAcceptedOthers = gateEvents.filter((e) => e.role === "scene-scout" && e.accepted && e.senderRole !== "content-curator");
  const curatorAcceptedOthers = gateEvents.filter((e) => e.role === "content-curator" && e.accepted && e.senderType !== "User");
  const checks: [string, boolean][] = [
    ["Human request posted by a BAND User", humanRequest !== null],
    ["Content Curator accepted it as authenticated User input", curatorAccepted],
    ["Content Curator accepted nothing except User input", curatorAcceptedOthers.length === 0],
    ["Content Curator sent a valid handoff to Scene Scout", curatorMsg?.envelope?.recipientRole === "scene-scout" && curatorMsg.envelope.decision === "approve"],
    ["Content Curator handoff carries a fresh runtime timestamp", curatorFresh === true],
    ["Scene Scout verified sender and timestamp before calling Claude", gateBeforeClaude && scoutGate?.handoffTimestamp === curatorMsg?.envelope?.timestamp],
    ["Scene Scout accepted the authenticated Content Curator handoff", scoutAccepted],
    ["Scene Scout accepted nothing except Content Curator handoffs", scoutAcceptedOthers.length === 0],
    ["Scene Scout posted a valid structured response", Boolean(scoutMsg?.envelope)],
    ["Scene Scout response carries a fresh runtime timestamp", scoutFresh === true],
    ["Both agents completed Claude calls", ACTIVE_ROLES.every((r) => claudeCalls.some((c) => c.role === r && c.stopReason !== null))],
    ["No thought, status, or other agent event posted", agentEvents.length === 0],
    [
      "Room contains only the human owner, Content Curator, and Scene Scout",
      finalParticipants.length === 3 &&
        finalParticipants.some((p) => p.id === curator.agentId) &&
        finalParticipants.some((p) => p.id === scout.agentId) &&
        finalParticipants.filter((p) => p.type === "User").length === 1,
    ],
    ["Room membership unchanged by agents", finalParticipants.length === room.participants.length],
    ["Agents stopped cleanly", clean],
  ];
  console.log("\nValidation");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!humanRequest) console.log(`\nNo User message arrived within ${waitMinutes} min. ${human ? `Expected from ${label(human, "the room owner")}.` : ""}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Handoff test failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
