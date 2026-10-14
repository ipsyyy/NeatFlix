import { ImageOff } from "lucide-react";
import { GateMarks, TitleArtwork } from "@/components/catalogue/title-artwork";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { formatTimecode } from "@/lib/scenes/format";
import type { SceneCandidate } from "@/lib/scenes/types";

const STAND_IN_NOTE =
  "No video uploaded. Showing title artwork as a stand-in; it is not a frame from this scene.";

/** Minute labels closer than this to the end would collide with the runtime label. */
const END_LABEL_CLEARANCE_SECONDS = 20;

/**
 * Media-review area. There is no video yet: the title artwork stands in and is
 * labelled as such. Nothing here is playable, so there are no playback controls.
 */
export function MediaReview({
  title,
  scenes,
  selected,
  className = "",
}: {
  title: CatalogueTitle;
  scenes: SceneCandidate[];
  selected: SceneCandidate;
  className?: string;
}) {
  const runtime = title.durationSeconds;
  const pct = (s: number) => `${(s / runtime) * 100}%`;
  const minuteMarks = Array.from({ length: Math.floor(runtime / 60) + 1 }, (_, i) => i * 60).filter(
    (t) => runtime - t > END_LABEL_CLEARANCE_SECONDS,
  );

  return (
    <section aria-labelledby="media-heading" className={`panel overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <h2 id="media-heading" className="panel-heading">
          Media review
        </h2>
        <p className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-soft">
          <ImageOff aria-hidden="true" className="size-3.5" />
          Artwork placeholder, not video
        </p>
      </div>

      <div className="relative aspect-video overflow-hidden border-y border-line bg-canvas">
        <TitleArtwork
          artwork={title.artwork}
          title={title.title}
          decorative
          eager
          sizes="(min-width: 1024px) 62vw, 100vw"
          className="absolute inset-0"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-canvas/90 via-transparent to-canvas/50" />
        <div className="pointer-events-none absolute inset-3 sm:inset-5">
          <GateMarks always />
        </div>

        {/* Overlays sit inside the gate corners; on small screens they move out of the frame. */}
        <p className="absolute left-10 top-10 hidden max-w-[70%] rounded-lg bg-canvas/80 px-3 py-2 text-sm leading-snug text-ink-soft backdrop-blur sm:block">
          {STAND_IN_NOTE}
        </p>

        <div className="absolute bottom-10 left-10 right-10 hidden sm:block">
          <p className="text-sm text-ink-soft">Selected scene</p>
          <p className="mt-0.5 text-lg font-semibold text-ink sm:text-xl">{selected.name}</p>
          <p className="text-sm tabular-nums text-ink-soft">
            {formatTimecode(selected.startSeconds)}–{formatTimecode(selected.endSeconds)}
          </p>
        </div>
      </div>

      <p className="border-b border-line px-5 py-3 text-xs leading-snug text-ink-soft sm:hidden">
        {STAND_IN_NOTE}
      </p>

      <div className="px-5 pb-5 pt-4">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <h3 className="font-medium text-ink">Timeline</h3>
          <p className="tabular-nums text-muted">
            <span className="text-ink">
              {formatTimecode(selected.startSeconds)}–{formatTimecode(selected.endSeconds)}
            </span>{" "}
            of {formatTimecode(runtime)}
          </p>
        </div>

        {/* Visual summary only; the candidate list is the control and carries the same information. */}
        <div aria-hidden="true" className="mt-3">
          <div className="relative h-9 rounded-md bg-white/[0.04] ring-1 ring-line">
            {scenes.map((s) => {
              const isSelected = s.id === selected.id;
              const rejected = s.decision === "rejected";
              return (
                <span
                  key={s.id}
                  className={`absolute inset-y-1 min-w-2 rounded-sm transition-colors ${
                    isSelected
                      ? "bg-accent"
                      : rejected
                        ? "timeline-rejected"
                        : "bg-accent/25 ring-1 ring-accent/60"
                  }`}
                  style={{ left: pct(s.startSeconds), width: pct(s.endSeconds - s.startSeconds) }}
                />
              );
            })}
          </div>
          <div className="relative mt-1.5 h-4 text-[0.6875rem] tabular-nums text-muted">
            {minuteMarks.map((t) => (
              <span
                key={t}
                className="absolute -translate-x-1/2 first:translate-x-0"
                style={{ left: pct(t) }}
              >
                {formatTimecode(t)}
              </span>
            ))}
            <span className="absolute right-0">{formatTimecode(runtime)}</span>
          </div>
        </div>

        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-accent" />
            Selected
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-accent/25 ring-1 ring-accent/60" />
            Candidate
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="timeline-rejected size-2.5 rounded-sm" />
            Rejected
          </li>
        </ul>
      </div>
    </section>
  );
}
