/**
 * Bounded live continuation: Campaign Matcher → Placement Director for case NF-DEMO-0001.
 *
 * 1. Creates (or reuses) the target room, owned by Campaign Matcher, containing
 *    exactly the human BAND User, NF Campaign Matcher, and NF Placement Director.
 * 2. Reads Campaign Matcher's validated recommendation from the source room and,
 *    through Campaign Matcher's own BAND identity, re-delivers it unchanged except
 *    for a trusted timestamp attached immediately before the BAND POST.
 * 3. Starts only Placement Director, which must authenticate Campaign Matcher, use
 *    Claude with only its approved tools, and post one result carrying a typed
 *    placement plan in one structured handoff to Release Governor.
 * 4. Stops Placement Director after it posts, then verifies each requirement.
 *
 * Records the hostnames this process contacts, to prove no media API is called.
 * Prints only IDs, names and handles, roles, plan fields, evidence sources,
 * timestamps, hostnames, and Claude call metadata. Never keys or reasoning.
 *
 * Run: npm run agents:placement-test
 *      npm run agents:placement-test -- --room-title=NF-DEMO-0001-LUV-PLACEMENT-R2 \
 *        --source-room-title=NF-DEMO-0001-LUV-MATCH-R1 --original-message=<Campaign Matcher message ID>
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
import { AGENT_MODEL, turnLimitsFor } from "@/agents/config/model";
import { AGENT_REGISTRY, type AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { APPROVED_EVIDENCE_SOURCES, RELEASE_GOVERNOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import {
  generationClaims,
  misleadingFrameTerms,
  PLACEMENT_REGION,
  PROMPT_NOT_EXECUTED_LABEL,
  STAND_IN_DISCLOSURE,
  validatePlacementPlan,
} from "@/agents/handoff/placement-plan";
import { HANDOFF_FENCE, extractHandoffs, validateOutgoing } from "@/agents/handoff/protocol";
import { CLOCK_SKEW_MS, checkHandoffTimestamp } from "@/agents/handoff/timestamps";
import type { ClaudeCallRecord } from "@/agents/runtime/claude-client";
import { createNativeFrameAgents, type NativeFrameAgent } from "@/agents/runtime/create-agents";
import { createRedactingLogger, safeErrorMessage } from "@/agents/security/redact";
import { catalogue } from "@/data/catalogue";

const CASE_ID = "NF-DEMO-0001";
const ACTIVE_ROLE: AgentRole = "placement-director";
const REQUIRED_TOOLS = ["nativeframe_get_selected_scene", "nativeframe_get_campaign", "nativeframe_get_source_artwork"];
const APPROVED_TOOLS = new Set([...REQUIRED_TOOLS, "nativeframe_validate_handoff"]);
const POLL_MS = 4_000;
const SETTLE_MS = 6_000;
// Outlasts the agent's own turn budget, so a slow turn ends on its own timeout, not ours.
const WAIT_MS = turnLimitsFor("placement-director").turnTimeoutMs + 2 * 60_000;
const STOP_TIMEOUT_MS = 10_000;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]?.trim();
const title = (value: string | undefined, fallback: string) => (value && /^[\w.-]{1,120}$/.test(value) ? value : fallback);
const ROOM_TITLE = title(arg("room-title"), "NF-DEMO-0001-LUV-PLACEMENT-R2");
const SOURCE_ROOM_TITLE = title(arg("source-room-title"), "NF-DEMO-0001-LUV-MATCH-R1");
const ORIGINAL_ID = /^[0-9a-f-]{36}$/.test(arg("original-message") ?? "") ? arg("original-message")! : "447209d8-0b10-4f44-ab7b-2db272c24237";

/** Current catalogue references the plan must use (post-migration IDs and approved artwork). */
const TITLE_ID = "luv-hypothesis";
const SCENE_ID = "luv-scene-1";
const MATCH_ARTIFACT_ID = `match:daybreak-cold-brew:${SCENE_ID}`;
const currentTitle = catalogue.find((t) => t.id === TITLE_ID);
const ARTWORK_SRC = currentTitle?.artwork.kind === "image" ? currentTitle.artwork.src : null;

/** Hostnames contacted over fetch by this process (BAND REST and the Anthropic API). */
const contactedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    contactedHosts.add(new URL(url).host);
  } catch {
    contactedHosts.add("unparsed");
  }
  return realFetch(input, init);
}) as typeof fetch;

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
  const matcher = byRole.get("campaign-matcher")!;
  const director = byRole.get("placement-director")!;

  // 1. Target room owned by Campaign Matcher: exactly the User, Campaign Matcher, Placement Director.
  const room = await ensureCaseRoom({ caseId: CASE_ID, title: ROOM_TITLE, owner: matcher, urls, memberIds: (owner) => [director.agentId, owner] });
  const byId = new Map(room.participants.map((p) => [p.id, p] as const));
  console.log(`BAND room "${room.title}" ${room.created ? "created" : "reused"}: ${room.roomId}`);
  for (const p of room.participants) console.log(`  participant: ${label(p, p.id)} [${p.type}]`);
  const directorP = byId.get(director.agentId);
  const human = room.participants.find((p) => p.type === "User");
  const others = credentials.filter((c) => c.role !== ACTIVE_ROLE && byId.has(c.agentId));
  const priorItems = await readRoom([matcher], urls, room.roomId);

  // 2. Original Campaign Matcher recommendation from the source room.
  const source = await ensureCaseRoom({ caseId: CASE_ID, title: SOURCE_ROOM_TITLE, owner: matcher, urls, memberIds: () => [] });
  if (source.created) {
    console.error(`Source room "${SOURCE_ROOM_TITLE}" did not exist.`);
    return 1;
  }
  const original = (await readRoom([matcher], urls, source.roomId)).find((m) => m.id === ORIGINAL_ID);
  if (!original || original.senderId !== matcher.agentId) {
    console.error(`Original Campaign Matcher message ${ORIGINAL_ID} not found from Campaign Matcher in "${SOURCE_ROOM_TITLE}".`);
    return 1;
  }
  const draft = buildRedelivery({
    originalContent: original.content,
    originalMessageId: original.id,
    expect: { senderRole: "campaign-matcher", recipientRole: "placement-director", decision: "recommend" },
    recipientMention: `@${directorP?.handle ?? "placement-director"}`,
  });
  if (!draft.ok) {
    console.error(`Original handoff cannot be re-delivered: ${draft.errors.join("; ")}`);
    return 1;
  }
  const originalBlock = extractHandoffs(original.content)[0];
  // Refuse to re-deliver a recommendation for a retired catalogue record.
  const originalArtifact = originalBlock?.ok ? (originalBlock.value as { artifactId?: unknown }).artifactId : undefined;
  if (!ARTWORK_SRC || originalArtifact !== MATCH_ARTIFACT_ID) {
    console.error(`Original handoff must recommend ${MATCH_ARTIFACT_ID} for ${TITLE_ID} with approved image artwork; nothing was posted.`);
    return 1;
  }
  console.log(`\nOriginal Campaign Matcher handoff ${original.id} in "${SOURCE_ROOM_TITLE}" (BAND ${original.at}); prepared unstamped re-delivery.`);
  const statusBefore = new Map(await Promise.all(others.map(async (c) => [c.role, await deliveryStatus(c, urls, room.roomId)] as const)));

  // 3. Start only Placement Director.
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
    console.log("\nInterrupted. Stopping Placement Director");
    await stop(agents, secrets);
    process.exit(130);
  };
  process.once("SIGINT", () => void onSignal());
  process.once("SIGTERM", () => void onSignal());

  console.log(`\nStarting only Placement Director (model ${AGENT_MODEL}); Content Curator, Scene Scout, and Release Governor are not started.`);
  try {
    await agent.agent.start();
  } catch (error) {
    console.log(`  Placement Director failed to start: ${safeErrorMessage(error, secrets)}`);
    await stop(agents, secrets);
    return 1;
  }
  console.log(`  Placement Director   ${agent.agent.state.status}`);

  // 4. Re-deliver as Campaign Matcher, stamped immediately before the POST.
  const matcherClient = bandClientFor(matcher, urls);
  let recipients: string[] = [];
  const posted = await postWithTrustedTimestamp({
    draftContent: draft.draftContent,
    post: async (content) => {
      const res = await matcherClient.agentApiMessages.createAgentChatMessage(room.roomId, {
        message: { content, mentions: [{ id: director.agentId, handle: directorP?.handle ?? undefined, name: directorP?.name }] },
      });
      recipients = res.data.recipients.map((r) => r.id);
      return { id: res.data.id };
    },
    readPostedAt: async (id) => {
      const item = (await readRoom([matcher], urls, room.roomId)).find((m) => m.id === id);
      return item ? new Date(item.at) : null;
    },
  });
  if (!posted.ok && !posted.messageId) {
    console.log(`Re-delivery not posted: ${posted.errors.join("; ")}`);
    await stop(agents, secrets);
    return 1;
  }
  const redeliveryId = posted.ok ? posted.messageId : posted.messageId!;
  console.log(`\nRe-delivered as Campaign Matcher: ${redeliveryId}${posted.ok ? `, runtime ${posted.timestamp}, BAND ${posted.postedAt}, skew ${posted.skewMs} ms` : `, verification FAILED: ${posted.errors.join("; ")}`}`);

  // 5. Observe until Placement Director posts.
  let reply: RoomItem | null = null;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !reply) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      reply = (await readRoom([director], urls, room.roomId)).find((m) => m.senderId === director.agentId && m.type === "text") ?? null;
    } catch (error) {
      console.log(`  room read failed: ${safeErrorMessage(error, secrets)}`);
    }
  }
  if (reply) await new Promise((r) => setTimeout(r, SETTLE_MS));

  console.log("\nStopping Placement Director");
  const clean = await stop(agents, secrets);

  // 6. Verify from BAND.
  const after = await readRoom([director, matcher], urls, room.roomId);
  const redeliveryItem = after.find((m) => m.id === redeliveryId) ?? null;
  reply = after.find((m) => m.id === reply?.id) ?? reply;
  const runItems = after.filter((m) => !priorItems.some((p) => p.id === m.id));
  const agentEvents = runItems.filter((m) => m.senderType === "Agent" && m.type !== "text");
  const replies = runItems.filter((m) => m.senderId === director.agentId && m.type === "text");
  const finalParticipants = (await ensureCaseRoom({ caseId: CASE_ID, title: ROOM_TITLE, owner: matcher, urls, memberIds: () => [] })).participants;
  const runIds = new Set(runItems.map((m) => m.id));
  const unrelated: string[] = [];
  for (const c of others) {
    const b = statusBefore.get(c.role)!;
    const a = await deliveryStatus(c, urls, room.roomId);
    for (const id of [...a.processing, ...a.processed, ...a.failed]) if (runIds.has(id) && !b.processed.includes(id)) unrelated.push(`${c.role}:${id}`);
  }
  const absent = (["content-curator", "scene-scout", "release-governor"] as const).filter((r) => !finalParticipants.some((p) => p.id === byRole.get(r)!.agentId));
  const queues = Object.fromEntries(
    await Promise.all([matcher, director].map(async (c) => [c.role, await deliveryStatus(c, urls, room.roomId)] as const)),
  ) as Record<string, Record<string, string[]>>;

  const gate = events.find((e) => e.kind === "Accepted message at handoff boundary" && e.ctx.message === redeliveryId);
  const stamps = events.filter((e) => e.kind === "Stamped handoff at send boundary");
  const toolsUsed = [...new Set(events.filter((e) => e.kind === "Evidence tool called").map((e) => String(e.ctx.tool)))];
  const blocked = events.filter((e) => /Blocked|Suppressed/.test(e.kind));
  const firstClaude = claudeCalls[0];
  const envelope = reply ? envelopeOf(reply.content) : null;
  const plan = envelope?.artifact?.kind === "placement-plan" ? envelope.artifact : undefined;
  const readable = reply ? readableOf(reply.content) : "";
  const replyFresh = envelope && reply ? checkHandoffTimestamp(envelope.timestamp, { now: new Date(), postedAt: new Date(reply.at) }) : null;
  const planErrors = plan ? validatePlacementPlan(plan, envelope?.caseId) : ["no plan"];
  const outputErrors = envelope ? validateResult(envelope, readable) : ["no envelope"];
  const bandHost = new URL(urls.restUrl ?? "https://app.band.ai").host;
  const allowedHosts = new Set(["api.anthropic.com", bandHost]);
  const unexpectedHosts = [...contactedHosts].filter((h) => !allowedHosts.has(h));
  const unchanged =
    originalBlock.ok &&
    redeliveryItem !== null &&
    (() => {
      const sent = envelopeOf(redeliveryItem.content);
      return sent !== null && JSON.stringify({ ...(originalBlock.value as HandoffEnvelope), timestamp: null }) === JSON.stringify({ ...sent, timestamp: null });
    })();
  const allEvidence = [...(envelope?.evidence ?? []), ...(plan?.evidence ?? [])];
  const approvedPrefixes = APPROVED_EVIDENCE_SOURCES["placement-director"] ?? [];

  console.log("\nLive messages");
  for (const m of runItems) {
    const mentions = m.mentions.map((id) => `@${byId.get(id)?.handle ?? id}`).join(", ") || "none";
    console.log(`  ${m.at}  ${m.id}  ${label(byId.get(m.senderId), m.senderName)} [${m.senderType}] type=${m.type} mentions=${mentions}`);
  }
  console.log("\nHandoff boundary");
  if (gate) console.log(`  Placement Director ACCEPTED ${gate.ctx.message} from ${gate.ctx.senderRole} [${gate.ctx.senderType}] (handoff ${gate.ctx.handoffTimestamp}, BAND ${gate.ctx.postedAt}, skew ${gate.ctx.timestampSkewMs} ms, room history withheld: ${gate.ctx.historyWithheld} item(s))`);
  console.log(`  Evidence tools used: ${toolsUsed.join(", ") || "none"}`);
  console.log(`  Send-boundary blocks or suppressions: ${blocked.length}${blocked.length ? ` (${blocked.map((b) => `${b.kind}: ${JSON.stringify(b.ctx).slice(0, 220)}`).join("; ")})` : ""}`);
  console.log(`  Hosts contacted over fetch: ${[...contactedHosts].join(", ")}`);
  if (envelope) {
    console.log("\nPlacement Director handoff");
    console.log(`  ${envelope.senderRole} → ${envelope.recipientRole}, decision=${envelope.decision}, case=${envelope.caseId}, artifact=${envelope.artifactId}, confidence=${envelope.confidence}, blockers=${envelope.blockers.length}`);
    console.log(`  runtime ${envelope.timestamp}, BAND ${reply?.at}, ${replyFresh?.ok ? `skew ${replyFresh.skewMs} ms (±${CLOCK_SKEW_MS / 1000}s)` : "NOT fresh"}`);
  }
  if (plan) {
    console.log("\nPlacement plan");
    console.log(`  planId=${plan.planId}; sources: ${plan.sourceArtifacts.matchArtifactId}, ${plan.sourceArtifacts.sceneArtifactId}, ${plan.sourceArtifacts.titleId}`);
    console.log(`  scene ${plan.scene.sceneId} "${plan.scene.name}" ${plan.scene.startSeconds}–${plan.scene.endSeconds} s; product ${plan.product.product} (${plan.product.format})`);
    console.log(`  placement: region="${plan.placement.region}", motion=${plan.placement.motion}, hands=${plan.placement.handInteraction}; ${plan.placement.description.slice(0, 200)}`);
    for (const [k, v] of Object.entries(plan.guidance)) console.log(`  guidance.${k}: ${String(v).slice(0, 160)}`);
    for (const [k, v] of Object.entries(plan.preservation)) console.log(`  preservation.${k}: ${(v as string[]).map((x) => x.slice(0, 120)).join(" | ")}`);
    console.log(`  brandLegibility: ${plan.brandLegibility.map((x) => x.slice(0, 140)).join(" | ")}`);
    console.log(`  negativeConstraints (${plan.negativeConstraints.length}): ${plan.negativeConstraints.map((x) => x.slice(0, 100)).join(" | ")}`);
    console.log(`  still prompt [${plan.prompts.stillImageEdit.target}, ${plan.prompts.stillImageEdit.status}]: ${plan.prompts.stillImageEdit.prompt.slice(0, 300)}`);
    console.log(`  motion prompt [${plan.prompts.motion.target}, ${plan.prompts.motion.status}, ${plan.prompts.motion.durationSeconds}s]: ${plan.prompts.motion.prompt.slice(0, 300)}`);
    console.log(`  sourceMedia: ${plan.sourceMedia.kind}, isSceneFrame=${plan.sourceMedia.isSceneFrame}, ${"src" in plan.sourceMedia ? plan.sourceMedia.src : plan.sourceMedia.storageRef}`);
    console.log(`  assumptions: ${plan.assumptions.map((x) => x.slice(0, 120)).join(" | ")}`);
    console.log(`  plan errors: ${planErrors.length ? planErrors.join("; ") : "none"}; output-rule errors: ${outputErrors.length ? outputErrors.join("; ") : "none"}`);
  }
  console.log(`\nEvidence sources (${allEvidence.length}):`);
  for (const e of allEvidence) console.log(`  - ${e.source.slice(0, 150)}`);
  console.log(`\nClaude calls: ${claudeCalls.length} (${claudeCalls.map((c) => c.stopReason).join(", ")})`);
  for (const [role, q] of Object.entries(queues)) {
    console.log(`Queue in ${ROOM_TITLE} for ${role}: pending=${q.pending.join(",") || "-"} processing=${q.processing.join(",") || "-"} processed=${q.processed.join(",") || "-"} failed=${q.failed.join(",") || "-"}`);
  }

  const checks: [string, boolean][] = [
    ["Fresh room with exactly the BAND User, Campaign Matcher, and Placement Director, no prior messages",
      room.created && priorItems.filter((m) => m.type === "text").length === 0 && finalParticipants.length === 3 &&
        [matcher, director].every((c) => finalParticipants.some((p) => p.id === c.agentId)) && finalParticipants.filter((p) => p.type === "User").length === 1],
    ["Re-delivery keeps every original handoff field except the timestamp", unchanged],
    ["Re-delivery posted by the authenticated Campaign Matcher identity", redeliveryItem?.senderId === matcher.agentId && redeliveryItem.senderType === "Agent"],
    ["Re-delivery mentions and is routed only to Placement Director", redeliveryItem?.mentions.join() === director.agentId && recipients.length > 0 && recipients.every((id) => id === director.agentId)],
    ["Re-delivery stamped immediately before POST and fresh against BAND's posting time", posted.ok],
    ["Placement Director authenticated Campaign Matcher and validated the timestamp before Claude",
      Boolean(gate && gate.ctx.senderRole === "campaign-matcher" && gate.ctx.handoffTimestamp === (posted.ok ? posted.timestamp : "") && firstClaude && gate.at <= Date.parse(firstClaude.at))],
    ["Placement Director received no room history (evidence isolation)", typeof gate?.ctx.historyWithheld === "number"],
    ["Placement Director used Claude and only approved tools (all required ones)",
      claudeCalls.length > 0 && claudeCalls.every((c) => c.stopReason !== null) && REQUIRED_TOOLS.every((t) => toolsUsed.includes(t)) && toolsUsed.every((t) => APPROVED_TOOLS.has(t))],
    ["One readable result with exactly one valid handoff: instructions-ready → release-governor, no blockers",
      replies.length === 1 && extractHandoffs(reply?.content ?? "").length === 1 && envelope?.senderRole === "placement-director" &&
        envelope.recipientRole === "release-governor" && envelope.decision === "instructions-ready" && envelope.blockers.length === 0 && readable.length > 0],
    ["Typed placement plan is present, schema-valid, and visible in the BAND message", Boolean(plan) && planErrors.length === 0 && Boolean(reply?.content.includes('"kind": "placement-plan"'))],
    [`Plan: ${TITLE_ID} ${SCENE_ID} 00:07–00:10 from ${MATCH_ARTIFACT_ID}, artwork ${ARTWORK_SRC}; Daybreak Cold Brew branded takeaway cup, visible café table, stationary, no hand interaction`,
      plan?.sourceArtifacts.titleId === TITLE_ID && plan.sourceArtifacts.matchArtifactId === MATCH_ARTIFACT_ID && "src" in plan.sourceMedia && plan.sourceMedia.src === ARTWORK_SRC &&
        envelope?.artifactId.includes(SCENE_ID) === true && !/hate|hh-scene/i.test(reply?.content ?? "") &&
        plan.scene.sceneId === SCENE_ID && plan.scene.startSeconds === 7 && plan.scene.endSeconds === 10 && plan.product.product === "Daybreak Cold Brew" &&
        plan.product.format === "Branded takeaway coffee cup" && plan.placement.region.toLowerCase() === PLACEMENT_REGION && plan.placement.motion === "stationary" && plan.placement.handInteraction === "none"],
    ["Plan has scale, perspective, lighting, shadow, color guidance; face, body, background, composition preservation; brand limits; negative constraints",
      Boolean(plan) && Object.values(plan!.guidance).every((v) => String(v).trim().length > 0) && Object.values(plan!.preservation).every((v) => (v as string[]).length > 0) &&
        plan!.brandLegibility.length > 0 && plan!.negativeConstraints.length > 0],
    ["Both prompts labelled as unexecuted generation instructions; motion duration 3–5 s",
      plan?.prompts.stillImageEdit.status === "not-executed" && plan.prompts.motion.status === "not-executed" &&
        plan.prompts.stillImageEdit.label === PROMPT_NOT_EXECUTED_LABEL && plan.prompts.motion.label === PROMPT_NOT_EXECUTED_LABEL &&
        plan.prompts.motion.durationSeconds >= 3 && plan.prompts.motion.durationSeconds <= 5 && /not (yet )?(been )?executed/i.test(readable)],
    ["No claim of a real scene frame, video, or completed generation",
      plan?.sourceMedia.kind === "title-artwork-stand-in" && plan.sourceMedia.isSceneFrame === false &&
        generationClaims(`${readable}\n${envelope?.nextAction ?? ""}`).length === 0 && !outputErrors.some((e) => /generation/.test(e))],
    ["Every evidence item cites the structured handoff or an approved tool; no room history",
      allEvidence.length > 0 && allEvidence.every((e) => approvedPrefixes.some((p) => e.source.trim().toLowerCase().startsWith(p))) &&
        !outputErrors.some((e) => /evidence|room history/.test(e))],
    [`States exactly: "${RELEASE_GOVERNOR_DISCLOSURE}"`, readable.includes(RELEASE_GOVERNOR_DISCLOSURE)],
    ["Visible result mentions only the human User (Release Governor absent; recipientRole kept in the handoff)",
      Boolean(human && reply && reply.mentions.length === 1 && reply.mentions[0] === human.id) && envelope?.recipientRole === "release-governor"],
    [`States exactly: "${STAND_IN_DISCLOSURE}"; no source/scene/video frame terminology`,
      readable.includes(STAND_IN_DISCLOSURE) && plan?.sourceMedia.note === STAND_IN_DISCLOSURE &&
        misleadingFrameTerms(reply?.content ?? "").length === 0],
    ["Placement Director handoff stamped at send and fresh against BAND's posting time", Boolean(replyFresh?.ok && stamps.some((s) => s.ctx.timestamp === envelope?.timestamp))],
    ["No thought, status, or other agent event posted", agentEvents.length === 0],
    ["No external media API called (only BAND and Anthropic hosts contacted)", unexpectedHosts.length === 0 && contactedHosts.size > 0],
    ["No other agent processed a message; Release Governor not present and did not consume", unrelated.length === 0 && absent.length === 3],
    ["No message remains pending or failed for Campaign Matcher or Placement Director",
      Object.values(queues).every((q) => q.pending.length === 0 && q.processing.length === 0 && q.failed.length === 0)],
    ["Placement Director stopped cleanly", clean],
  ];
  console.log(`\nValidation (${checks.length} checks)`);
  checks.forEach(([name, ok], i) => console.log(`  ${String(i + 1).padStart(2)}. ${ok ? "PASS" : "FAIL"}  ${name}`));
  if (unrelated.length) console.log(`  unrelated processing: ${unrelated.join(", ")}`);
  if (unexpectedHosts.length) console.log(`  unexpected hosts: ${unexpectedHosts.join(", ")}`);
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed} of ${checks.length} checks passed.`);
  return passed === checks.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Placement test failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
