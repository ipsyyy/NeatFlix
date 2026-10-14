import { getEligibility } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { guardrailLabel } from "@/lib/scenes/format";
import type { CheckOutcome, SceneCandidate } from "@/lib/scenes/types";
import { Outcome } from "./outcome";

/** Evidence for the selected scene, plus the title-level checks it inherits from the catalogue. */
export function EvidencePanel({
  title,
  scene,
  className = "",
}: {
  title: CatalogueTitle;
  scene: SceneCandidate;
  className?: string;
}) {
  const { eligible } = getEligibility(title);
  const titleChecks: { label: string; outcome: CheckOutcome; evidence: string }[] = [
    {
      label: "Usage rights",
      outcome: title.rightsStatus === "cleared" ? "pass" : "fail",
      evidence:
        title.rightsStatus === "cleared"
          ? "Catalogue record shows rights cleared for placement work."
          : "Catalogue record does not show cleared rights.",
    },
    {
      label: "Content sensitivity",
      outcome: title.contentSensitivity.level === "standard" ? "pass" : "fail",
      evidence:
        title.contentSensitivity.level === "standard"
          ? "Title is not flagged for sensitive tone or brand-safety risk."
          : title.contentSensitivity.reason,
    },
    {
      label: "Title eligibility",
      outcome: eligible ? "pass" : "fail",
      evidence: eligible
        ? "Eligible and pipeline enabled in the catalogue."
        : "Title is not eligible for placement work.",
    },
  ];

  return (
    <section aria-labelledby="evidence-heading" className={`panel p-5 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="evidence-heading" className="panel-heading">
          Evidence and guardrails
        </h2>
        <p className="text-sm text-muted">
          For <span className="font-medium text-ink">{scene.name}</span>
        </p>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-3 rounded-xl bg-white/[0.03] p-4 text-sm sm:grid-cols-3">
        <Attribute label="Tone" value={scene.tone} />
        <Attribute label="Camera" value={scene.camera} />
        <Attribute label="Surface" value={scene.surface} />
      </dl>

      <h3 className="mt-6 text-sm font-semibold text-ink">Scene guardrails</h3>
      <p className="mt-0.5 text-xs text-muted">Demo fixture evidence, not produced by scene analysis.</p>
      <CheckList
        label={`Scene guardrail checks for ${scene.name}`}
        rows={scene.checks.map((c) => ({ label: guardrailLabel[c.id], outcome: c.outcome, evidence: c.evidence }))}
      />

      <h3 className="mt-6 text-sm font-semibold text-ink">Title checks</h3>
      <p className="mt-0.5 text-xs text-muted">From the catalogue record for {title.title}.</p>
      <CheckList label={`Title checks for ${title.title}`} rows={titleChecks} />
    </section>
  );
}

function CheckList({
  label,
  rows,
}: {
  label: string;
  rows: { label: string; outcome: CheckOutcome; evidence: string }[];
}) {
  return (
    <ul aria-label={label} className="mt-3 text-sm">
      {rows.map((r) => (
        <li
          key={r.label}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-line py-3 sm:grid-cols-[11rem_7.5rem_minmax(0,1fr)]"
        >
          <span className="font-medium text-ink">{r.label}</span>
          <span className="justify-self-end sm:justify-self-start">
            <Outcome outcome={r.outcome} />
          </span>
          <span className="col-span-2 leading-relaxed text-ink-soft sm:col-span-1">{r.evidence}</span>
        </li>
      ))}
    </ul>
  );
}

function Attribute({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}
