import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";
import { StatusBadges } from "@/components/catalogue/status-badge";
import { formatDuration } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";

/** Workflow stages, in order. Only catalogue review and scene selection exist so far. */
const stages = [
  "Catalogue review",
  "Scene selection",
  "Campaign matching",
  "Placement preview",
  "Evaluation and approval",
  "Experiment",
] as const;
const CURRENT_STAGE = 1;

export function WorkspaceHeader({
  title,
  caseId,
}: {
  title: CatalogueTitle;
  caseId: string | null;
}) {
  return (
    <header className="border-b border-line">
      <div className="shell space-y-8 pb-8 pt-6">
        <Link
          href="/#titles"
          className="inline-flex items-center gap-2 rounded-full py-1 pr-3 text-sm font-medium text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to catalogue
        </Link>

        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-3">
            <p className="text-[0.9375rem] text-ink-soft">Scene selection</p>
            <h1 className="type-condensed text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold leading-[0.92] tracking-[-0.01em] text-ink">
              {title.title}
            </h1>
            <StatusBadges title={title} />
          </div>

          <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <Context label="Case" value={caseId ?? "Not opened"} />
            <Context label="Runtime" value={formatDuration(title.durationSeconds)} />
            <Context label="Genre" value={title.genre} />
            <Context label="Rating" value={title.rating} />
          </dl>
        </div>

        <nav aria-label="Placement workflow">
          <ol className="flex flex-wrap gap-x-1 gap-y-2 text-sm">
            {stages.map((stage, i) => {
              const state = i < CURRENT_STAGE ? "done" : i === CURRENT_STAGE ? "current" : "upcoming";
              return (
                <li
                  key={stage}
                  aria-current={state === "current" ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
                    state === "current"
                      ? "border-accent/50 bg-accent/10 font-semibold text-accent"
                      : state === "done"
                        ? "border-line-strong text-ink-soft"
                        : "border-line text-muted"
                  }`}
                >
                  <span className="tabular-nums" aria-hidden="true">
                    {i + 1}
                  </span>
                  {stage}
                  {state === "done" && <span className="sr-only">(complete)</span>}
                  {state === "upcoming" && <span className="sr-only">(not started)</span>}
                </li>
              );
            })}
          </ol>
        </nav>

        <p className="flex items-start gap-2.5 rounded-xl border border-line-strong bg-white/[0.03] px-4 py-3 text-sm text-ink-soft">
          <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>
            <strong className="font-semibold text-ink">Demo fixtures.</strong> Scene records on this
            page are hand-authored stand-ins until real scene analysis is connected. Your selection
            is not saved.
          </span>
        </p>
      </div>
    </header>
  );
}

function Context({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}
