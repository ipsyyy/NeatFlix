import type { CSSProperties } from "react";
import { formatDuration, getEligibility } from "@/lib/catalogue/eligibility";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { StatusBadges } from "./status-badge";
import { GateMarks, TitleArtwork } from "./title-artwork";
import { OpenTitleRecordButton } from "./title-record";

/** Staggers the CSS reveal; content stays visible even without JavaScript. */
const step = (i: number): CSSProperties => ({ animationDelay: `${350 + i * 80}ms` });

/**
 * The page's single orchestrated moment: the gate settles onto the artwork,
 * then the title details rise in. Reduced-motion users see it without movement.
 */
export function FeaturedTitle({ title }: { title: CatalogueTitle }) {
  const { eligible } = getEligibility(title);

  return (
    <section
      id="featured"
      aria-labelledby="featured-heading"
      className="relative isolate overflow-hidden border-b border-line"
    >
      <div className="reveal-backdrop absolute inset-0 -z-10">
        <TitleArtwork artwork={title.artwork} title={title.title} decorative className="absolute inset-0" />
        {/* Scrims keep text contrast high over any artwork. */}
        <div className="absolute inset-0 bg-gradient-to-r from-canvas via-canvas/75 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-canvas via-transparent to-canvas/30" />
      </div>

      <div className="reveal-gate pointer-events-none absolute inset-4 sm:inset-8 lg:inset-12">
        <GateMarks always />
      </div>

      <div className="shell relative flex min-h-[min(78svh,46rem)] flex-col justify-end pb-14 pt-32 sm:pb-20 lg:pb-24">
        <p className="reveal text-[0.9375rem] text-ink-soft" style={step(0)}>
          Featured for placement review
        </p>

        <h2
          id="featured-heading"
          className="reveal type-condensed mt-3 max-w-[12ch] text-[clamp(3.25rem,10vw,8.5rem)] font-extrabold leading-[0.88] tracking-[-0.02em] text-ink"
          style={step(1)}
        >
          {title.title}
        </h2>

        <p className="reveal mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-soft" style={step(2)}>
          {title.description}
        </p>

        <dl className="reveal mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm" style={step(3)}>
          <Meta label="Genre" value={title.genre} />
          <Meta label="Tone" value={title.tone} />
          <Meta label="Rating" value={title.rating} />
          <Meta label="Runtime" value={formatDuration(title.durationSeconds)} />
        </dl>

        <div className="reveal mt-6" style={step(4)}>
          <StatusBadges title={title} />
        </div>

        <div className="reveal mt-9 flex flex-wrap items-center gap-x-5 gap-y-3" style={step(5)}>
          <OpenTitleRecordButton
            id={title.id}
            className="inline-flex h-12 items-center rounded-full bg-accent px-6 text-[0.9375rem] font-semibold text-canvas transition-[background-color,transform] duration-200 hover:bg-accent-strong active:scale-[0.98]"
          >
            Open title record
          </OpenTitleRecordButton>
          <p className="text-sm text-muted">
            {eligible ? "Eligible for placement work" : "Not eligible yet"}
          </p>
        </div>
      </div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
