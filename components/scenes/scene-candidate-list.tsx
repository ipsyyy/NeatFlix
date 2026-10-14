import { Ban } from "lucide-react";
import { decisionLabel, formatTimecode, guardrailLabel } from "@/lib/scenes/format";
import type { SceneCandidate, SceneDecision } from "@/lib/scenes/types";

const decisionChip: Record<SceneDecision, string> = {
  recommended: "border-accent/40 bg-accent/10 text-accent",
  acceptable: "border-line-strong bg-white/[0.04] text-ink-soft",
  rejected: "border-blocked/40 bg-blocked/10 text-blocked",
};

/**
 * Candidate scenes as a native radio group: arrow keys move between
 * selectable scenes, and rejected scenes are disabled inputs.
 */
export function SceneCandidateList({
  scenes,
  selectedId,
  onSelect,
  className = "",
}: {
  scenes: SceneCandidate[];
  selectedId: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const ordered = [...scenes].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

  return (
    <section aria-labelledby="candidates-heading" className={`panel p-5 ${className}`}>
      <h2 id="candidates-heading" className="panel-heading">
        Scene candidates
      </h2>
      <p className="mt-1 text-sm text-muted">Ranked by placement fit. Rejected scenes can&rsquo;t be selected.</p>

      <fieldset className="mt-4">
        <legend className="sr-only">Choose a scene for placement</legend>
        <ul className="space-y-3">
          {ordered.map((scene) => (
            <li key={scene.id}>
              <CandidateOption
                scene={scene}
                checked={scene.id === selectedId}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      </fieldset>
    </section>
  );
}

function CandidateOption({
  scene,
  checked,
  onSelect,
}: {
  scene: SceneCandidate;
  checked: boolean;
  onSelect: (id: string) => void;
}) {
  const rejected = scene.decision === "rejected";
  const failures = scene.checks.filter((c) => c.outcome === "fail");
  const reasonId = `${scene.id}-reason`;

  return (
    <label
      className={`candidate block rounded-xl border p-4 transition-colors ${
        rejected
          ? "cursor-not-allowed border-blocked/25 bg-blocked/[0.04]"
          : checked
            ? "cursor-pointer border-accent bg-accent/[0.08]"
            : "cursor-pointer border-line-strong hover:border-white/30 hover:bg-white/[0.03]"
      }`}
    >
      <input
        type="radio"
        name="scene-candidate"
        value={scene.id}
        checked={checked}
        disabled={rejected}
        onChange={() => onSelect(scene.id)}
        aria-describedby={reasonId}
        className="sr-only"
      />

      <span className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold tabular-nums ${
            rejected
              ? "bg-blocked/15 text-blocked"
              : checked
                ? "bg-accent text-canvas"
                : "bg-white/[0.08] text-ink-soft"
          }`}
        >
          {rejected ? <Ban className="size-3.5" /> : scene.rank}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="font-semibold text-ink">{scene.name}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${decisionChip[scene.decision]}`}
            >
              {decisionLabel[scene.decision]}
            </span>
          </span>
          <span className="mt-0.5 block text-sm tabular-nums text-muted">
            {formatTimecode(scene.startSeconds)}–{formatTimecode(scene.endSeconds)}
            {scene.rank !== null && <span className="sr-only">, rank {scene.rank}</span>}
          </span>
          <span id={reasonId} className="mt-2 block text-sm leading-relaxed text-ink-soft">
            {scene.rationale}
          </span>

          {rejected && (
            <span className="mt-3 block border-t border-blocked/20 pt-3">
              <span className="block text-xs font-semibold text-blocked">
                Selection blocked by {failures.length} failed guardrail
                {failures.length === 1 ? "" : "s"}
              </span>
              <span className="mt-1.5 block space-y-1.5">
                {failures.map((c) => (
                  <span key={c.id} className="block text-sm leading-snug text-ink-soft">
                    <span className="font-medium text-ink">{guardrailLabel[c.id]}:</span>{" "}
                    {c.evidence}
                  </span>
                ))}
              </span>
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
