/**
 * Bounded delivery of the persisted, human-directed LUV plan v3 to the Release
 * Governor for case NF-DEMO-0001, pinned to exact records.
 *
 * Preflight (default, read-only): revalidates plan v3 against its approved
 * canonical sha256, requires the case to be open with no Governor review, and
 * requires the Governor's preview evidence to pass for the pinned fallback
 * preview, checksum, and approved visual review. It builds and validates the
 * Placement Director handoff that would carry the stored plan unchanged. It
 * reads Supabase only: no BAND, Claude, or media call, and no write.
 *
 * Live (only with --live=<plan ID> and a fresh --room-title): repeats the
 * preflight, creates a fresh BAND room owned by Placement Director with exactly
 * the human owner, Placement Director, and Release Governor, posts the stored
 * plan unchanged as Placement Director (stamped immediately before the POST),
 * and starts only Release Governor with mentions limited to the human. Its
 * review is persisted only by guardedSaveGovernorReview (approve-for-human-review
 * with preview evidence recomputed just before the write); otherwise nothing is
 * written. It stops before human approval. Placement Director is never started.
 *
 * Run (preflight): npm run agents:deliver-plan-v3
 * Run (live):      npm run agents:deliver-plan-v3 -- --live=plan:daybreak-cold-brew:luv-scene-1:v3 --room-title=NF-DEMO-0001-LUV-GOVERNOR-V3-R1
 */
import type { Logger } from "@band-ai/sdk/core";
import { bandClientFor, ensureCaseRoom } from "@/agents/band/case-room";
import { postWithTrustedTimestamp } from "@/agents/band/post";
import { collectSecrets, ConfigError, loadLocalEnv, readAllCredentials, readAnthropicKey, readBandUrls, type RoleCredentials } from "@/agents/config/env";
import { AGENT_MODEL, turnLimitsFor } from "@/agents/config/model";
import { AGENT_REGISTRY } from "@/agents/config/roles";
import type { GovernorReview } from "@/agents/handoff/governor-review";
import { extractHandoffs, HANDOFF_FENCE } from "@/agents/handoff/protocol";
import type { ClaudeCallRecord } from "@/agents/runtime/claude-client";
import { evaluatePreviewEvidence } from "@/agents/media/preview-evidence";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { PersistentSourceFrameRegistry } from "@/agents/persistence/source-frames";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { createNativeFrameAgents } from "@/agents/runtime/create-agents";
import { buildDirectorDelivery, guardedSaveGovernorReview, preflightGovernorDelivery, type DeliveryPin } from "@/agents/runtime/governor-delivery";
import { createRedactingLogger, redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const PIN: DeliveryPin = Object.freeze({
  caseId: "NF-DEMO-0001",
  planId: "plan:daybreak-cold-brew:luv-scene-1:v3",
  planSha256: "8643a97e76b3b9c9c4f2381db65f1d89e5c6ca24736393f6c7f3ec2283d6f579",
  previewAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback",
  previewChecksum: "sha256:4188bc88b082bce4a402132239bcae06348414e84b3027741281d61330af6bff",
  visualReviewId: "56f9e9f9-d22c-44ec-bf93-fc0855a7c741",
});
const SCENE_ID = "luv-scene-1";
const POLL_MS = 4_000;
const SETTLE_MS = 8_000;
const WAIT_MS = turnLimitsFor("release-governor").turnTimeoutMs + 2 * 60_000;
const STOP_TIMEOUT_MS = 10_000;

/** Hostnames this process contacts over fetch. */
const contactedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  try {
    contactedHosts.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host);
  } catch {
    contactedHosts.add("unparsed");
  }
  return realFetch(input, init);
}) as typeof fetch;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Records the gate, send-boundary, and persistence events of the run (log message and its redacted context). */
type AuditEvent = { message: string; context: Record<string, unknown> };
const AUDITED = /handoff boundary|send boundary|Evidence tool called|Governor review|Blocked|Suppressed|Post-send hook/;
function auditLogger(base: Logger, events: AuditEvent[]): Logger {
  const record = (message: string, context?: Record<string, unknown>) => {
    if (AUDITED.test(message)) events.push({ message, context: context ?? {} });
  };
  return {
    debug: (m, c) => base.debug(m, c),
    info: (m, c) => (record(m, c), base.info(m, c)),
    warn: (m, c) => (record(m, c), base.warn(m, c)),
    error: (m, c) => (record(m, c), base.error(m, c)),
  };
}
const BLOCK = new RegExp("```" + HANDOFF_FENCE + "\\s*\\n[\\s\\S]*?\\n```", "g");

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (s: string) => console.log(redactSecrets(s, secrets));
  const live = arg("live");
  if (live !== undefined && live !== PIN.planId) return (out(`--live must repeat the exact plan ID ${PIN.planId}. Nothing was done.`), 1);
  const roomTitle = arg("room-title");
  if (live && !(roomTitle && /^[\w.-]{1,120}$/.test(roomTitle))) return (out("A live run needs a fresh --room-title. Nothing was done."), 1);

  let credentials: RoleCredentials[];
  try {
    credentials = readAllCredentials(process.env);
  } catch (error) {
    if (error instanceof ConfigError) return (out(error.message), 1);
    throw error;
  }
  const director = credentials.find((c) => c.role === "placement-director")!;
  const governor = credentials.find((c) => c.role === "release-governor")!;
  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!store || !storage) return (out("Supabase is not configured. Nothing was done."), 1);
  const workflow = new WorkflowRegistry(store);
  const evidence = (planId: string) => evaluatePreviewEvidence({ workflow, store, storage }, planId);
  const deps = { workflow, store, evidence };

  // 1. Preflight (read-only).
  const pre = await preflightGovernorDelivery(deps, PIN);
  if (!pre.ok) return (out(`Preflight FAILED:\n  - ${pre.errors.join("\n  - ")}\nNothing was done.`), 1);
  out(`Plan ${PIN.planId} revalidates; canonical sha256 ${pre.value.planSha256} (pinned ${PIN.planSha256}); case ${PIN.caseId} is open with no Governor review.`);
  out(`Preview evidence: ${pre.value.evidence.outcome.toUpperCase()} — ${pre.value.evidence.detail}`);
  const frames = new PersistentSourceFrameRegistry(workflow);
  await frames.refreshScene(PIN.caseId, SCENE_ID);
  out(`Visual disclosure (derived from registered provenance): "${pre.value.disclosure}"`);
  const draft = buildDirectorDelivery(pre.value.plan, { governorMention: "@release-governor", frames, disclosure: pre.value.disclosure });
  if (!draft.ok) return (out(`The Placement Director handoff does not validate: ${draft.errors.join("; ")}. Nothing was done.`), 1);
  out(`Placement Director handoff: instructions-ready → release-governor, artifact ${PIN.planId} byte-identical to the stored plan; validates as the send boundary will, with the derived disclosure.`);
  out(`\nExpected BAND room participants (exactly 3): the human owner of the NativeFrame agents [User]; ${AGENT_REGISTRY["placement-director"].displayName} [Agent ${director.agentId}]; ${AGENT_REGISTRY["release-governor"].displayName} [Agent ${governor.agentId}].`);
  out(
    [
      "Expected calls in a live run: BAND (identity lookup, room create + 2 participant adds, one Placement Director post, room reads, Release Governor connection), Anthropic Claude (Release Governor turns only), Supabase (reads; plan re-save is a no-op).",
      "Expected writes in a live run: one BAND room and one Placement Director message; the Release Governor's one reply; at most one Governor review row and the case status change to awaiting-human-review, only through the guard. No plan, media, visual-review, or human-approval write. No Reactor, Gemini, Masky, or LangSmith call.",
    ].join("\n"),
  );
  if (!live) {
    out(`\nPreflight only: no BAND, Claude, or media call and no write. Hosts contacted: ${[...contactedHosts].join(", ")}.`);
    out(`To run live: --live=${PIN.planId} --room-title=<fresh title>.`);
    return 0;
  }

  // 2. Live: fresh room, stored plan delivered unchanged, only the Governor running.
  const urls = readBandUrls(process.env);
  const anthropicApiKey = readAnthropicKey(process.env);
  const room = await ensureCaseRoom({ caseId: PIN.caseId, title: roomTitle!, owner: director, urls, memberIds: (owner) => [governor.agentId, owner] });
  out(`\nBAND room "${room.title}" ${room.created ? "created" : "already existed"}: ${room.roomId}`);
  if (!room.created) return (out("The room already existed; use a fresh --room-title. Nothing was posted."), 1);
  const governorP = room.participants.find((p) => p.id === governor.agentId);
  const human = room.participants.find((p) => p.type === "User");
  if (room.participants.length !== 3 || !governorP || !human || !room.participants.some((p) => p.id === director.agentId)) {
    return (out("The room does not hold exactly the human owner, Placement Director, and Release Governor. Nothing was posted."), 1);
  }
  const delivery = buildDirectorDelivery(pre.value.plan, { governorMention: `@${governorP.handle ?? "release-governor"}`, frames, disclosure: pre.value.disclosure });
  if (!delivery.ok) return (out(`Handoff no longer validates: ${delivery.errors.join("; ")}. Nothing was posted.`), 1);

  const events: AuditEvent[] = [];
  const claudeCalls: ClaudeCallRecord[] = [];
  const guardResults: { ok: boolean; errors: string[] }[] = [];
  const [agent] = createNativeFrameAgents({
    credentials,
    roles: ["release-governor"],
    urls,
    anthropicApiKey,
    mentionHumanOnly: true,
    workflow,
    previewEvidence: evidence,
    persistGovernorReview: async (envelope) => {
      const result = await guardedSaveGovernorReview(deps, PIN, envelope);
      guardResults.push(result.ok ? { ok: true, errors: [] } : { ok: false, errors: result.errors });
      return result.ok ? { ok: true } : result;
    },
    loggerFor: (role) => auditLogger(createRedactingLogger(role, secrets), events),
    onClaudeCall: (r) => {
      claudeCalls.push(r);
      out(`  [claude] ${r.model}, stop=${r.stopReason}, tokens in/out=${r.inputTokens}/${r.outputTokens}, ${r.durationMs} ms`);
    },
  });
  const stop = async () => {
    try {
      return await agent.agent.stop(STOP_TIMEOUT_MS);
    } catch {
      return false;
    }
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  out(`Starting only Release Governor (model ${AGENT_MODEL}).`);
  await agent.agent.start();

  const directorClient = bandClientFor(director, urls);
  const readItems = async (c: RoleCredentials) => (await bandClientFor(c, urls).agentApiContext.getAgentChatContext(room.roomId, { page: 1, page_size: 50 })).data;
  const posted = await postWithTrustedTimestamp({
    draftContent: delivery.value.draftContent,
    post: async (content) => {
      const res = await directorClient.agentApiMessages.createAgentChatMessage(room.roomId, {
        message: { content, mentions: [{ id: governor.agentId, handle: governorP.handle ?? undefined, name: governorP.name }] },
      });
      return { id: res.data.id };
    },
    readPostedAt: async (id) => {
      const m = (await readItems(director)).find((x) => x.id === id);
      return m?.inserted_at ? new Date(m.inserted_at) : null;
    },
    registries: delivery.value.registries,
  });
  out(posted.ok ? `Delivered as Placement Director: ${posted.messageId} (skew ${posted.skewMs} ms)` : `Delivery FAILED at ${posted.stage}: ${posted.errors.join("; ")}`);

  let replied = false;
  const deadline = Date.now() + WAIT_MS;
  while (posted.ok && !replied && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      replied = (await readItems(governor)).some((m) => m.sender_id === governor.agentId && m.message_type === "text");
    } catch (error) {
      out(`  room read failed: ${safeErrorMessage(error, secrets)}`);
    }
  }
  if (replied) await new Promise((r) => setTimeout(r, SETTLE_MS));
  out(`Release Governor ${replied ? "replied" : "did not reply in time"}; stopping: ${(await stop()) ? "stopped" : "stop timed out"}.`);

  // 3. Read back the room (both identities' views) and the Governor's handoff.
  const items = new Map<string, Awaited<ReturnType<typeof readItems>>[number]>();
  for (const c of [director, governor]) for (const m of await readItems(c)) items.set(m.id, m);
  const messages = [...items.values()].sort((a, b) => String(a.inserted_at).localeCompare(String(b.inserted_at)));
  out("\nRoom messages:");
  for (const m of messages) {
    const mentions = Array.isArray(m.metadata?.mentions) ? (m.metadata.mentions as { id?: string }[]).map((x) => x?.id).join(",") : "";
    out(`  ${m.inserted_at}  ${m.id}  ${m.sender_name ?? m.sender_type} [${m.sender_type}] type=${m.message_type} mentions=${mentions || "none"}`);
  }
  const reply = messages.find((m) => m.sender_id === governor.agentId && m.message_type === "text");
  if (reply) {
    out(`\nRelease Governor readable result:\n${reply.content.replace(BLOCK, "").trim()}`);
    const [block] = extractHandoffs(reply.content);
    const env = block?.ok ? (block.value as Record<string, unknown>) : null;
    const review = env?.artifact as GovernorReview | undefined;
    if (env) out(`\nHandoff: ${env.senderRole} → ${env.recipientRole}, decision=${env.decision}, case=${env.caseId}, artifact=${env.artifactId}, timestamp=${env.timestamp}`);
    if (review?.kind === "governor-review") {
      out(`Review ${review.reviewId}: decision=${review.decision}`);
      for (const [k, v] of Object.entries(review.hhh)) out(`  hhh.${k}: ${v.outcome} — ${v.rationale}`);
      for (const c of review.checks) out(`  check ${c.id} [${c.category}] ${c.outcome} — ${c.detail} (${c.source})`);
      out(`  blockers: ${JSON.stringify(review.blockers)}`);
      out(`  corrections: ${JSON.stringify(review.corrections)}`);
      out(`  preview: ${JSON.stringify(review.preview)}`);
      out(`  humanApproval: ${review.humanApproval.status}; uncertainty: ${review.uncertainty}`);
    }
  }
  out("\nAudit events:");
  for (const e of events) out(`  ${e.message} ${JSON.stringify(e.context).slice(0, 400)}`);
  out(`Save-time guard results: ${guardResults.length === 0 ? "not invoked" : guardResults.map((g) => (g.ok ? "PERSISTED" : `REFUSED: ${g.errors.join(" | ")}`)).join("; ")}`);
  const totals = claudeCalls.reduce((t, c) => ({ in: t.in + c.inputTokens, out: t.out + c.outputTokens, ms: t.ms + c.durationMs }), { in: 0, out: 0, ms: 0 });
  out(`Claude calls: ${claudeCalls.length}; tokens in/out ${totals.in}/${totals.out}; ${totals.ms} ms. Cost is not recorded by the runtime.`);

  // 4. Read back from storage.
  const reviews = await store.listReviewsForCase(PIN.caseId, 5);
  const caseRow = await store.getCase(PIN.caseId);
  out(`\nGovernor reviews for ${PIN.caseId}: ${reviews.length}; case status: ${caseRow?.status}`);
  for (const r of reviews) out(JSON.stringify(r, null, 2));
  out(`Hosts contacted: ${[...contactedHosts].join(", ")}`);
  out("Stopped before human approval.");
  return posted.ok && replied && reviews.length === 1 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`deliver-plan-v3 failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
