import { createHash } from "node:crypto";

/**
 * Minimal, fail-safe LangSmith tracing and evaluation over its REST API
 * (https://docs.langchain.com/langsmith/trace-with-api): runs via POST /runs,
 * evaluation results as feedback via POST /feedback. Server-only.
 *
 * - Off unless LANGSMITH_TRACING=true and a LangSmith key is configured; the
 *   endpoint must be a LangSmith API host over https.
 * - Every input, output, metadata value, and error is sanitized before it is
 *   queued: configured secrets, key-shaped strings, URLs, private storage://
 *   references, and identity fields (user, owner, reviewer ids) are removed.
 * - Run and feedback ids are deterministic UUIDv7: the 48-bit timestamp is the
 *   run's recorded start time and the rest is derived from a stable name, so
 *   publishing the same trace twice targets the same ids instead of creating a
 *   duplicate trace.
 * - Publishing never throws: failures are reported as HTTP status codes only,
 *   so LangSmith being unavailable never affects NativeFrame.
 */

export const LANGSMITH_DEFAULT_ENDPOINT = "https://api.smith.langchain.com";
const LANGSMITH_HOST = /^(?:(?:eu|apac|aws)\.)?api\.smith\.langchain\.com$/;
const LANGSMITH_KEY = /^lsv2_[A-Za-z0-9_]{16,}$/;
export const MAX_TRACE_RUNS = 50;
export const MAX_TRACE_FEEDBACK = 40;
const REQUEST_TIMEOUT_MS = 10_000;

export type LangSmithConfig = { endpoint: string; apiKey: string; project: string };

/** The LangSmith configuration from server env, or why tracing is off. Never includes the key in a reason. */
export function langSmithConfigFromEnv(env: Record<string, string | undefined>): { ok: true; value: LangSmithConfig } | { ok: false; reason: string } {
  if (env.LANGSMITH_TRACING?.trim().toLowerCase() !== "true") return { ok: false, reason: "LANGSMITH_TRACING is not true." };
  const apiKey = env.LANGSMITH_API_KEY?.trim() ?? "";
  if (!LANGSMITH_KEY.test(apiKey)) return { ok: false, reason: "LANGSMITH_API_KEY is missing or not a LangSmith key (lsv2_...)." };
  const raw = env.LANGSMITH_ENDPOINT?.trim() || LANGSMITH_DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "LANGSMITH_ENDPOINT is not a URL." };
  }
  if (url.protocol !== "https:" || !LANGSMITH_HOST.test(url.hostname) || url.username || url.password) return { ok: false, reason: "LANGSMITH_ENDPOINT must be an https LangSmith API host." };
  const project = env.LANGSMITH_PROJECT?.trim() || "nativeframe";
  if (!/^[\w .:-]{1,100}$/.test(project)) return { ok: false, reason: "LANGSMITH_PROJECT has unsupported characters." };
  return { ok: true, value: { endpoint: url.origin, apiKey, project } };
}

/** Field names whose values identify a person or carry a credential (snake_case or camelCase). */
const IDENTITY_KEY = /(user_?id|owner(_?(uuid|id))?|sender_?id|api_?key|secret|token|password|authorization)$/i;
const KEY_SHAPED = /\b(lsv2_[A-Za-z0-9_]+|mky_[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+)\b/g;
const MAX_STRING = 2_000;

/** A deep copy safe to send to LangSmith: no secrets, URLs, private media references, or identity fields. */
export function sanitize(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    let s = value;
    for (const secret of secrets) if (secret.length >= 8) s = s.split(secret).join("[redacted]");
    s = s.replace(KEY_SHAPED, "[redacted]").replace(/storage:\/\/\S+/g, "[private-media]").replace(/https?:\/\/\S+/g, "[url]");
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, secrets, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 80)
        .map(([k, v]) => [k, IDENTITY_KEY.test(k) ? "[redacted]" : sanitize(v, secrets, depth + 1)]),
    );
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : String(value);
}

/**
 * A deterministic UUIDv7 (RFC 9562): the first 48 bits are `time` in Unix
 * milliseconds, then version 7, the RFC variant, and 74 bits derived from
 * `name`. The same name and time always give the same id.
 */
export function stableUuidV7(name: string, time: string): string {
  const ms = Date.parse(time);
  if (!Number.isFinite(ms) || ms < 0 || ms >= 2 ** 48) throw new Error("Invalid UUIDv7 time.");
  const hash = createHash("sha256").update(`nativeframe:${name}`).digest("hex");
  const hex = ms.toString(16).padStart(12, "0") + "7" + hash.slice(0, 3) + ((parseInt(hash[3], 16) & 0x3) | 0x8).toString(16) + hash.slice(4, 19);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** LangSmith's dotted_order time segment: %Y%m%dT%H%M%S%fZ (microseconds). */
export function dottedStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid run time.");
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds() * 1000, 6)}Z`;
}

export type RunType = "chain" | "llm" | "tool";
export type TraceRun = {
  id: string;
  trace_id: string;
  parent_run_id?: string;
  dotted_order: string;
  name: string;
  run_type: RunType;
  start_time: string;
  end_time: string;
  inputs: unknown;
  outputs: unknown;
  extra: { metadata: unknown };
  tags: string[];
  error?: string;
  session_name: string;
};
export type TraceFeedback = { id: string; run_id: string; trace_id: string; key: string; score: number; comment: string; feedback_source: { type: "api"; metadata: { evaluator: string } } };

/** Builds one trace (runs and evaluation feedback), sanitizing everything as it is added. */
export class TraceBuilder {
  readonly runs: TraceRun[] = [];
  readonly feedback: TraceFeedback[] = [];

  constructor(
    private readonly project: string,
    private readonly secrets: readonly string[],
    /** Stable namespace for ids, e.g. the case id and trace version. */
    private readonly namespace: string,
  ) {}

  add(spec: { key: string; name: string; runType: RunType; start: string; end: string; inputs: unknown; outputs: unknown; metadata: Record<string, unknown>; tags?: string[]; error?: string; parent?: TraceRun }): TraceRun {
    if (this.runs.length >= MAX_TRACE_RUNS) throw new Error(`A trace may hold at most ${MAX_TRACE_RUNS} runs.`);
    const id = stableUuidV7(`${this.namespace}:run:${spec.key}`, spec.start);
    if (this.runs.some((r) => r.id === id)) throw new Error(`Duplicate run key ${spec.key}.`);
    const parent = spec.parent;
    if (parent && Date.parse(spec.start) < Date.parse(parent.start_time)) throw new Error(`Run ${spec.key} starts before its parent.`);
    const run: TraceRun = {
      id,
      trace_id: parent ? parent.trace_id : id,
      ...(parent ? { parent_run_id: parent.id } : {}),
      dotted_order: `${parent ? `${parent.dotted_order}.` : ""}${dottedStamp(spec.start)}${id}`,
      name: String(sanitize(spec.name, this.secrets)),
      run_type: spec.runType,
      start_time: new Date(spec.start).toISOString(),
      end_time: new Date(Math.max(Date.parse(spec.end), Date.parse(spec.start))).toISOString(),
      inputs: sanitize(spec.inputs, this.secrets),
      outputs: sanitize(spec.outputs, this.secrets),
      extra: { metadata: sanitize(spec.metadata, this.secrets) },
      tags: (spec.tags ?? []).map((t) => String(sanitize(t, this.secrets))),
      ...(spec.error ? { error: String(sanitize(spec.error, this.secrets)) } : {}),
      session_name: this.project,
    };
    this.runs.push(run);
    return run;
  }

  score(run: TraceRun, key: string, score: number, comment: string): void {
    if (this.feedback.length >= MAX_TRACE_FEEDBACK) throw new Error(`A trace may hold at most ${MAX_TRACE_FEEDBACK} evaluation results.`);
    if (!/^[a-z0-9_]{1,80}$/.test(key) || !Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Invalid evaluation ${key}.`);
    this.feedback.push({
      id: stableUuidV7(`${this.namespace}:feedback:${run.id}:${key}`, run.start_time),
      run_id: run.id,
      trace_id: run.trace_id,
      key,
      score,
      comment: String(sanitize(comment, this.secrets)),
      feedback_source: { type: "api", metadata: { evaluator: "nativeframe-deterministic" } },
    });
  }

  /** Everything that would be sent, as one string (for safety scanning). */
  payload(): string {
    return JSON.stringify({ runs: this.runs, feedback: this.feedback });
  }
}

/** A sanitized validation problem from a 4xx response: field path, error code, and message only. */
export type ValidationDetail = { path: string; code: string; message: string };
/** What may be recorded about a failed response: no payload, header, URL, credential, path, or raw value. */
export type ErrorDiagnosis = {
  status: number;
  contentType: string;
  /** For JSON: field names and value types only. */
  shape: unknown;
  details: ValidationDetail[];
};
/** LangSmith accepts a run only if its start_time is within this window of the current time. */
export const ACCEPTANCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The replayed root starts at least this far inside the window. */
export const REPLAY_START_MARGIN_MS = 10 * 60 * 1000;
/** The replayed trace ends this long before now, so nothing is in the future. */
export const REPLAY_END_MARGIN_MS = 60 * 1000;

export type ReplayedTrace = {
  runs: TraceRun[];
  feedback: TraceFeedback[];
  shiftMs: number;
  recorded: { start: string; end: string };
  replayed: { start: string; end: string };
};

/**
 * A copy of a recorded trace for publishing as a historical replay: every
 * start_time, end_time, and dotted_order moves forward by one constant offset
 * so the whole trace lies inside LangSmith's acceptance window and ends just
 * before now. Ordering, hierarchy, durations, ids, and evaluations are
 * unchanged; each run keeps its recorded times and the offset in metadata.
 * Fails closed if the trace cannot fit with the safety margins.
 */
export function shiftForReplay(trace: Pick<TraceBuilder, "runs" | "feedback">, now: Date): { ok: true; value: ReplayedTrace } | { ok: false; reason: string } {
  if (trace.runs.length === 0) return { ok: false, reason: "The trace has no runs." };
  const starts = trace.runs.map((r) => Date.parse(r.start_time));
  const ends = trace.runs.map((r) => Date.parse(r.end_time));
  const recordedStart = Math.min(...starts);
  const recordedEnd = Math.max(...ends);
  const nowMs = now.getTime();
  const shiftMs = Math.max(0, nowMs - REPLAY_END_MARGIN_MS - recordedEnd);
  const replayStart = recordedStart + shiftMs;
  const replayEnd = recordedEnd + shiftMs;
  if (replayEnd > nowMs) return { ok: false, reason: "The recorded trace ends in the future." };
  if (replayStart < nowMs - ACCEPTANCE_WINDOW_MS + REPLAY_START_MARGIN_MS) {
    return { ok: false, reason: `The trace spans ${Math.round((recordedEnd - recordedStart) / 60_000)} minutes, too long to fit LangSmith's 24-hour window with the safety margins.` };
  }
  const shifted = (iso: string) => new Date(Date.parse(iso) + shiftMs).toISOString();
  const dotted = new Map<string, string>();
  const runs = trace.runs.map((r) => {
    const start = shifted(r.start_time);
    const parent = r.parent_run_id ? dotted.get(r.parent_run_id) : undefined;
    if (r.parent_run_id && parent === undefined) throw new Error("A run precedes its parent.");
    const order = `${parent ? `${parent}.` : ""}${dottedStamp(start)}${r.id}`;
    dotted.set(r.id, order);
    const metadata = { ...(r.extra.metadata as Record<string, unknown>), recorded_start_time: r.start_time, recorded_end_time: r.end_time, replay_shift_ms: shiftMs, replay: "historical replay of recorded case records" };
    return {
      ...r,
      ...(r.parent_run_id ? {} : { name: `${r.name} (historical replay)`, tags: [...r.tags.filter((t) => t !== "historical-replay"), "historical-replay"] }),
      start_time: start,
      end_time: shifted(r.end_time),
      dotted_order: order,
      extra: { metadata },
    };
  });
  return {
    ok: true,
    value: {
      runs,
      feedback: trace.feedback.map((f) => ({ ...f })),
      shiftMs,
      recorded: { start: new Date(recordedStart).toISOString(), end: new Date(recordedEnd).toISOString() },
      replayed: { start: new Date(replayStart).toISOString(), end: new Date(replayEnd).toISOString() },
    },
  };
}

export type PublishResult = {
  kind: "run" | "feedback";
  id: string;
  /** "skipped": not sent, because the run it belongs to (or its parent) failed. */
  outcome: "created" | "exists" | "failed" | "skipped";
  status: number | null;
  validation?: ValidationDetail[];
  diagnosis?: ErrorDiagnosis;
};
export type PublishSummary = { attempted: number; created: number; existing: number; failed: number; skipped: number; results: PublishResult[] };

const MAX_VALIDATION_DETAILS = 10;
/** Subtrees that echo request values or carry transport data: never read. */
const ECHO_KEYS = /^(input|inputs|ctx|context|value|values|body|request|payload|headers|url|uri|href|location|params|query|data|raw)$/i;
const MESSAGE_KEYS = ["msg", "message", "error", "detail", "title", "description", "reason"] as const;
const PATH_KEYS = ["loc", "path", "field", "fields", "pointer", "location_path", "param"] as const;
const CODE_KEYS = ["type", "code", "error_code", "kind"] as const;

/** Field names and value types only (no values), capped in depth and width. */
export function structureOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (Array.isArray(value)) return value.length === 0 ? [] : [structureOf(value[0], depth + 1)];
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .slice(0, 30)
        .map((k) => [k.replace(/[^\w.-]/g, "_").slice(0, 40), ECHO_KEYS.test(k) ? "(omitted)" : structureOf((value as Record<string, unknown>)[k], depth + 1)]),
    );
  }
  return value === null ? "null" : typeof value;
}

/**
 * A safe diagnosis of a failed response: status, content type (type/subtype
 * only), the JSON structure, and every validation-style entry found anywhere
 * in the body (field path, code, sanitized message). Plain text or HTML is
 * reduced to one sanitized, tag-stripped message. Echoing subtrees are never
 * read; nothing else is kept.
 */
export function diagnoseErrorResponse(status: number, contentType: string | null, bodyText: string, secrets: readonly string[]): ErrorDiagnosis {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const safeType = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(type) ? type : type ? "(unrecognized)" : "(none)";
  const clean = (v: unknown, max: number) =>
    String(sanitize((typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "").replace(/<[^>]*>/g, " "), secrets))
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  const segment = (x: unknown) => (typeof x === "number" ? String(x) : String(x).replace(/[^\w.-]/g, "_").slice(0, 40));
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText.slice(0, 64_000));
  } catch {
    const message = clean(bodyText, 300);
    return { status, contentType: safeType, shape: "(not JSON)", details: message ? [{ path: "(body)", code: "(text)", message }] : [] };
  }
  const details: ValidationDetail[] = [];
  const walk = (node: unknown, at: string[], depth: number) => {
    if (details.length >= MAX_VALIDATION_DETAILS || depth > 6) return;
    if (typeof node === "string") {
      if (at.length > 0 && (MESSAGE_KEYS as readonly string[]).includes(at[at.length - 1])) details.push({ path: at.slice(0, -1).join(".") || "(body)", code: "(none)", message: clean(node, 200) });
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, MAX_VALIDATION_DETAILS).forEach((x, i) => walk(x, [...at, String(i)], depth + 1));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    const messageKey = MESSAGE_KEYS.find((k) => typeof o[k] === "string");
    if (messageKey) {
      const pathKey = PATH_KEYS.find((k) => o[k] !== undefined);
      const rawPath = pathKey ? o[pathKey] : undefined;
      const path = Array.isArray(rawPath) ? rawPath.slice(0, 8).map(segment).join(".") : typeof rawPath === "string" ? segment(rawPath) : at.join(".");
      const codeKey = CODE_KEYS.find((k) => typeof o[k] === "string" || typeof o[k] === "number");
      details.push({ path: path || "(body)", code: codeKey ? clean(o[codeKey], 60) || "(none)" : "(none)", message: clean(o[messageKey], 200) });
    }
    for (const [k, v] of Object.entries(o)) {
      if (ECHO_KEYS.test(k) || k === messageKey || (PATH_KEYS as readonly string[]).includes(k) || (CODE_KEYS as readonly string[]).includes(k)) continue;
      if (typeof v === "object" && v !== null) walk(v, [...at, segment(k)], depth + 1);
      else if (!messageKey && typeof v === "string" && (MESSAGE_KEYS as readonly string[]).includes(k)) walk(v, [...at, k], depth + 1);
    }
  };
  walk(parsed, [], 0);
  return { status, contentType: safeType, shape: structureOf(parsed), details };
}

/**
 * The sanitized validation details of a 4xx body: FastAPI-style detail arrays
 * ({loc, type, msg}) or a problem title/detail string. Only field paths, error
 * codes, and sanitized messages are kept; echoed input, context, payloads, and
 * anything else are dropped.
 */
export function validationDetails(body: unknown, secrets: readonly string[]): ValidationDetail[] {
  const clean = (v: unknown, max: number) => String(sanitize(typeof v === "string" ? v : "", secrets)).replace(/[\u0000-\u001f]/g, " ").slice(0, max);
  const record = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const detail = record.detail;
  if (Array.isArray(detail)) {
    return detail.slice(0, MAX_VALIDATION_DETAILS).map((d) => {
      const item = typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
      const loc = Array.isArray(item.loc) ? item.loc : [];
      const path = loc.map((x) => (typeof x === "number" ? String(x) : String(x).replace(/[^\w.-]/g, "_").slice(0, 40))).slice(0, 8).join(".");
      return { path: path || "(unknown)", code: clean(item.type, 60) || "(none)", message: clean(item.msg ?? (typeof d === "string" ? d : ""), 200) };
    });
  }
  const message = clean(typeof detail === "string" ? detail : record.title ?? record.message, 200);
  return message ? [{ path: "(body)", code: clean(record.type ?? record.title, 60) || "(none)", message }] : [];
}

/**
 * Sends a trace: runs (parents first), then feedback. Never throws. An
 * existing id (HTTP 409) counts as already published. Children of a failed
 * run and feedback on a failed run are not sent.
 */
export async function publishTrace(
  config: LangSmithConfig,
  trace: Pick<TraceBuilder, "runs" | "feedback">,
  fetchImpl: typeof fetch = fetch,
  secrets: readonly string[] = [config.apiKey],
): Promise<PublishSummary> {
  const redact = [...new Set([...secrets, config.apiKey])];
  const results: PublishResult[] = [];
  const failedRuns = new Set<string>();
  const send = async (kind: PublishResult["kind"], id: string, path: string, body: unknown) => {
    let status: number | null = null;
    try {
      const res = await fetchImpl(`${config.endpoint}${path}`, {
        method: "POST",
        headers: { "x-api-key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      if (status >= 400 && status < 500 && status !== 409) {
        const text = await res.text().catch(() => "");
        const diagnosis = diagnoseErrorResponse(status, res.headers.get("content-type"), text, redact);
        results.push({ kind, id, outcome: "failed", status, diagnosis, ...(diagnosis.details.length ? { validation: diagnosis.details } : {}) });
        return "failed" as const;
      }
      await res.body?.cancel().catch(() => {});
    } catch {
      status = null;
    }
    const outcome: PublishResult["outcome"] = status !== null && status >= 200 && status < 300 ? "created" : status === 409 ? "exists" : "failed";
    results.push({ kind, id, outcome, status });
    return outcome;
  };
  for (const run of trace.runs) {
    if (run.parent_run_id && failedRuns.has(run.parent_run_id)) {
      failedRuns.add(run.id);
      results.push({ kind: "run", id: run.id, outcome: "skipped", status: null });
      continue;
    }
    if ((await send("run", run.id, "/runs", run)) === "failed") failedRuns.add(run.id);
  }
  for (const f of trace.feedback) {
    if (failedRuns.has(f.run_id)) {
      results.push({ kind: "feedback", id: f.id, outcome: "skipped", status: null });
      continue;
    }
    await send("feedback", f.id, "/feedback", f);
  }
  const count = (o: PublishResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  return { attempted: results.length - count("skipped"), created: count("created"), existing: count("exists"), failed: count("failed"), skipped: count("skipped"), results };
}

/** Why a payload is not safe to send: secret values, key-shaped strings, URLs, private media references, or identity values. */
export function payloadLeaks(payload: string, secrets: readonly string[], identities: readonly string[]): string[] {
  const found: string[] = [];
  if (secrets.some((s) => s.length >= 8 && payload.includes(s))) found.push("a configured secret value");
  if (/lsv2_|mky_|sk-ant-|sb_secret_|AIza[0-9A-Za-z_-]{20,}/.test(payload)) found.push("a key-shaped string");
  if (/https?:\/\//.test(payload)) found.push("a URL");
  if (payload.includes("storage://")) found.push("a private storage reference");
  if (identities.some((id) => id.length >= 8 && payload.includes(id))) found.push("a reviewer or owner id");
  return found;
}
