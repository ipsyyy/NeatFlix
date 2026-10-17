/**
 * Bounded LangSmith trace and evaluation of one NativeFrame case, rebuilt
 * read-only from the workflow registry (see agents/observability/case-trace.ts).
 *
 * Preflight (default): reads Supabase only, builds and sanitizes the trace,
 * scans the exact payload for secrets, URLs, private media references, and
 * reviewer ids, and prints the runs, evaluations, and the calls a publish
 * would make. No LangSmith request.
 *
 * Publish (only with --publish=<the same case id>): sends each run (POST /runs,
 * parents first) and each evaluation (POST /feedback) once, with stable ids,
 * so a repeat targets the same records. Failures are reported by HTTP status;
 * NativeFrame itself is never affected. Writes nothing to Supabase.
 *
 * Run (preflight): npm run langsmith:trace-case
 * Run (publish):   npm run langsmith:trace-case -- --publish=NF-DEMO-0001
 */
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { buildCaseTrace } from "@/agents/observability/case-trace";
import { langSmithConfigFromEnv, payloadLeaks, publishTrace } from "@/agents/observability/langsmith";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const CASE_ID = "NF-DEMO-0001";

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (s: string) => console.log(redactSecrets(s, secrets));
  const publish = process.argv.find((a) => a.startsWith("--publish="))?.slice("--publish=".length);
  if (publish !== undefined && publish !== CASE_ID) return (out(`--publish must repeat the exact case id ${CASE_ID}. Nothing was sent.`), 1);

  const config = langSmithConfigFromEnv(process.env);
  out(`LangSmith: ${config.ok ? `enabled, project "${config.value.project}", endpoint host ${new URL(config.value.endpoint).host}` : `off (${config.reason})`}`);
  const store = createWorkflowStoreFromEnv(process.env);
  if (!store) return (out("Supabase is not configured. Nothing was done."), 1);

  const built = await buildCaseTrace(store, { caseId: CASE_ID, project: config.ok ? config.value.project : "nativeframe", secrets });
  if (!built.ok) return (out(`The trace could not be built: ${built.errors.join(" ")}`), 1);
  const { trace, evaluations } = built;

  // Identity values the sanitizer must have removed.
  const identities = new Set<string>();
  for (const r of await store.listReviewsForCase(CASE_ID, 10)) {
    const a = await store.getApprovalForReview(r.review_id);
    if (a) identities.add(a.reviewer_user_id);
  }
  const payload = trace.payload();
  const leaks = payloadLeaks(payload, secrets, [...identities]);

  out(`\nTrace for ${CASE_ID} (${trace.runs.length} runs, ${trace.feedback.length} evaluation results, ${payload.length} bytes, trace id ${built.root.trace_id}):`);
  const depth = (order: string) => order.split(".").length - 1;
  for (const r of trace.runs) out(`  ${"  ".repeat(depth(r.dotted_order))}${r.name} [${r.run_type}] ${r.start_time}`);
  out("\nEvaluations on the case run:");
  for (const e of evaluations) out(`  ${e.key}: ${e.score} — ${e.comment}`);
  const perRun = trace.feedback.length - evaluations.length;
  if (perRun > 0) out(`  plus ${perRun} per-run human visual decision result(s)`);
  out(`\nPayload safety scan: ${leaks.length === 0 ? "clean (no secrets, keys, URLs, private storage references, or reviewer ids)" : `UNSAFE: contains ${leaks.join(", ")}`}`);
  out(
    `Calls a publish makes: ${trace.runs.length} × POST /runs and ${trace.feedback.length} × POST /feedback to ${config.ok ? new URL(config.value.endpoint).host : "the LangSmith API host"}, with stable ids (a repeat targets the same records). No Supabase write; no BAND, Claude, Gemini, Reactor, or Masky call.`,
  );
  if (leaks.length > 0) return (out("Nothing was sent."), 1);
  if (publish === undefined) {
    out(`\nPreflight only: Supabase reads only; no LangSmith request. To publish: --publish=${CASE_ID}`);
    return config.ok ? 0 : 1;
  }
  if (!config.ok) return (out(`LangSmith is off: ${config.reason} Nothing was sent.`), 1);

  const summary = await publishTrace(config.value, trace);
  out(`\nPublished: ${summary.created} created, ${summary.existing} already present, ${summary.failed} failed (of ${summary.attempted}).`);
  for (const r of summary.results.filter((x) => x.outcome === "failed")) out(`  failed ${r.kind} ${r.id}: ${r.status === null ? "no response" : `HTTP ${r.status}`}`);
  if (summary.failed > 0) out("LangSmith did not accept every record; NativeFrame is unaffected and nothing was retried.");
  out(`Trace id: ${built.root.trace_id} in project "${config.value.project}".`);
  return summary.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`langsmith-trace-case failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
