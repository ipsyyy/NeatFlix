import Image from "next/image";
import type { ReactNode } from "react";
import { loadDemoSnapshot } from "@/app/demo/load-snapshot";
import { CheckList } from "@/components/workflow/check-list";
import { councilSeat } from "@/lib/demo/council";
import { HHH_DIMENSIONS, selectPrimaryVideo, type AgentEvaluation, type DemoAgentEvaluation, type DemoMediaKey, type DemoSnapshot, type EvidenceKind, type Outcome } from "@/lib/demo/snapshot";
import type { CheckOutcome } from "@/lib/scenes/types";
import { ExecutiveCouncil, SeatStatus, seatStyle } from "./executive-council";
import { buildDecisionGraph, priorRejections } from "@/lib/demo/decision-graph";
import { DecisionMemoryGraph } from "./decision-graph";
import { DEMO_STEPS } from "./steps";

const toCheck = (o: Outcome): CheckOutcome => (o === "not-evaluated" ? "not-assessed" : o);
const fmt = (iso: string) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const short = (sum: string) => `${sum.slice(0, 15)}…${sum.slice(-6)}`;

function Badge({ kind }: { kind: EvidenceKind | "fixture" }) {
  const text = kind === "live" ? "Checked live from the registry" : kind === "recorded" ? "Recorded evidence" : "Deterministic fixture";
  return <span className="inline-flex rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-muted">{text}</span>;
}

function Step({ index, title, kind, children }: { index: number; title: string; kind: EvidenceKind | "fixture"; children: ReactNode }) {
  const step = DEMO_STEPS[index];
  const next = DEMO_STEPS[index + 1];
  return (
    <section id={step.id} aria-labelledby={`${step.id}-title`} className="scroll-mt-20 border-b border-line">
      <div className="shell space-y-6 py-12">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-accent">Step {index + 1} of {DEMO_STEPS.length}</span>
          <Badge kind={kind} />
        </div>
        <h2 id={`${step.id}-title`} className="type-condensed text-[clamp(1.75rem,3.5vw,2.75rem)] font-extrabold leading-tight text-ink">
          {title}
        </h2>
        {children}
        {next && (
          <a href={`#${next.id}`} className="inline-flex rounded-full bg-accent px-4 py-2 text-sm font-semibold text-canvas hover:bg-accent-strong">
            Next: {next.short}
          </a>
        )}
      </div>
    </section>
  );
}

/** A record card; with a council `role` it takes that member's colours and archetype. */
function Card({ title, children, primary = false, role, live = false }: { title: string; children: ReactNode; primary?: boolean; role?: string; live?: boolean }) {
  const seat = role ? councilSeat(role) : undefined;
  return (
    <div
      className={`rounded-2xl border bg-surface p-5 ${primary ? "border-accent" : "border-line"} ${seat ? `council-seat ${live ? "council-seat--live" : ""}` : ""}`}
      style={seat ? seatStyle(seat) : undefined}
    >
      {seat && <p className="seat-archetype mb-1">{seat.archetype}</p>}
      <h3 className="mb-2 font-semibold text-ink">{title}</h3>
      <div className="space-y-2 text-sm leading-relaxed text-ink-soft">{children}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted">{label}:</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/** A verified media element, or a placeholder when the file is unavailable. */
function Media({ s, mediaKey, alt }: { s: DemoSnapshot; mediaKey: DemoMediaKey; alt: string }) {
  const m = s.media.find((x) => x.key === mediaKey);
  if (!m || !m.verified) {
    return (
      <div role="img" aria-label={`${alt} (unavailable)`} className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-line-strong text-sm text-muted">
        Media unavailable on this machine: run npm run demo:snapshot
      </div>
    );
  }
  const src = `/demo/media/${m.key}`;
  // The full-scene video plays once with its original audio; the short silent fallback loops.
  if (m.key === "full-scene-v4") return <video data-testid={`media-${m.key}`} src={src} controls playsInline preload="metadata" aria-label={alt} className="w-full rounded-xl border border-line" />;
  if (m.mimeType === "video/mp4") return <video data-testid={`media-${m.key}`} src={src} controls muted loop playsInline preload="metadata" aria-label={alt} className="w-full rounded-xl border border-line" />;
  if (m.mimeType === "audio/mpeg") return <audio data-testid={`media-${m.key}`} src={src} controls preload="none" aria-label={alt} className="w-full" />;
  return <Image data-testid={`media-${m.key}`} src={src} alt={alt} width={1280} height={720} unoptimized className="h-auto w-full rounded-xl border border-line" />;
}

const OUTCOME_STYLE: Record<Outcome, string> = { pass: "text-accent", fail: "text-blocked", "not-evaluated": "text-muted" };

function DimensionRow({ label, e }: { label: string; e: AgentEvaluation }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 border-t border-line py-2">
      <dt className="font-medium text-ink">{label}</dt>
      <dd>
        <span className={`font-semibold ${OUTCOME_STYLE[e.outcome]}`}>{e.outcome}</span>
        <p className="text-ink-soft">{e.basis}</p>
        {e.sources.length > 0 && <p className="text-xs text-muted">Evidence: {e.sources.join(" · ")}</p>}
      </dd>
    </div>
  );
}

/** One BAND agent's rule-based HHH result, with Groundedness shown separately. */
function AgentEvaluationCard({ a }: { a: DemoAgentEvaluation }) {
  return (
    <li data-testid={`agent-eval-${a.role}`}>
      <Card title={`${a.title} — ${a.name}`}>
        <dl className="text-sm" aria-label={`${a.title} HHH`}>
          {HHH_DIMENSIONS.map((d) => (
            <DimensionRow key={d} label={d[0].toUpperCase() + d.slice(1)} e={a[d]} />
          ))}
        </dl>
        <dl className="mt-2 rounded-lg bg-raised px-3 text-sm" aria-label={`${a.title} groundedness`}>
          <DimensionRow label="Groundedness" e={a.groundedness} />
        </dl>
        <p className="text-xs text-muted">
          LangSmith run{a.runs.length === 1 ? "" : "s"}:{" "}
          {a.runs.map((r, i) => (
            <span key={r.id}>
              {i > 0 && " · "}
              <a href={r.link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {r.name}
              </a>
            </span>
          ))}
        </p>
      </Card>
    </li>
  );
}

function Placeholder({ reason }: { reason: string }) {
  return (
    <section className="shell py-16" aria-label="Demo snapshot unavailable">
      <div className="max-w-2xl rounded-2xl border border-line-strong bg-surface p-8">
        <h2 className="text-xl font-semibold text-ink">The verified case snapshot is not available</h2>
        <p className="mt-3 text-ink-soft">{reason}</p>
        <p className="mt-3 text-ink-soft">
          Run <code className="text-ink">npm run demo</code> (or <code className="text-ink">npm run demo:snapshot</code>) with Supabase configured. NeatFlix
          itself is unaffected; only the demo evidence is missing.
        </p>
      </div>
    </section>
  );
}

export async function DemoStory() {
  const loaded = await loadDemoSnapshot();
  if (!loaded.ok) return <Placeholder reason={loaded.reason} />;
  const s = loaded.snapshot;
  const [reactorNote, maskyNote, replayNote, labelNote, experimentNote, snykNote] = s.limitations;
  const primary = selectPrimaryVideo(s);
  const full = primary.kind === "full-scene" ? s.fullScene! : null;
  const fallbackCard = (
    <Card title={full ? "Approved 3.5 s fallback preview (Governor-reviewed)" : "Approved motion preview (primary demo output)"} primary={!full}>
      <dl className="space-y-1">
        <Fact label="Asset" value={<code>{s.preview.assetId.split(":").slice(-2).join(":")}</code>} />
        <Fact label="Generator" value={`${s.preview.generator} (${s.preview.model})`} />
        <Fact label="Duration" value={`${s.preview.durationSeconds} s`} />
        <Fact label="Cost" value={`$${s.preview.costUsd.toFixed(2)}`} />
        <Fact label="Checksum" value={<code>{short(s.preview.checksum)}</code>} />
      </dl>
      <p>A deterministic camera push-in over the approved still: no frame is synthesised, and the preview is disclosed as a local fallback.</p>
    </Card>
  );

  return (
    <div data-testid="demo-story">
      <ExecutiveCouncil s={s} />

      <Step index={0} title="A campaign case enters NeatFlix" kind="live">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Fact label="Case" value={<span data-testid="case-id">{s.case.caseId}</span>} />
          <Fact label="Opened" value={fmt(s.case.createdAt)} />
          <Fact label="Title" value={s.case.titleName} />
          <Fact label="Scene" value={`${s.case.sceneName} (${s.case.sceneId})`} />
          <Fact label="Campaign" value={`${s.case.product} by ${s.case.advertiser}`} />
          <Fact label="Status now" value={<span data-testid="case-status">{s.case.status}</span>} />
        </dl>
        <p className="max-w-3xl text-ink-soft">
          A fictional streaming catalogue and fictional advertiser. The question: can {s.case.product} appear naturally in this scene, for eligible viewers, without harming
          viewer trust?
        </p>
      </Step>

      <Step index={1} title="The council at work: five agents, each with one responsibility" kind="recorded">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="agents">
          {s.agents.map((a) => (
            <Card key={a.role} title={a.name} primary={a.role === "release-governor"} role={a.role}>
              <p>{a.responsibility}</p>
              <p>
                <span className="text-muted">Decision:</span> <span className="font-semibold text-ink">{a.decision}</span>
              </p>
              <p className="text-muted">{a.evidence}</p>
            </Card>
          ))}
        </div>
        <p className="text-sm text-muted">Agents hand off through BAND with authenticated, schema-checked messages. Their decisions are shown from the record; no agent runs during this demo.</p>
      </Step>

      <Step index={2} title="The placement plan, the selected scene, and the branded visual" kind="live">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <Media s={s} mediaKey="source-frame" alt="Registered source frame from the selected scene" />
            <p className="text-sm text-muted">Registered source frame from {s.case.sceneName}, unedited.</p>
          </div>
          <Card title={`Plan v${s.plan.version}: ${s.plan.mode}`}>
            <p>{s.plan.description}</p>
            <dl className="space-y-1">
              <Fact label="Region" value={s.plan.region} />
              <Fact label="Plan hash" value={<code>{s.plan.sha256.slice(0, 16)}…</code>} />
            </dl>
            <details>
              <summary className="cursor-pointer text-ink">Edit instruction and constraints</summary>
              <p className="mt-2">{s.plan.stillPrompt}</p>
              <ul className="mt-2 list-disc pl-5">
                {s.plan.negativeConstraints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </details>
            <p data-testid="visual-disclosure" className="border-l-2 border-accent pl-3 text-ink">
              {s.plan.disclosure}
            </p>
          </Card>
        </div>
      </Step>

      <Step index={3} title="Approved V3 still and the primary video output" kind="live">
        <div className="grid gap-4 md:grid-cols-3">
          {s.revisions.map((r) => (
            <div key={r.version} className="space-y-2" data-testid={`revision-v${r.version}`}>
              <Media s={s} mediaKey={r.media} alt={`Edited still v${r.version}`} />
              <p className="text-sm">
                <span className="font-semibold text-ink">v{r.version}: human {r.decision}</span>
                <span className="text-muted"> · {short(r.checksum)}</span>
              </p>
              <p className="text-sm text-muted">{r.reasons[0]}</p>
            </div>
          ))}
        </div>
        {full ? (
          <>
            <div className="grid gap-6 lg:grid-cols-[3fr_2fr]" data-testid="primary-video" data-primary={primary.mediaKey}>
              <Media s={s} mediaKey="full-scene-v4" alt={full.label} />
              <Card title="Primary demo output" primary>
                <p data-testid="primary-video-label" className="font-semibold text-ink">
                  {full.label}
                </p>
                <dl className="space-y-1">
                  <Fact label="Asset" value={<code>{full.assetId.split(":").slice(-2).join(":")}</code>} />
                  <Fact label="Generator" value={`${full.generator} (${full.model})`} />
                  <Fact label="Runway task" value={<code>{full.taskId}</code>} />
                  <Fact label="Duration" value={`${full.durationSeconds.toFixed(3)} s (source ${full.sourceDurationSeconds.toFixed(3)} s)`} />
                  <Fact label="Video" value={`${full.width}×${full.height} ${full.videoCodec}, ${full.frameRate} fps, ${full.audioCodec} audio`} />
                  <Fact label="Cost" value={`${full.chargedCredits} credits ($${full.costUsd.toFixed(2)})`} />
                  <Fact label="Checksum" value={<code>{short(full.checksum)}</code>} />
                  <Fact label="Human review" value={<span data-testid="full-scene-decision">{full.decision}</span>} />
                </dl>
                <p>{full.disclosure}</p>
                <div className="border-l-2 border-accent pl-3">
                  <p className="text-ink">Disclosed limitation</p>
                  <ul className="list-disc pl-5" data-testid="full-scene-limitations">
                    {full.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              </Card>
            </div>
            <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
              <Media s={s} mediaKey="preview-v3" alt="Approved motion preview v3" />
              {fallbackCard}
            </div>
          </>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[3fr_2fr]" data-testid="primary-video" data-primary={primary.mediaKey}>
            <Media s={s} mediaKey="preview-v3" alt="Approved motion preview v3" />
            {fallbackCard}
          </div>
        )}
      </Step>

      <Step index={4} title="Reactor: the intended video provider" kind="recorded">
        <p data-testid="reactor-note" className="max-w-3xl text-ink-soft">
          {reactorNote}
        </p>
      </Step>

      <Step index={5} title="Release Governor: HHH, policy, campaign, scene, and technical checks" kind="live">
        <p>
          <span className="text-muted">Decision:</span> <span data-testid="governor-decision" className="font-semibold text-ink">{s.governor.decision}</span>
          <span className="text-muted"> · {fmt(s.governor.at)} · {s.governor.blockers} blockers</span>
        </p>
        <CheckList label="Helpful, honest, harmless" rows={s.governor.hhh.map((h) => ({ label: h.key, outcome: toCheck(h.outcome), evidence: h.rationale }))} />
        <CheckList label="Governor checks" rows={s.governor.checks.map((c) => ({ label: `${c.id} (${c.category})`, outcome: toCheck(c.outcome), evidence: c.detail }))} />
      </Step>

      <Step index={6} title="Human visual review and final human approval" kind="live">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={`Human visual review of the preview: ${s.preview.decision}`}>
            <ol className="list-decimal space-y-1 pl-5">
              {s.preview.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </Card>
          <Card title={`Final human approval: ${s.approval.decision}`} primary>
            <p className="text-muted">
              {s.approval.reviewerName} · {fmt(s.approval.at)} · case <span data-testid="approval-case-status">{s.approval.caseStatus}</span>
            </p>
            <ol className="list-decimal space-y-1 pl-5" data-testid="approval-reasons">
              {s.approval.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </Card>
        </div>
        <p className="text-sm text-muted">{labelNote}</p>
      </Step>

      <Step index={7} title="Masky: the council's faces and voices" kind="recorded">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5" data-testid="masky-identities">
          {s.masky.identities.map((i) => (
            <Card key={i.role} title={`${i.name} · ${i.title}`} primary={i.primary} role={i.role} live={i.mode === "masky"}>
              <SeatStatus live={i.mode === "masky"} />
              {i.mode === "masky" ? (
                <>
                  <Media s={s} mediaKey="iris-portrait" alt={`${i.name} portrait`} />
                  <Media s={s} mediaKey="iris-audio" alt={`${i.name} spoken result`} />
                  <p className="text-xs text-muted" data-testid="masky-live-identity">
                    Masky avatar {s.masky.avatarId} · {s.masky.voiceName} · speech job {s.masky.speechJobId}
                  </p>
                </>
              ) : (
                <>
                  <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(i.portraitSvg ?? "")}`} alt={`${i.name} local portrait`} width={1024} height={1024} unoptimized className="h-auto w-full rounded-xl" />
                  <p className="text-xs text-muted">Local fallback: caption, no voice</p>
                </>
              )}
              <p className="italic text-ink">
                <span className="not-italic text-muted">{i.mode === "masky" ? "Recorded line: " : "Caption: "}</span>“{i.caption}”
              </p>
            </Card>
          ))}
        </div>
        <p className="text-sm text-muted">{maskyNote}</p>
      </Step>

      <Step index={8} title="LangSmith: the traced and evaluated case" kind="recorded">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Fact label="Project" value={s.langsmith.project} />
          <Fact label="Trace" value={<code>{s.langsmith.traceId}</code>} />
          <Fact label="Runs" value={<span data-testid="langsmith-runs">{s.langsmith.runs}</span>} />
          <Fact label="Evaluations" value={<span data-testid="langsmith-feedback">{s.langsmith.feedback}</span>} />
          <Fact label="Recorded" value={`${fmt(s.langsmith.recorded.start)} → ${fmt(s.langsmith.recorded.end)}`} />
          <Fact label="Replayed" value={`${fmt(s.langsmith.replayed.start)} → ${fmt(s.langsmith.replayed.end)}`} />
        </dl>
        <h3 className="text-sm font-semibold text-ink">Published case-level evaluations (historical, unchanged)</h3>
        <ul aria-label="Evaluation scores" className="text-sm" data-testid="langsmith-scores">
          {s.langsmith.evaluations.map((e) => (
            <li key={e.key} className="grid grid-cols-[14rem_3rem_minmax(0,1fr)] gap-3 border-t border-line py-2">
              <span className="font-medium text-ink">{e.key}</span>
              <span className={e.score === 1 ? "font-semibold text-accent" : "font-semibold text-blocked"}>{e.score}</span>
              <span className="text-ink-soft">{e.comment}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">
          The other four published evaluations are run-level human_visual_decision scores on the human visual review runs (two rejected stills, the approved still, and
          the approved preview). No published evaluation targets an individual agent run. prompt_label_currency is 0 because the Release Governor&apos;s review
          repeated the plan&apos;s stale &ldquo;not-executed&rdquo; prompt labels after Gemini and FFmpeg had produced media from those prompts; the human approval
          records the correction.
        </p>
        {s.agentEvaluations && (
          <div className="space-y-3" data-testid="agent-evaluations">
            <h3 className="text-sm font-semibold text-ink">Per-agent HHH and Groundedness</h3>
            <p className="text-sm text-ink-soft" data-testid="agent-evaluation-method">
              {s.agentEvaluations.method}{" "}
              {s.agentEvaluations.runLinks === "per-run"
                ? "Run links open each agent's run in the published trace."
                : "Individual run links are unavailable, so each link opens the parent trace."}
            </p>
            <ul className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {s.agentEvaluations.rows.map((a) => (
                <AgentEvaluationCard key={a.role} a={a} />
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm text-muted">{replayNote}</p>
        <a href={s.langsmith.link} target="_blank" rel="noreferrer" className="inline-flex text-sm font-semibold text-accent underline underline-offset-4">
          Open the trace in LangSmith (sign-in required)
        </a>
      </Step>

      <Step index={9} title="Reliability and security evidence" kind="live">
        <CheckList label="Reliability and security checks" rows={s.reliability.map((r) => ({ label: `${r.label} · ${r.kind}`, outcome: toCheck(r.outcome), evidence: r.evidence }))} />
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{snykNote}</li>
          <li>{experimentNote}</li>
        </ul>
        <p className="text-xs text-muted">Snapshot built {fmt(s.generatedAt)} from commit {s.commit}.</p>
      </Step>

      <Step index={10} title="Decision Memory Graph" kind="recorded">
        {s.memory ? (
          <DecisionMemoryGraph
            graph={buildDecisionGraph(s)}
            query={{ question: "Has this product-scene pair been rejected before?", pair: `${s.case.product} + ${s.case.sceneName}`, ...priorRejections(s, s.case.campaignId, s.case.sceneId) }}
            v3={{
              mode: s.memory.plans.find((p) => p.version === 3)?.mode ?? s.plan.mode,
              addedObjects: s.memory.plans.find((p) => p.version === 3)?.addedObjects ?? null,
              constraints: s.plan.negativeConstraints,
              notes: s.memory.plans.filter((p) => p.revisionNote).map((p) => ({ plan: `Plan V${p.version} revision note`, note: p.revisionNote! })),
            }}
          />
        ) : (
          <p className="text-sm text-muted">This snapshot predates the decision memory: run npm run demo:snapshot.</p>
        )}
      </Step>

      <Step index={11} title="The business value" kind="fixture">
        <ul className="grid gap-4 md:grid-cols-2" data-testid="business-value">
          <li><Card title="Faster brand-safe placement">One case moves from catalogue to an approved, brand-safe preview with every eligibility, scene, and audience rule checked in code.</Card></li>
          <li><Card title="Traceable agent decisions">Every decision has evidence, a checksum, and a LangSmith trace with honest evaluations, including the one that scored 0.</Card></li>
          <li><Card title="Human-controlled release">Agents can veto and recommend; only the authenticated human owner can approve, and the approval is append-only.</Card></li>
          <li><Card title="Graceful provider fallbacks">When a provider limit or failure blocks the ideal path, NeatFlix fails closed, discloses it, and still ships a verified result.</Card></li>
        </ul>
        <p className="type-condensed text-2xl font-bold text-ink">NeatFlix doesn&apos;t just generate placements: it proves whether each one is safe and worth testing.</p>
      </Step>
    </div>
  );
}
