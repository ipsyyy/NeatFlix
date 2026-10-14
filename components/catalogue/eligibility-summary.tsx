import { getEligibility, summarizeCatalogue } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";

export function EligibilitySummary({ titles }: { titles: readonly CatalogueTitle[] }) {
  const s = summarizeCatalogue(titles);

  const supporting = [
    { label: "Rights cleared", value: s.rightsCleared },
    { label: "Actor restricted", value: s.restricted },
    { label: "Review ready", value: s.reviewReady },
    { label: "Pipeline enabled", value: s.pipelineEnabled },
  ];

  return (
    <section id="eligibility" aria-labelledby="eligibility-heading" className="border-b border-line bg-surface/60">
      <div className="shell grid gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center lg:gap-16">
        <div>
          <h2 id="eligibility-heading" className="text-sm text-muted">
            Catalogue eligibility
          </h2>
          <p className="mt-2 flex items-baseline gap-3">
            <span className="type-condensed text-6xl font-extrabold leading-none text-ink tabular-nums">
              {s.eligible}
              <span className="text-muted"> / {s.total}</span>
            </span>
            <span className="text-base text-ink-soft">titles eligible for placement work</span>
          </p>

          {/* One segment per title, in catalogue order. Counts above carry the meaning. */}
          <ol aria-hidden="true" className="mt-5 flex gap-1">
            {titles.map((t) => (
              <li
                key={t.id}
                className={`h-1.5 flex-1 rounded-full ${
                  getEligibility(t).eligible ? "bg-accent" : "bg-white/12"
                }`}
              />
            ))}
          </ol>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
          {supporting.map((item) => (
            <div key={item.label} className="bg-canvas px-5 py-4">
              <dt className="text-sm text-muted">{item.label}</dt>
              <dd className="type-condensed mt-1 text-3xl font-bold tabular-nums text-ink">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
