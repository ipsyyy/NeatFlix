import { Play } from "lucide-react";
import type { ReactNode } from "react";
import {
  hasSourceVideo,
  PLACEMENT_STAGE_LABEL,
  placementStage,
  type PlacementStage,
  type TitleMedia,
} from "@/lib/catalogue/title-media";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { OpenTitleRecordButton } from "./title-record";

const STAGES: PlacementStage[] = ["screened-out", "review", "selected"];

const markClass: Record<PlacementStage, string> = {
  "screened-out": "bg-blocked",
  review: "bg-ink-soft",
  selected: "bg-accent",
};

/** Where every title stands for placement, grouped by stage; each line is its stored status. */
export async function PlacementComparison({
  titles,
  media,
}: {
  titles: readonly CatalogueTitle[];
  media: Promise<TitleMedia>;
}) {
  const { cases } = await media;
  const rows = titles.map((title) => ({ title, ...placementStage(title, cases) }));

  return (
    <PlacementComparisonFrame note={cases.loaded ? null : cases.reason}>
      {STAGES.map((stage) => {
        const inStage = rows.filter((r) => r.stage === stage);
        return (
          <div key={stage} data-testid={`stage-${stage}`} className="bg-canvas px-5 py-4">
            <h3 className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden="true" className={`size-2 rounded-full ${markClass[stage]}`} />
              {PLACEMENT_STAGE_LABEL[stage]}
              <span className="ml-auto type-condensed text-2xl font-bold tabular-nums text-ink">{inStage.length}</span>
            </h3>
            <ul className="mt-3 space-y-2.5">
              {inStage.map((r) => (
                <li key={r.title.id} className="text-sm leading-snug">
                  <OpenTitleRecordButton id={r.title.id} className="inline-flex items-center gap-1.5 text-left font-medium text-ink hover:text-accent">
                    {r.title.title}
                    {hasSourceVideo(r.title.id) && (
                      <>
                        <Play aria-hidden="true" className="size-3 fill-current text-muted" />
                        <span className="sr-only"> (video available)</span>
                      </>
                    )}
                  </OpenTitleRecordButton>
                  <span className="block text-xs text-muted">{r.status}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </PlacementComparisonFrame>
  );
}

export function PlacementComparisonFallback() {
  return (
    <PlacementComparisonFrame note={null}>
      <p className="bg-canvas px-5 py-4 text-sm text-muted sm:col-span-3">Loading placement records…</p>
    </PlacementComparisonFrame>
  );
}

function PlacementComparisonFrame({ note, children }: { note: string | null; children: ReactNode }) {
  return (
    <section id="placement-stages" aria-labelledby="placement-stages-heading" className="shell pt-12 sm:pt-16">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="placement-stages-heading" className="text-sm text-muted">
          Placement stages, from catalogue and case records
        </h2>
        {note && <p className="text-xs text-muted">{note} Without case records, no title is shown as selected.</p>}
      </div>
      <div className="mt-3 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">{children}</div>
    </section>
  );
}
