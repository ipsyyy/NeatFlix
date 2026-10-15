/**
 * Bounded live continuation: Placement Director → Release Governor for case NF-DEMO-0001.
 *
 * 1. Creates the target room, owned by Placement Director, containing exactly
 *    the human BAND User, NF Placement Director, and NF Release Governor.
 * 2. Reads Placement Director's validated placement plan from the source room
 *    and, through Placement Director's own BAND identity, re-delivers it
 *    unchanged except for a trusted timestamp attached immediately before the POST.
 * 3. Starts only Release Governor, with mentions limited to the human so the
 *    present (but stopped) Placement Director receives no work. No generated
 *    preview exists, so the Governor must post one honest "revise" handoff to
 *    Placement Director requesting the preview, provenance, and evaluation evidence.
 * 4. Stops Release Governor after it posts, then verifies each requirement.
 *
 * Records the hostnames this process contacts, to prove no media API is called.
 * Prints only IDs, names and handles, roles, review fields, evidence sources,
 * timestamps, hostnames, and Claude call metadata. Never keys or reasoning.
 *
 * Run: npm run agents:governor-test -- --original-message=<Placement Director message ID>
 *      npm run agents:governor-test -- --room-title=NF-DEMO-0001-LUV-GOVERNOR-R1 \
 *        --source-room-title=NF-DEMO-0001-LUV-PLACEMENT-R2 --original-message=<Placement Director message ID>
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
import { MISSING_PREVIEW_CORRECTIONS, NO_PREVIEW_DISCLOSURE, validateGovernorReview, visualClaims } from "@/agents/handoff/governor-review";
import { APPROVED_EVIDENCE_SOURCES, PLACEMENT_DIRECTOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { generationClaims, misleadingFrameTerms } from "@/agents/handoff/placement-plan";
import { HANDOFF_FENCE, extractHandoffs, validateOutgoing } from "@/agents/handoff/protocol";
import { CLOCK_SKEW_MS, checkHandoffTimestamp } from "@/agents/handoff/timestamps";
import type { ClaudeCallRecord } from "@/agents/runtime/claude-client";
import { createNativeFrameAgents, type NativeFrameAgent } from "@/agents/runtime/create-agents";
import { createRedactingLogger, safeErrorMessage } from "@/agents/security/redact";

const CASE_ID = "NF-DEMO-0001";
const ACTIVE_ROLE: AgentRole = "release-governor";
const REQUIRED_TOOLS = ["nativeframe_check_placement_plan", "nativeframe_get_preview_status"];
const APPROVED_TOOLS = new Set([...REQUIRED_TOOLS, "nativeframe_validate_handoff"]);
const POLL_MS = 4_000;
const SETTLE_MS = 6_000;
// Outlasts the agent's own turn budget, so a slow turn ends on its own timeout, not ours.
const WAIT_MS = turnLimitsFor(ACTIVE_ROLE).turnTimeoutMs + 2 * 60_000;
const STOP_TIMEOUT_MS = 10_000;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]?.trim();
const title = (value: string | undefined, fallback: string) => (value && /^[\w.-]{1,120}$/.test(value) ? value : fallback);
const ROOM_TITLE = title(arg("room-title"), "NF-DEMO-0001-LUV-GOVERNOR-R1");
const SOURCE_ROOM_TITLE = title(arg("source-room-title"), "NF-DEMO-0001-LUV-PLACEMENT-R2");
/** The Placement Director result to re-deliver. Required: no real message ID is hard-coded. */
const ORIGINAL_ID = /^[0-9a-f-]{36}$/.test(arg("original-message") ?? "") ? arg("original-message")! : null;

/** Current catalogue references the review must use. */
const TITLE_ID = "luv-hypothesis";
const SCENE_ID = "luv-scene-1";
const CAMPAIGN_ID = "daybreak-cold-brew";
const PLAN_ID = `plan:${CAMPAIGN_ID}:${SCENE_ID}:v1`;

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
  if (!ORIGINAL_ID) {
    console.error("Pass --original-message=<Placement Director message ID>. Nothing was posted.");
    return 1;
  }
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
  const director = byRole.get("placement-director")!;
  const governor = byRole.get("release-governor")!;

  // 1. Target room owned by Placement Director: exactly the User, Placement Director, Release Governor.
  const room = await ensureCaseRoom({ caseId: CASE_ID, title: ROOM_TITLE, owner: director, urls, memberIds: (owner) => [governor.agentId, owner] });
  const byId = new Map(room.participants.map((p) => [p.id, p] as const));
  console.log(`BAND room "${room.title}" ${room.created ? "created" : "reused"}: ${room.roomId}`);
  for (const p of room.participants) console.log(`  participant: ${label(p, p.id)} [${p.type}]`);
  if (!room.created) {
    console.error("The target room already existed; use a fresh room title. Nothing was posted.");
    return 1;
  }
  const governorP = byId.get(governor.agentId);
  const human = room.participants.find((p) => p.type === "User");
  const others = credentials.filter((c) => c.role !== ACTIVE_ROLE && byId.has(c.agentId));
  const priorItems = await readRoom([director], urls, room.roomId);

  // 2. Original Placement Director result from the source room.
  const source = await ensureCaseRoom({ caseId: CASE_ID, title: SOURCE_ROOM_TITLE, owner: director, urls, memberIds: () => [] });
  if (source.created) {
    console.error(`Source room "${SOURCE_ROOM_TITLE}" did not exist.`);
    return 1;
  }
  const original = (await readRoom([director], urls, source.roomId)).find((m) => m.id === ORIGINAL_ID);
  if (!original || original.senderId !== director.agentId) {
    console.error(`Original Placement Director message ${ORIGINAL_ID} not found from Placement Director in "${SOURCE_ROOM_TITLE}".`);
    return 1;
  }
  const draft = buildRedelivery({
    originalContent: original.content,
    originalMessageId: original.id,
    expect: { senderRole: "placement-director", recipientRole: "release-governor", decision: "instructions-ready" },
    recipientMention: `@${governorP?.handle ?? "release-governor"}`,
  });
  if (!draft.ok) {
    console.error(`Original handoff cannot be re-delivered: ${draft.errors.join("; ")}`);
    return 1;
  }
  const originalBlock = extractHandoffs(original.content)[0];
  if (!originalBlock?.ok || (originalBlock.value as { artifactId?: unknown }).artifactId !== PLAN_ID) {
    console.error(`Original handoff must carry ${PLAN_ID}; nothing was posted.`);
    return 1;
  }
  console.log(`\nOriginal Placement Director handoff ${original.id} in "${SOURCE_ROOM_TITLE}" (BAND ${original.at}); prepared unstamped re-delivery.`);
  const statusBefore = new Map(await Promise.all(others.map(async (c) => [c.role, await deliveryStatus(c, urls, room.roomId)] as const)));

  // 3. Start only Release Governor; it may mention only the human in this run.
  const events: Event[] = [];
  const claudeCalls: ClaudeCallRecord[] = [];
  const [agent] = createNativeFrameAgents({
    credentials,
    roles: [ACTIVE_ROLE],
    urls,
    anthropicApiKey,
    mentionHumanOnly: true,
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
    console.log("\nInterrupted. Stopping Release Governor");
    await stop(agents, secrets);
    process.exit(130);
  };
  process.once("SIGINT", () => void onSignal());
  process.once("SIGTERM", () => void onSignal());

  console.log(`\nStarting only Release Governor (model ${AGENT_MODEL}); Content Curator, Scene Scout, Campaign Matcher, and Placement Director are not started.`);
  try {
    await agent.agent.start();
  } catch (error) {
    console.log(`  Release Governor failed to start: ${safeErrorMessage(error, secrets)}`);
    await stop(agents, secrets);
    return 1;
  }
  console.log(`  Release Governor     ${agent.agent.state.status}`);

  // 4. Re-deliver as Placement Director, stamped immediately before the POST.
  const directorClient = bandClientFor(director, urls);
  let recipients: string[] = [];
  const posted = await postWithTrustedTimestamp({
    draftContent: draft.draftContent,
    post: async (content) => {
      const res = await directorClient.agentApiMessages.createAgentChatMessage(room.roomId, {
        message: { content, mentions: [{ id: governor.agentId, handle: governorP?.handle ?? undefined, name: governorP?.name }] },
      });
      recipients = res.data.recipients.map((r) => r.id);
      return { id: res.data.id };
    },
    readPostedAt: async (id) => {
      const item = (await readRoom([director], urls, room.roomId)).find((m) => m.id === id);
      return item ? new Date(item.at) : null;
    },
  });
  if (!posted.ok && !posted.messageId) {
    console.log(`Re-delivery not posted: ${posted.errors.join("; ")}`);
    await stop(agents, secrets);
    return 1;
  }
  const redeliveryId = posted.ok ? posted.messageId : posted.messageId!;
  console.log(`\nRe-delivered as Placement Director: ${redeliveryId}${posted.ok ? `, runtime ${posted.timestamp}, BAND ${posted.postedAt}, skew ${posted.skewMs} ms` : `, verification FAILED: ${posted.errors.join("; ")}`}`);

  // 5. Observe until Release Governor posts.
  let reply: RoomItem | null = null;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !reply) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      reply = (await readRoom([governor], urls, room.roomId)).find((m) => m.senderId === governor.agentId && m.type === "text") ?? null;
    } catch (error) {
      console.log(`  room read failed: ${safeErrorMessage(error, secrets)}`);
    }
  }
  if (reply) await new Promise((r) => setTimeout(r, SETTLE_MS));

  console.log("\nStopping Release Governor");
  const clean = await stop(agents, secrets);

  // 6. Verify from BAND.
  const after = await readRoom([governor, director], urls, room.roomId);
  const redeliveryItem = after.find((m) => m.id === redeliveryId) ?? null;
  reply = after.find((m) => m.id === reply?.id) ?? reply;
  const runItems = after.filter((m) => !priorItems.some((p) => p.id === m.id));
  const agentEvents = runItems.filter((m) => m.senderType === "Agent" && m.type !== "text");
  const inputs = runItems.filter((m) => m.senderId === director.agentId && m.type === "text");
  const replies = runItems.filter((m) => m.senderId === governor.agentId && m.type === "text");
  const finalParticipants = (await ensureCaseRoom({ caseId: CASE_ID, title: ROOM_TITLE, owner: director, urls, memberIds: () => [] })).participants;
  const runIds = new Set(runItems.map((m) => m.id));
  const unrelated: string[] = [];
  for (const c of others) {
    const b = statusBefore.get(c.role)!;
    const a = await deliveryStatus(c, urls, room.roomId);
    for (const id of [...a.processing, ...a.processed, ...a.failed]) if (runIds.has(id) && !b.processed.includes(id)) unrelated.push(`${c.role}:${id}`);
  }
  const absent = (["content-curator", "scene-scout", "campaign-matcher"] as const).filter((r) => !finalParticipants.some((p) => p.id === byRole.get(r)!.agentId));
  const queues = Object.fromEntries(
    await Promise.all([director, governor].map(async (c) => [c.role, await deliveryStatus(c, urls, room.roomId)] as const)),
  ) as Record<string, Record<string, string[]>>;

  const gate = events.find((e) => e.kind === "Accepted message at handoff boundary" && e.ctx.message === redeliveryId);
  const stamps = events.filter((e) => e.kind === "Stamped handoff at send boundary");
  const toolsUsed = [...new Set(events.filter((e) => e.kind === "Evidence tool called").map((e) => String(e.ctx.tool)))];
  const blocked = events.filter((e) => /Blocked|Suppressed/.test(e.kind));
  const firstClaude = claudeCalls[0];
  const envelope = reply ? envelopeOf(reply.content) : null;
  const review = envelope?.artifact?.kind === "governor-review" ? envelope.artifact : undefined;
  const readable = reply ? readableOf(reply.content) : "";
  const replyFresh = envelope && reply ? checkHandoffTimestamp(envelope.timestamp, { now: new Date(), postedAt: new Date(reply.at) }) : null;
  const reviewErrors = review ? validateGovernorReview(review, { caseId: envelope?.caseId, decision: envelope?.decision, artifactId: envelope?.artifactId }) : ["no review"];
  const outputErrors = envelope ? validateResult(envelope, readable) : ["no envelope"];
  const bandHost = new URL(urls.restUrl ?? "https://app.band.ai").host;
  const allowedHosts = new Set(["api.anthropic.com", bandHost]);
  const unexpectedHosts = [...contactedHosts].filter((h) => !allowedHosts.has(h));
  const unchanged =
    redeliveryItem !== null &&
    (() => {
      const sent = envelopeOf(redeliveryItem.content);
      return sent !== null && JSON.stringify({ ...(originalBlock.value as HandoffEnvelope), timestamp: null }) === JSON.stringify({ ...sent, timestamp: null });
    })();
  const allEvidence = [...(envelope?.evidence ?? []), ...(review?.evidence ?? []), ...(review?.checks ?? []).map((c) => ({ claim: c.detail, source: c.source }))];
  const approvedPrefixes = APPROVED_EVIDENCE_SOURCES["release-governor"] ?? [];
  const correctionKinds = review?.corrections.map((c) => c.kind) ?? [];

  console.log("\nLive messages");
  for (const m of runItems) {
    const mentions = m.mentions.map((id) => `@${byId.get(id)?.handle ?? id}`).join(", ") || "none";
    console.log(`  ${m.at}  ${m.id}  ${label(byId.get(m.senderId), m.senderName)} [${m.senderType}] type=${m.type} mentions=${mentions}`);
  }
  console.log("\nHandoff boundary");
  if (gate) console.log(`  Release Governor ACCEPTED ${gate.ctx.message} from ${gate.ctx.senderRole} [${gate.ctx.senderType}] (handoff ${gate.ctx.handoffTimestamp}, BAND ${gate.ctx.postedAt}, skew ${gate.ctx.timestampSkewMs} ms, room history withheld: ${gate.ctx.historyWithheld} item(s))`);
  console.log(`  Evidence tools used: ${toolsUsed.join(", ") || "none"}`);
  console.log(`  Send-boundary blocks or suppressions: ${blocked.length}${blocked.length ? ` (${blocked.map((b) => `${b.kind}: ${JSON.stringify(b.ctx).slice(0, 300)}`).join("; ")})` : ""}`);
  console.log(`  Hosts contacted over fetch: ${[...contactedHosts].join(", ")}`);
  if (envelope) {
    console.log("\nRelease Governor handoff");
    console.log(`  ${envelope.senderRole} → ${envelope.recipientRole}, decision=${envelope.decision}, case=${envelope.caseId}, artifact=${envelope.artifactId}, confidence=${envelope.confidence}, blockers=${envelope.blockers.length}`);
    console.log(`  runtime ${envelope.timestamp}, BAND ${reply?.at}, ${replyFresh?.ok ? `skew ${replyFresh.skewMs} ms (±${CLOCK_SKEW_MS / 1000}s)` : "NOT fresh"}`);
  }
  if (review) {
    console.log("\nGovernor review");
    console.log(`  reviewId=${review.reviewId}; subject ${review.subject.titleId} / ${review.subject.sceneId} / ${review.subject.campaignId} / ${review.subject.planId}`);
    for (const [k, v] of Object.entries(review.hhh)) console.log(`  hhh.${k}: ${v.outcome} — ${v.rationale.slice(0, 200)}`);
    for (const c of review.checks) console.log(`  check ${c.id} [${c.category}] ${c.outcome} — ${c.detail.slice(0, 160)} (${c.source.slice(0, 80)})`);
    console.log(`  blockers: ${review.blockers.map((b) => b.slice(0, 160)).join(" | ")}`);
    for (const c of review.corrections) console.log(`  correction [${c.kind}] ${c.issue.slice(0, 120)} → ${c.requiredAction.slice(0, 220)}`);
    console.log(`  preview: ${review.preview.status}, assetRef=${review.preview.assetRef}, provenance=${review.preview.provenance === null ? "null" : "set"}, metadata=${review.preview.generationMetadata === null ? "null" : "set"}; humanApproval=${review.humanApproval.status}`);
    console.log(`  uncertainty: ${review.uncertainty.slice(0, 200)}`);
    console.log(`  review errors: ${reviewErrors.length ? reviewErrors.join("; ") : "none"}; output-rule errors: ${outputErrors.length ? outputErrors.join("; ") : "none"}`);
  }
  console.log(`\nEvidence and check sources (${allEvidence.length}):`);
  for (const e of allEvidence) console.log(`  - ${e.source.slice(0, 150)}`);
  console.log(`\nClaude calls: ${claudeCalls.length} (${claudeCalls.map((c) => c.stopReason).join(", ")})`);
  for (const [role, q] of Object.entries(queues)) {
    console.log(`Queue in ${ROOM_TITLE} for ${role}: pending=${q.pending.join(",") || "-"} processing=${q.processing.join(",") || "-"} processed=${q.processed.join(",") || "-"} failed=${q.failed.join(",") || "-"}`);
  }

  const claimText = `${reply?.content ?? ""}`;
  const checks: [string, boolean][] = [
    ["Fresh room with exactly the BAND User, Placement Director, and Release Governor, no prior messages",
      room.created && priorItems.filter((m) => m.type === "text").length === 0 && finalParticipants.length === 3 &&
        [director, governor].every((c) => finalParticipants.some((p) => p.id === c.agentId)) && finalParticipants.filter((p) => p.type === "User").length === 1],
    ["Re-delivery keeps every original handoff field except the timestamp", unchanged],
    ["Exactly one input, posted by the authenticated Placement Director identity", inputs.length === 1 && redeliveryItem?.senderId === director.agentId && redeliveryItem.senderType === "Agent"],
    ["Re-delivery mentions and is routed only to Release Governor", redeliveryItem?.mentions.join() === governor.agentId && recipients.length > 0 && recipients.every((id) => id === governor.agentId)],
    ["Re-delivery stamped immediately before POST and fresh against BAND's posting time", posted.ok],
    ["Release Governor authenticated Placement Director and validated the timestamp before Claude",
      Boolean(gate && gate.ctx.senderRole === "placement-director" && gate.ctx.handoffTimestamp === (posted.ok ? posted.timestamp : "") && firstClaude && gate.at <= Date.parse(firstClaude.at))],
    ["Release Governor received no room history (evidence isolation)", typeof gate?.ctx.historyWithheld === "number"],
    ["Release Governor used Claude and only approved read-only tools (all required ones)",
      claudeCalls.length > 0 && claudeCalls.every((c) => c.stopReason !== null) && REQUIRED_TOOLS.every((t) => toolsUsed.includes(t)) && toolsUsed.every((t) => APPROVED_TOOLS.has(t))],
    ["Exactly one readable Governor result with exactly one valid handoff: revise → placement-director, with blockers",
      replies.length === 1 && extractHandoffs(reply?.content ?? "").length === 1 && envelope?.senderRole === "release-governor" &&
        envelope.recipientRole === "placement-director" && envelope.decision === "revise" && envelope.blockers.length > 0 && readable.length > 0],
    ["Typed review is present and valid: revise, preview missing, human approval not recorded",
      Boolean(review) && reviewErrors.length === 0 && review!.decision === "revise" && review!.preview.status === "missing" &&
        review!.preview.assetRef === null && review!.humanApproval.status !== ("approved" as never) && Boolean(reply?.content.includes('"kind": "governor-review"'))],
    [`Review targets current records: ${TITLE_ID}, ${SCENE_ID}, ${CAMPAIGN_ID}, ${PLAN_ID}; no retired IDs`,
      review?.subject.titleId === TITLE_ID && review.subject.sceneId === SCENE_ID && review.subject.campaignId === CAMPAIGN_ID &&
        review.subject.planId === PLAN_ID && envelope?.artifactId === PLAN_ID && !/hate|hh-scene/i.test(reply?.content ?? "")],
    ["Actionable corrections request the preview, provenance, and evaluation evidence",
      MISSING_PREVIEW_CORRECTIONS.every((k) => correctionKinds.includes(k)) && (review?.corrections ?? []).every((c) => c.requiredAction.trim().length > 10)],
    ["HHH assessment and checks present; no technical check passes without a preview",
      Boolean(review) && Object.values(review!.hhh).every((h) => h.rationale.trim().length > 0) &&
        review!.checks.some((c) => c.category === "policy") && review!.checks.filter((c) => c.category === "technical").every((c) => c.outcome !== "pass")],
    ["No unsupported visual, approval, generation, or frame claims",
      visualClaims(claimText).length === 0 && generationClaims(claimText).length === 0 && misleadingFrameTerms(claimText).length === 0 &&
        !outputErrors.some((e) => /inspected|generation|frame/.test(e))],
    ["Every evidence and check source cites the handoff or an approved Governor tool; no room history",
      allEvidence.length > 0 && allEvidence.every((e) => approvedPrefixes.some((p) => e.source.trim().toLowerCase().startsWith(p))) &&
        !outputErrors.some((e) => /evidence|room history/.test(e))],
    [`States exactly: "${NO_PREVIEW_DISCLOSURE}" and "${PLACEMENT_DIRECTOR_DISCLOSURE}"`, readable.includes(NO_PREVIEW_DISCLOSURE) && readable.includes(PLACEMENT_DIRECTOR_DISCLOSURE)],
    ["Visible result mentions only the human User (Placement Director present but not running; recipientRole kept)",
      Boolean(human && reply && reply.mentions.length === 1 && reply.mentions[0] === human.id) && envelope?.recipientRole === "placement-director"],
    ["Release Governor handoff stamped at send and fresh against BAND's posting time", Boolean(replyFresh?.ok && stamps.some((s) => s.ctx.timestamp === envelope?.timestamp))],
    ["No thought, status, or other agent event posted", agentEvents.length === 0],
    ["No external media API called (only BAND and Anthropic hosts contacted)", unexpectedHosts.length === 0 && contactedHosts.size > 0],
    ["No other agent processed a message; Placement Director did not consume; other roles absent", unrelated.length === 0 && absent.length === 3],
    ["No message remains pending, processing, or failed for Placement Director or Release Governor",
      Object.values(queues).every((q) => q.pending.length === 0 && q.processing.length === 0 && q.failed.length === 0)],
    ["Release Governor stopped cleanly", clean],
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
    console.error(`Governor test failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
