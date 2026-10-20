"use client";

import { ArrowRight, CircleCheck, CircleDashed, LoaderCircle, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Suspense, use, useEffect, useRef, useState, type RefObject } from "react";
import { VideoUnavailable } from "@/components/catalogue/title-video";
import type { SourceVideoCheck } from "@/lib/catalogue/title-media";
import { REPLAY_DISCLOSURE, REPLAY_START_MS, REPLAY_STEP_MS, type RecordedReplay } from "@/lib/placement/replay";

type StepState = "complete" | "running" | "waiting";

const stepIcon = {
  complete: { Icon: CircleCheck, className: "text-accent", label: "Complete" },
  running: { Icon: LoaderCircle, className: "animate-spin text-ink motion-reduce:animate-none", label: "In progress" },
  waiting: { Icon: CircleDashed, className: "text-muted", label: "Waiting" },
} as const;

const primaryButton =
  "inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-[0.9375rem] font-semibold text-canvas transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "inline-flex h-12 items-center gap-2 rounded-full border border-line-strong px-5 text-[0.9375rem] font-semibold text-ink transition-colors hover:border-ink-soft";

/**
 * Replays the recorded pipeline step by step on a fixed timer, then reveals
 * the approved video. Deterministic: the same steps and outcomes every run.
 */
export function PlacementReplay({ replay, poster, video }: { replay: RecordedReplay; poster?: string; video: Promise<SourceVideoCheck> }) {
  const [done, setDone] = useState(0);
  const [run, setRun] = useState(0);
  const total = replay.steps.length;
  const complete = done === total;

  useEffect(() => {
    const timers = replay.steps.map((_, i) => setTimeout(() => setDone(i + 1), REPLAY_START_MS + (i + 1) * REPLAY_STEP_MS));
    return () => timers.forEach(clearTimeout);
  }, [replay, run]);

  const restart = () => {
    setDone(0);
    setRun((r) => r + 1);
  };

  const last = replay.steps[done - 1];
  return (
    <div className="shell space-y-10 py-10">
      <section aria-labelledby="replay-heading" className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="replay-heading" className="panel-heading">
            Placement pipeline · case {replay.caseId}
          </h2>
          <p className="text-sm font-medium text-ink-soft" data-testid="replay-disclosure">
            {REPLAY_DISCLOSURE}
          </p>
        </div>
        <ol className="mt-4 divide-y divide-line" data-testid="replay-steps">
          {replay.steps.map((step, i) => {
            const state: StepState = i < done ? "complete" : i === done ? "running" : "waiting";
            const { Icon, className, label } = stepIcon[state];
            return (
              <li key={step.role} data-state={state} className="flex items-center gap-3 py-3">
                <Icon aria-hidden="true" className={`size-5 shrink-0 ${className}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block font-semibold ${state === "waiting" ? "text-muted" : "text-ink"}`}>{step.agent}</span>
                  <span className={`block text-sm ${state === "complete" ? "text-ink-soft" : "text-muted"}`}>
                    {state === "complete" ? step.outcome : state === "running" ? "Replaying recorded decision…" : "Waiting"}
                  </span>
                </span>
                <span className="text-xs text-muted">
                  <span className="sr-only">Status: </span>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
        <p aria-live="polite" className="sr-only">
          {complete ? "Replay complete. The approved placement preview is ready." : last ? `${last.agent}: ${last.outcome}` : ""}
        </p>
      </section>

      {complete && (
        <Suspense fallback={<p className="text-sm text-muted">Checking the approved video…</p>}>
          <ApprovedVideo replay={replay} poster={poster} video={video} onReplay={restart} />
        </Suspense>
      )}
    </div>
  );
}

function ApprovedVideo({ replay, poster, video, onReplay }: { replay: RecordedReplay; poster?: string; video: Promise<SourceVideoCheck>; onReplay: () => void }) {
  const check = use(video);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <ApprovedPreview
      replay={replay}
      poster={poster}
      unavailable={!check.ok ? check.reason : failed ? "The approved video could not be loaded." : null}
      videoRef={videoRef}
      onError={() => setFailed(true)}
      onPlay={() => void videoRef.current?.play().catch(() => {})}
      onReplay={onReplay}
    />
  );
}

/** The approved output and its controls; with `unavailable`, a clear notice replaces the player. */
export function ApprovedPreview({
  replay,
  poster,
  unavailable,
  videoRef,
  onError,
  onPlay,
  onReplay,
}: {
  replay: RecordedReplay;
  poster?: string;
  unavailable: string | null;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onError?: () => void;
  onPlay?: () => void;
  onReplay?: () => void;
}) {
  return (
    <section aria-labelledby="approved-preview-heading" className="space-y-5" data-testid="approved-preview">
      <header className="space-y-2">
        <h2 id="approved-preview-heading" className="type-condensed text-[clamp(1.75rem,3.5vw,2.75rem)] font-extrabold leading-tight text-ink">
          Approved placement preview
        </h2>
        <p className="text-ink-soft">Generated earlier with {replay.video.generator} and approved with limitation.</p>
        <p className="rounded-xl border border-line-strong bg-white/[0.03] px-4 py-3 text-sm text-ink-soft">
          <strong className="font-semibold text-ink">Limitation:</strong> {replay.video.limitation}
        </p>
      </header>

      {unavailable ? (
        <VideoUnavailable label="Approved placement preview" reason={unavailable} />
      ) : (
        <video
          ref={videoRef}
          src={replay.video.src}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          onError={onError}
          aria-labelledby="approved-preview-heading"
          data-testid="approved-video"
          className="aspect-video w-full rounded-xl border border-line bg-canvas"
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onPlay} disabled={Boolean(unavailable)} className={primaryButton}>
          <Play aria-hidden="true" className="size-4 fill-current" />
          Play approved video
        </button>
        <Link href={replay.approvalEvidenceHref} className={secondaryButton}>
          View approval evidence
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
        <Link href={replay.caseHref} className={secondaryButton}>
          View full case
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
        <button type="button" onClick={onReplay} className={secondaryButton}>
          <RotateCcw aria-hidden="true" className="size-4" />
          Replay pipeline
        </button>
      </div>
    </section>
  );
}
