/**
 * Bounded live continuation: Scene Scout → Campaign Matcher for case NF-DEMO-0001.
 *
 * 1. Creates (or reuses) the target room, owned by Scene Scout, containing exactly
 *    the human BAND User, NF Scene Scout, and NF Campaign Matcher.
 * 2. Reads Scene Scout's already-validated hh-scene-1 selection from the source
 *    room and, through Scene Scout's own BAND identity, re-delivers it unchanged
 *    except for a trusted timestamp attached immediately before the BAND POST and
 *    checked against BAND's posting time. Claude does not regenerate it.
 * 3. Starts only Campaign Matcher, which must authenticate Scene Scout, validate
 *    the timestamp, use Claude with only its approved evidence tools, and post one
 *    result. Its room history is withheld by the handoff gate.
 * 4. Stops Campaign Matcher after it posts, then runs the 17 checks.
 *
 * Prints only IDs, sender names and handles, roles, decisions, evidence sources,
 * timestamps, and Claude call metadata. Never keys or reasoning.
 *
 * Run: npm run agents:matcher-test
 *      npm run agents:matcher-test -- --room-title=NF-DEMO-0001-MATCH-R1 --source-room-title=NF-DEMO-0001-R2
 */
import type { Logger } from "@band-ai/sdk/core";
import { bandClientFor, ensureCaseRoom, type RoomParticipant } from "@/agents/band/case-room";
import { postWithTrustedTimestamp } from "@/agents/band/post";
import { buildRedelivery } from "@/agents/band/redeliver";
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
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { APPROVED_EVIDENCE_SOURCES, PLACEMENT_DIRECTOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { HANDOFF_FENCE, extractHandoffs, validateOutgoing } from "@/agents/handoff/protocol";
import { CLOCK_SKEW_MS, checkHandoffTimestamp } from "@/agents/handoff/timestamps";
import type { ClaudeCallRecord } from "@/agents/runtime/claude-client";
import { createNativeFrameAgents, type NativeFrameAgent } from "@/agents/runtime/create-agents";
import { createRedactingLogger, safeErrorMessage } from "@/agents/security/redact";

const CASE_ID = "NF-DEMO-0001";
const ACTIVE_ROLE: AgentRole = "campaign-matcher";
const REQUIRED_TOOLS = ["nativeframe_get_selected_scene", "nativeframe_get_campaign", "nativeframe_evaluate_campaign_match"];
const APPROVED_TOOLS = new Set([...REQUIRED_TOOLS, "nativeframe_validate_handoff"]);
const POLL_MS = 4_000;
const SETTLE_MS = 6_000;
const WAIT_MS = 6 * 60_000;
const STOP_TIMEOUT_MS = 10_000;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]?.trim();
const title = (value: string | undefined, fallback: string) => (value && /^[\w.-]{1,120}$/.test(value) ? value : fallback);
const ROOM_TITLE = title(arg("room-title"), "NF-DEMO-0001-MATCH-R1");
const SOURCE_ROOM_TITLE = title(arg("source-room-title"), "NF-DEMO-0001-R2");
const ORIGINAL_ID = /^[0-9a-f-]{36}$/.test(arg("original-message") ?? "") ? arg("original-message")! : "479ee01a-48e0-48b0-9220-7bc5c1aabf37";

type Event = { kind: string; ctx: Record<string, unknown>; at: number };
type RoomItem = { id: string; senderId: string; senderType: string; senderName: string; at: string; content: string; type: string; mentions: string[] };

function auditLogger(base: Logger, events: Event[]): Logger {
  const tracked = /handoff boundary|send boundary|Evidence tool called|Closed rejected/;
  const record = (m: string, c?: Record<string, unknown>) => {
    if (tracked.test(m)) events.push({ kind: m, ctx: c ?? {}, at: Date.now() });
  };
  return {
    debug: (m, c) => base.debug(m, c),
    info: (m, c) => (record(m, c), base.info(m, c)),
    warn: (m, c) => (record(m, c), base.warn(m, c)),
    error: (m, c) => base.error(m, c),
  };
}

const label = (p: RoomParticipant | undefined, fallback: string) =>
  p ? `${p.name}${p.handle ? ` (@${p.handle.replace(/^@/, "")})` : ""}` : fallback;

async function readRoom(creds: RoleCredentials[], urls: ReturnType<typeof readBandUrls>, roomId: string): Promise<RoomItem[]> {
  const seen = new Map<string, RoomItem>();
  for (const c of creds) {
    const res = await bandClientFor(c, urls).agentApiContext.getAgentChatContext(roomId, { page: 1, page_size: 50 });
    for (const m of res.data) {
      const mentions = Array.isArray(m.metadata?.mentions) ? (m.metadata.mentions as { id?: string }[]).map((x) => x?.id ?? "") : [];
      seen.set(m.id, {
        id: m.id,
        senderId: m.sender_id,
        senderType: m.sender_type,
        senderName: m.sender_name ?? m.sender_type,
        at: m.inserted_at ?? "",
        content: m.content,
        type: m.message_type,
        mentions,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
}

async function deliveryStatus(c: RoleCredentials, urls: ReturnType<typeof readBandUrls>, roomId: string) {
  const out: Record<string, string[]> = {};
  for (const status of ["pending", "processing", "processed", "failed"] as const) {
    const r = await bandClientFor(c, urls).agentApiMessages.listAgentMessages(roomId, { status: status as never, page: 1, page_size: 50 });
    out[status] = r.data.map((m) => m.id);
  }
  return out;
}

const BLOCK = new RegExp("```" + HANDOFF_FENCE + "\\s*\\n[\\s\\S]*?\\n```", "g");
const readableOf = (content: string) => content.replace(BLOCK, "").trim();

function envelopeOf(content: string): HandoffEnvelope | null {
  const blocks = extractHandoffs(content);
  if (blocks.length !== 1 || !blocks[0].ok) return null;
  const result = validateOutgoing(blocks[0].value);
  return result.ok ? result.value : null;
}

async function stop(agents: NativeFrameAgent[], secrets: string[]): Promise<boolean> {
  const results = await Promise.allSettled(agents.map(({ agent }) => agent.stop(STOP_TIMEOUT_MS)));
  return results.every((r, i) => {
    const name = AGENT_REGISTRY[agents[i].role].displayName.padEnd(20);
    if (r.status === "rejected") {
      console.log(`  ${name} stop failed: ${safeErrorMessage(r.reason, secrets)}`);
      return false;
    }
    console.log(`  ${name} ${r.value ? "stopped" : "stop timed out"}`);
    return r.value;
  });
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
  const scout = byRole.get("scene-scout")!;
  const matcher = byRole.get("campaign-matcher")!;

  // 1. Target room owned by Scene Scout: exactly the User, Scene Scout, Campaign Matcher.
  const room = await ensureCaseRoom({
    caseId: CASE_ID,
    title: ROOM_TITLE,
    owner: scout,
    urls,
    memberIds: (ownerUserId) => [matcher.agentId, ownerUserId],
  });
  const byId = new Map(room.participants.map((p) => [p.id, p] as const));
  console.log(`BAND room "${room.title}" ${room.created ? "created" : "reused"}: ${room.roomId}`);
  for (const p of room.participants) console.log(`  participant: ${label(p, p.id)} [${p.type}]`);
  const matcherP = byId.get(matcher.agentId);
  const human = room.participants.find((p) => p.type === "User");
  const others = credentials.filter((c) => c.role !== ACTIVE_ROLE && byId.has(c.agentId));
  const priorItems = await readRoom([scout], urls, room.roomId);

  // 2. Original Scene Scout selection from the source room.
  const source = await ensureCaseRoom({ caseId: CASE_ID, title: SOURCE_ROOM_TITLE, owner: scout, urls, memberIds: () => [] });
  if (source.created) {
    console.error(`Source room "${SOURCE_ROOM_TITLE}" did not exist.`);
    return 1;
  }
  const original = (await readRoom([scout], urls, source.roomId)).find((m) => m.id === ORIGINAL_ID);
  if (!original || original.senderId !== scout.agentId) {
    console.error(`Original Scene Scout message ${ORIGINAL_ID} not found from Scene Scout in "${SOURCE_ROOM_TITLE}".`);
    return 1;
  }
  const draft = buildRedelivery({
    originalContent: original.content,
    originalMessageId: original.id,
    expect: { senderRole: "scene-scout", recipientRole: "campaign-matcher", decision: "select" },
    recipientMention: `@${matcherP?.handle ?? "campaign-matcher"}`,
  });
  if (!draft.ok) {
    console.error(`Original handoff cannot be re-delivered: ${draft.errors.join("; ")}`);
    return 1;
  }
  const originalBlock = extractHandoffs(original.content)[0];
  console.log(`\nOriginal Scene Scout handoff ${original.id} in "${SOURCE_ROOM_TITLE}" (BAND ${original.at}); prepared unstamped re-delivery.`);

  const statusBefore = new Map(await Promise.all(others.map(async (c) => [c.role, await deliveryStatus(c, urls, room.roomId)] as const)));

  // 3. Start only Campaign Matcher.
  const events: Event[] = [];
  const claudeCalls: ClaudeCallRecord[] = [];
  const [agent] = createNativeFrameAgents({
    credentials,
    roles: [ACTIVE_ROLE],
    urls,
    anthropicApiKey,
    loggerFor: (role) => auditLogger(createRedactingLogger(role, secrets), events),
    onClaudeCall: (r) => {
      claudeCalls.push(r);
      console.log(`  [claude] ${AGENT_REGISTRY[r.role].displayName}: ${r.model}, stop=${r.stopReason}, tokens in/out=${r.inputTokens}/${r.outputTokens}, ${r.durationMs} ms`);
    },
  });
  const agents = [agent];
  let interrupted = false;
  const onSignal = async () => {
    if (interrupted) return;
    interrupted = true;
    console.log("\nInterrupted. Stopping Campaign Matcher");
    await stop(agents, secrets);
    process.exit(130);
  };
  process.once("SIGINT", () => void onSignal());
  process.once("SIGTERM", () => void onSignal());

  console.log(`\nStarting only Campaign Matcher (model ${AGENT_MODEL}); Content Curator, Placement Director, and Release Governor are not started.`);
  try {
    await agent.agent.start();
  } catch (error) {
    console.log(`  Campaign Matcher failed to start: ${safeErrorMessage(error, secrets)}`);
    await stop(agents, secrets);
    return 1;
  }
  console.log(`  Campaign Matcher     ${agent.agent.state.status}`);

  // 4. Re-deliver as Scene Scout, stamped immediately before the POST.
  const scoutClient = bandClientFor(scout, urls);
  let recipients: string[] = [];
  const posted = await postWithTrustedTimestamp({
    draftContent: draft.draftContent,
    post: async (content) => {
      const res = await scoutClient.agentApiMessages.createAgentChatMessage(room.roomId, {
        message: { content, mentions: [{ id: matcher.agentId, handle: matcherP?.handle ?? undefined, name: matcherP?.name }] },
      });
      recipients = res.data.recipients.map((r) => r.id);
      return { id: res.data.id };
    },
    readPostedAt: async (id) => {
      const item = (await readRoom([scout], urls, room.roomId)).find((m) => m.id === id);
      return item ? new Date(item.at) : null;
    },
  });
  if (!posted.ok && !posted.messageId) {
    console.log(`Re-delivery not posted: ${posted.errors.join("; ")}`);
    await stop(agents, secrets);
    return 1;
  }
  const redeliveryId = posted.ok ? posted.messageId : posted.messageId!;
  console.log(
    `\nRe-delivered as Scene Scout: ${redeliveryId}${posted.ok ? `, runtime ${posted.timestamp}, BAND ${posted.postedAt}, skew ${posted.skewMs} ms` : `, verification FAILED: ${posted.errors.join("; ")}`}`,
  );

  // 5. Observe until Campaign Matcher posts.
  let reply: RoomItem | null = null;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !reply) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      reply = (await readRoom([matcher], urls, room.roomId)).find((m) => m.senderId === matcher.agentId && m.type === "text") ?? null;
    } catch (error) {
      console.log(`  room read failed: ${safeErrorMessage(error, secrets)}`);
    }
  }
  if (reply) await new Promise((r) => setTimeout(r, SETTLE_MS));

  console.log("\nStopping Campaign Matcher");
  const clean = await stop(agents, secrets);

  // 6. Verify from BAND.
  const after = await readRoom([matcher, scout], urls, room.roomId);
  const redeliveryItem = after.find((m) => m.id === redeliveryId) ?? null;
  reply = after.find((m) => m.id === reply?.id) ?? reply;
  const runItems = after.filter((m) => !priorItems.some((p) => p.id === m.id));
  const agentEvents = runItems.filter((m) => m.senderType === "Agent" && m.type !== "text");
  const replies = runItems.filter((m) => m.senderId === matcher.agentId && m.type === "text");
  const finalParticipants = (await ensureCaseRoom({ caseId: CASE_ID, title: ROOM_TITLE, owner: scout, urls, memberIds: () => [] })).participants;
  const runIds = new Set(runItems.map((m) => m.id));
  const unrelated: string[] = [];
  for (const c of others) {
    const b = statusBefore.get(c.role)!;
    const a = await deliveryStatus(c, urls, room.roomId);
    for (const id of [...a.processing, ...a.processed, ...a.failed]) if (runIds.has(id) && !b.processed.includes(id)) unrelated.push(`${c.role}:${id}`);
  }
  const absentRoles = (["content-curator", "placement-director", "release-governor"] as const).filter((r) => !finalParticipants.some((p) => p.id === byRole.get(r)!.agentId));

  const gate = events.find((e) => e.kind === "Accepted message at handoff boundary" && e.ctx.message === redeliveryId);
  const stamps = events.filter((e) => e.kind === "Stamped handoff at send boundary");
  const toolsUsed = [...new Set(events.filter((e) => e.kind === "Evidence tool called").map((e) => String(e.ctx.tool)))];
  const blocked = events.filter((e) => /Blocked|Suppressed/.test(e.kind));
  const firstClaude = claudeCalls[0];
  const envelope = reply ? envelopeOf(reply.content) : null;
  const readable = reply ? readableOf(reply.content) : "";
  const replyFresh = envelope && reply ? checkHandoffTimestamp(envelope.timestamp, { now: new Date(), postedAt: new Date(reply.at) }) : null;
  const outputErrors = envelope ? validateResult(envelope, readable) : ["no envelope"];
  const placementText = `${readable}\n${envelope?.nextAction ?? ""}`;
  const unchanged =
    originalBlock.ok &&
    redeliveryItem !== null &&
    (() => {
      const sent = envelopeOf(redeliveryItem.content);
      return sent !== null && JSON.stringify({ ...(originalBlock.value as HandoffEnvelope), timestamp: null }) === JSON.stringify({ ...sent, timestamp: null });
    })();

  console.log("\nLive messages");
  for (const m of runItems) {
    const mentions = m.mentions.map((id) => `@${byId.get(id)?.handle ?? id}`).join(", ") || "none";
    console.log(`  ${m.at}  ${m.id}  ${label(byId.get(m.senderId), m.senderName)} [${m.senderType}] type=${m.type} mentions=${mentions}`);
  }
  console.log("\nHandoff boundary");
  if (gate) console.log(`  Campaign Matcher ACCEPTED ${gate.ctx.message} from ${gate.ctx.senderRole} [${gate.ctx.senderType}] (handoff ${gate.ctx.handoffTimestamp}, BAND ${gate.ctx.postedAt}, skew ${gate.ctx.timestampSkewMs} ms, room history withheld: ${gate.ctx.historyWithheld} item(s))`);
  console.log(`  Evidence tools used: ${toolsUsed.join(", ") || "none"}`);
  console.log(`  Send-boundary blocks or suppressions: ${blocked.length}${blocked.length ? ` (${blocked.map((b) => `${b.kind}: ${JSON.stringify(b.ctx).slice(0, 200)}`).join("; ")})` : ""}`);
  if (envelope) {
    console.log("\nCampaign Matcher decision");
    console.log(`  ${envelope.senderRole} → ${envelope.recipientRole}, decision=${envelope.decision}, case=${envelope.caseId}, artifact=${envelope.artifactId}, confidence=${envelope.confidence}, blockers=${envelope.blockers.length}`);
    console.log(`  runtime ${envelope.timestamp}, BAND ${reply?.at}, ${replyFresh?.ok ? `skew ${replyFresh.skewMs} ms (±${CLOCK_SKEW_MS / 1000}s)` : "NOT fresh"}`);
    console.log(`  evidence sources (${envelope.evidence.length}):`);
    for (const e of envelope.evidence) console.log(`    - ${e.source.slice(0, 140)}`);
    console.log(`  assumptions: ${envelope.assumptions.map((a) => a.slice(0, 140)).join(" | ")}`);
    console.log(`  nextAction: ${envelope.nextAction.slice(0, 300)}`);
    console.log(`  output-rule problems: ${outputErrors.length ? outputErrors.join("; ") : "none"}`);
  }
  console.log(`\nClaude calls: ${claudeCalls.length} (${claudeCalls.map((c) => c.stopReason).join(", ")})`);

  const checks: [string, boolean][] = [
    ["Fresh room with exactly the BAND User, Scene Scout, and Campaign Matcher, no prior messages",
      room.created && priorItems.filter((m) => m.type === "text").length === 0 && finalParticipants.length === 3 &&
        [scout, matcher].every((c) => finalParticipants.some((p) => p.id === c.agentId)) && finalParticipants.filter((p) => p.type === "User").length === 1],
    ["Re-delivery keeps every original handoff field except the timestamp", unchanged],
    ["Re-delivery posted by the authenticated Scene Scout identity", redeliveryItem?.senderId === scout.agentId && redeliveryItem.senderType === "Agent"],
    ["Re-delivery mentions and is routed only to Campaign Matcher", redeliveryItem?.mentions.join() === matcher.agentId && recipients.length > 0 && recipients.every((id) => id === matcher.agentId)],
    ["Re-delivery stamped immediately before POST and fresh against BAND's posting time", posted.ok],
    ["Campaign Matcher authenticated Scene Scout and validated the timestamp before Claude",
      Boolean(gate && gate.ctx.senderRole === "scene-scout" && gate.ctx.handoffTimestamp === (posted.ok ? posted.timestamp : "") && firstClaude && gate.at <= Date.parse(firstClaude.at))],
    ["Campaign Matcher received no room history (evidence isolation)", typeof gate?.ctx.historyWithheld === "number"],
    ["Campaign Matcher used Claude and only approved evidence tools (all required ones)",
      claudeCalls.length > 0 && claudeCalls.every((c) => c.stopReason !== null) && REQUIRED_TOOLS.every((t) => toolsUsed.includes(t)) && toolsUsed.every((t) => APPROVED_TOOLS.has(t))],
    ["One result with one valid handoff: recommend Daybreak Cold Brew → placement-director, no blockers",
      replies.length === 1 && envelope?.senderRole === "campaign-matcher" && envelope.recipientRole === "placement-director" &&
        envelope.decision === "recommend" && envelope.blockers.length === 0 && /daybreak-cold-brew/.test(envelope.artifactId) && /Daybreak Cold Brew/.test(readable)],
    ["Every evidence item cites the structured handoff or an approved tool result", Boolean(envelope) && outputErrors.every((e) => !/evidence|room history/.test(e)) &&
      envelope!.evidence.every((e) => (APPROVED_EVIDENCE_SOURCES["campaign-matcher"] ?? []).some((p) => e.source.trim().toLowerCase().startsWith(p)))],
    ["Placement: stationary branded takeaway coffee cup on the visible lab desk, no hand interaction",
      /stationary/i.test(placementText) && /branded takeaway coffee cup/i.test(placementText) && /lab desk/i.test(placementText) && /no hand interaction/i.test(placementText)],
    ["States subscriber targeting is rule-based because subscriber records are not connected",
      Boolean(envelope?.assumptions.some((a) => /subscriber records are not connected/i.test(a) && /rule-based/i.test(a)))],
    [`States exactly: "${PLACEMENT_DIRECTOR_DISCLOSURE}"`, readable.includes(PLACEMENT_DIRECTOR_DISCLOSURE) && Boolean(human && reply?.mentions.includes(human.id))],
    ["Campaign Matcher handoff stamped at send and fresh against BAND's posting time", Boolean(replyFresh?.ok && stamps.some((s) => s.ctx.timestamp === envelope?.timestamp))],
    ["No thought, status, or other agent event posted", agentEvents.length === 0],
    ["No other agent processed a message; Placement Director did not consume the handoff",
      unrelated.length === 0 && absentRoles.length === 3],
    ["Campaign Matcher stopped cleanly", clean],
  ];
  console.log("\nValidation (17 checks)");
  checks.forEach(([name, ok], i) => console.log(`  ${String(i + 1).padStart(2)}. ${ok ? "PASS" : "FAIL"}  ${name}`));
  if (unrelated.length) console.log(`  unrelated processing: ${unrelated.join(", ")}`);
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed} of ${checks.length} checks passed.`);
  return passed === checks.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Matcher test failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
