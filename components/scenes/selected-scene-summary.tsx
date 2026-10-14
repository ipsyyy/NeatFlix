import { Lock } from "lucide-react";
import { decisionLabel, formatTimecode, guardrailLabel, outcomeLabel } from "@/lib/scenes/format";
import type { SceneCandidate } from "@/lib/scenes/types";

export function SelectedSceneSummary({
  caseId,
  scene,
  className = "",
}: {
  caseId: string;
  scene: SceneCandidate;
  className?: string;
}) {
  const length = scene.endSeconds - scene.startSeconds;
  const openItems = scene.checks.filter((c) => c.outcome === "caution" || c.outcome === "not-assessed");
  const timecode = `${formatTimecode(scene.startSeconds)}–${formatTimecode(scene.endSeconds)}`;

  return (
    <section aria-labelledby="summary-heading" className={`panel p-5 ${className}`}>
      <h2 id="summary-heading" className="panel-heading">
        Selected scene
      </h2>

      {/* Announces selection changes to screen readers. */}
      <p className="sr-only" aria-live="polite">
        Selected {scene.name}, {timecode}, {decisionLabel[scene.decision].toLowerCase()}.
      </p>

      <p className="mt-3 text-xl font-semibold text-ink">{scene.name}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Item label="Timestamp" value={timecode} />
        <Item label="Length" value={`${length} seconds`} />
        <Item label="Decision" value={`${decisionLabel[scene.decision]}${scene.rank ? `, rank ${scene.rank}` : ""}`} />
        <Item label="Case" value={caseId} />
        <div className="col-span-2">
          <dt className="text-muted">Natural placement opportunities</dt>
          <dd className="mt-1.5 flex flex-wrap gap-1.5">
            {scene.opportunities.map((o) => (
              <span key={o} className="rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-soft">
                {o}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink">Open before generation</h3>
        {openItems.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft">All scene guardrails pass. Nothing is outstanding.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5 text-sm text-ink-soft">
            {openItems.map((c) => (
              <li key={c.id}>
                <span className="font-medium text-ink">{guardrailLabel[c.id]}</span> ({outcomeLabel[c.outcome].toLowerCase()}): {c.evidence}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <button
          type="button"
          disabled
          aria-describedby="next-step-note"
          className="inline-flex h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-line-strong bg-white/[0.04] px-5 text-[0.9375rem] font-semibold text-muted"
        >
          <Lock aria-hidden="true" className="size-4" />
          Continue to campaign matching
        </button>
        <p id="next-step-note" className="mt-2 text-center text-xs text-muted">
          Coming in a later build. Campaign matching isn&rsquo;t available yet.
        </p>
      </div>
    </section>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}
