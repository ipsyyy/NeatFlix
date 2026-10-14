import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadges } from "@/components/catalogue/status-badge";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { WORKFLOW_STAGES, type WorkflowStage } from "@/lib/workflow/stages";

/** Shared header for workflow workspaces: back link, title, case context, progress, fixture notice. */
export function WorkspaceHeader({
  title,
  stage,
  back,
  context,
  fixtureNote,
}: {
  title: CatalogueTitle;
  stage: WorkflowStage;
  back: { href: string; label: string };
  context: { label: string; value: string }[];
  fixtureNote: ReactNode;
}) {
  const current = WORKFLOW_STAGES.indexOf(stage);

  return (
    <header className="border-b border-line">
      <div className="shell space-y-8 pb-8 pt-6">
        <Link
          href={back.href}
          className="inline-flex items-center gap-2 rounded-full py-1 pr-3 text-sm font-medium text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>

        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-3">
            <p className="text-[0.9375rem] text-ink-soft">{stage}</p>
            <h1 className="type-condensed text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold leading-[0.92] tracking-[-0.01em] text-ink">
              {title.title}
            </h1>
            <StatusBadges title={title} />
          </div>

          <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            {context.map((c) => (
              <div key={c.label}>
                <dt className="text-muted">{c.label}</dt>
                <dd className="mt-0.5 font-medium text-ink">{c.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <nav aria-label="Placement workflow">
          <ol className="flex flex-wrap gap-x-1 gap-y-2 text-sm">
            {WORKFLOW_STAGES.map((s, i) => {
              const state = i < current ? "done" : i === current ? "current" : "upcoming";
              return (
                <li
                  key={s}
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
                  {s}
                  {state === "done" && <span className="sr-only">(complete)</span>}
                  {state === "upcoming" && <span className="sr-only">(not started)</span>}
                </li>
              );
            })}
          </ol>
        </nav>

        <p className="flex items-start gap-2.5 rounded-xl border border-line-strong bg-white/[0.03] px-4 py-3 text-sm text-ink-soft">
          <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>{fixtureNote}</span>
        </p>
      </div>
    </header>
  );
}
