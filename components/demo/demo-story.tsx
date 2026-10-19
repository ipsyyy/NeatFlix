import Image from "next/image";
import type { ReactNode } from "react";
import { loadDemoSnapshot } from "@/app/demo/load-snapshot";
import { CheckList } from "@/components/workflow/check-list";
import type { DemoMediaKey, DemoSnapshot, EvidenceKind, Outcome } from "@/lib/demo/snapshot";
import type { CheckOutcome } from "@/lib/scenes/types";
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

function Card({ title, children, primary = false }: { title: string; children: ReactNode; primary?: boolean }) {
  return (
    <div className={`rounded-2xl border bg-surface p-5 ${primary ? "border-accent" : "border-line"}`}>
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
  if (m.mimeType === "video/mp4") return <video data-testid={`media-${m.key}`} src={src} controls muted loop playsInline preload="metadata" aria-label={alt} className="w-full rounded-xl border border-line" />;
  if (m.mimeType === "audio/mpeg") return <audio data-testid={`media-${m.key}`} src={src} controls preload="none" aria-label={alt} className="w-full" />;
  return <Image data-testid={`media-${m.key}`} src={src} alt={alt} width={1280} height={720} unoptimized className="h-auto w-full rounded-xl border border-line" />;
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

  return (
    <div data-testid="demo-story">
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

      <Step index={1} title="Five agents, each with one responsibility" kind="recorded">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="agents">
          {s.agents.map((a) => (
            <Card key={a.role} title={a.name} primary={a.role === "release-governor"}>
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

      <Step index={3} title="Approved V3 still and the approved motion preview" kind="live">
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
        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <Media s={s} mediaKey="preview-v3" alt="Approved motion preview v3" />
          <Card title="Approved motion preview (primary demo output)">
            <dl className="space-y-1">
              <Fact label="Asset" value={<code>{s.preview.assetId.split(":").slice(-2).join(":")}</code>} />
              <Fact label="Generator" value={`${s.preview.generator} (${s.preview.model})`} />
              <Fact label="Duration" value={`${s.preview.durationSeconds} s`} />
              <Fact label="Cost" value={`$${s.preview.costUsd.toFixed(2)}`} />
              <Fact label="Checksum" value={<code>{short(s.preview.checksum)}</code>} />
            </dl>
            <p>A deterministic camera push-in over the approved still: no frame is synthesised, and the preview is disclosed as a local fallback.</p>
          </Card>
        </div>
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

      <Step index={7} title="Masky: agent faces and voices" kind="recorded">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5" data-testid="masky-identities">
          {s.masky.identities.map((i) => (
            <Card key={i.role} title={`${i.name} · ${i.title}`} primary={i.primary}>
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
              <p className="italic text-ink">“{i.caption}”</p>
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
        <ul aria-label="Evaluation scores" className="text-sm" data-testid="langsmith-scores">
          {s.langsmith.evaluations.map((e) => (
            <li key={e.key} className="grid grid-cols-[14rem_3rem_minmax(0,1fr)] gap-3 border-t border-line py-2">
              <span className="font-medium text-ink">{e.key}</span>
              <span className={e.score === 1 ? "font-semibold text-accent" : "font-semibold text-blocked"}>{e.score}</span>
              <span className="text-ink-soft">{e.comment}</span>
            </li>
          ))}
        </ul>
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

      <Step index={10} title="The business value" kind="fixture">
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
