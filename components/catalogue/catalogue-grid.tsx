import { formatDuration, getEligibility } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { StatusBadges } from "./status-badge";
import { GateMarks, TitleArtwork } from "./title-artwork";
import { OpenTitleRecordButton } from "./title-record";

export function CatalogueGrid({ titles }: { titles: readonly CatalogueTitle[] }) {
  return (
    <section id="titles" aria-labelledby="titles-heading" className="shell py-16 sm:py-20">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 id="titles-heading" className="type-condensed text-4xl font-bold leading-none tracking-tight sm:text-5xl">
          All titles
        </h2>
        <p className="text-sm text-muted">
          {titles.length} titles. Select one to open its record.
        </p>
      </div>

      <ul className="mt-10 grid grid-cols-1 gap-x-5 gap-y-10 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {titles.map((title) => (
          <li key={title.id}>
            <TitleCard title={title} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TitleCard({ title }: { title: CatalogueTitle }) {
  const { eligible } = getEligibility(title);

  return (
    <article className="tile group relative flex h-full flex-col">
      <div className="tile-frame relative aspect-video overflow-hidden rounded-lg bg-surface">
        <TitleArtwork artwork={title.artwork} title={title.title} decorative className="tile-art absolute inset-0" />
        <GateMarks />
        {!eligible && (
          <span className="absolute bottom-2 left-2 rounded-md bg-canvas/80 px-2 py-1 text-xs font-medium text-ink-soft backdrop-blur">
            Not eligible yet
          </span>
        )}
      </div>

      <h3 className="mt-4 text-lg font-semibold leading-snug text-ink">
        {/* The button's ::after stretches over the whole card, so the card is one click target. */}
        <OpenTitleRecordButton
          id={title.id}
          className="text-left after:absolute after:inset-0 after:rounded-lg after:content-['']"
        >
          {title.title}
        </OpenTitleRecordButton>
      </h3>

      <p className="mt-1 text-sm text-muted">
        {title.genre}, {title.rating}, {formatDuration(title.durationSeconds)}
      </p>

      <StatusBadges title={title} size="sm" className="mt-3" />
    </article>
  );
}
