import { Play } from "lucide-react";
import { formatDuration, getEligibility } from "@/lib/catalogue/eligibility";
import { hasSourceVideo } from "@/lib/catalogue/title-media";
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
  const video = hasSourceVideo(title.id);

  return (
    <article className="tile group relative flex h-full flex-col">
      <div className="tile-frame relative aspect-video overflow-hidden rounded-lg bg-surface">
        <TitleArtwork
          artwork={title.artwork}
          title={title.title}
          decorative
          sizes="(min-width: 1280px) 20vw, (min-width: 768px) 33vw, (min-width: 480px) 50vw, 100vw"
          className="tile-art absolute inset-0"
        />
        <GateMarks />
        {/* Bottom right, clear of the printed titles, which sit left on these artworks. Never plays here. */}
        {video && (
          <span
            aria-hidden="true"
            data-testid="play-indicator"
            className="absolute bottom-2.5 right-2.5 grid size-8 place-items-center rounded-full bg-canvas/70 text-ink ring-1 ring-white/20 backdrop-blur-sm transition-colors group-hover:bg-accent group-hover:text-canvas"
          >
            <Play className="size-3.5 translate-x-px fill-current" strokeWidth={2} />
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
          {video && <span className="sr-only"> (video available)</span>}
        </OpenTitleRecordButton>
      </h3>

      <p className="mt-1 text-sm text-muted">
        {title.genre}, {title.rating}, {formatDuration(title.durationSeconds)}
      </p>

      {/* Kept off the artwork, so it never covers a printed title. */}
      {!eligible && (
        <p className="mt-2 w-fit rounded-md bg-surface px-2 py-1 text-xs font-medium text-ink-soft">Not eligible yet</p>
      )}

      <StatusBadges title={title} size="sm" className="mt-3" />
    </article>
  );
}
