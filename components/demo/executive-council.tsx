import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";
import type { CSSProperties } from "react";
import { COUNCIL, COUNCIL_HEADLINE, COUNCIL_SUPPORT, FOUNDER, type CouncilSeat } from "@/lib/demo/council";
import type { DemoSnapshot } from "@/lib/demo/snapshot";

/** Per-seat colour tokens, read by the .council-seat styles in globals.css. */
export const seatStyle = (seat: CouncilSeat | undefined, index = 0) =>
  ({ "--seat": seat?.palette.accent ?? "var(--color-accent)", "--seat-deep": seat?.palette.deep ?? "var(--color-raised)", "--i": index }) as CSSProperties;

/** Live (real Masky avatar and voice) or preview (NativeFrame's local portrait and caption). */
export function SeatStatus({ live }: { live: boolean }) {
  return live ? (
    <span className="seat-status seat-status--live">
      <span className="live-dot" aria-hidden="true" />
      Live · Masky avatar and voice
    </span>
  ) : (
    <span className="seat-status">Preview · local portrait</span>
  );
}

/** The human host: the user's own photograph, or a clearly labelled placeholder. Never a generated face. */
function FounderCard() {
  const hasPhoto = existsSync(join(process.cwd(), ...FOUNDER.photoFile));
  return (
    <figure className="founder-card reveal flex items-center gap-5">
      <div className="relative aspect-[4/5] w-28 shrink-0 overflow-hidden rounded-xl bg-canvas sm:w-32">
        {hasPhoto ? (
          <Image src={FOUNDER.photo} alt={`${FOUNDER.name ?? "The founder"}, ${FOUNDER.title}`} fill sizes="8rem" unoptimized className="object-cover" />
        ) : (
          <div role="img" aria-label="Placeholder for the founder's photograph" className="flex h-full items-center justify-center rounded-xl border border-dashed border-line-strong p-3 text-center">
            <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-muted">Photo placeholder</span>
          </div>
        )}
        <div className="gate-marks gate-marks--static" aria-hidden="true">
          <span className="gate-corner gate-corner--tl" />
          <span className="gate-corner gate-corner--tr" />
          <span className="gate-corner gate-corner--bl" />
          <span className="gate-corner gate-corner--br" />
        </div>
      </div>
      <figcaption className="min-w-0 space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{FOUNDER.role}</p>
        <p className="type-condensed text-2xl font-extrabold text-ink">{FOUNDER.name ?? FOUNDER.title}</p>
        {FOUNDER.name && <p className="text-sm text-ink-soft">{FOUNDER.title}</p>}
        <p className="text-sm text-muted">The human who convenes the council and owns every release decision.</p>
        {!hasPhoto && (
          <p className="text-xs text-muted [overflow-wrap:anywhere]">
            Placeholder: add <code className="text-ink-soft">public/council/founder.jpg</code>
          </p>
        )}
      </figcaption>
    </figure>
  );
}

function SeatPortrait({ s, seat }: { s: DemoSnapshot; seat: CouncilSeat }) {
  const identity = s.masky.identities.find((i) => i.role === seat.role);
  const irisMedia = s.media.find((m) => m.key === "iris-portrait" && m.verified);
  const alt = `${seat.name}, ${seat.archetype}`;
  // Iris's real Masky portrait is served by the checksum-verified media route (no test id here: Step 8 owns it).
  if (identity?.mode === "masky" && irisMedia) return <Image src="/demo/media/iris-portrait" alt={alt} width={1024} height={1024} unoptimized className="seat-portrait" />;
  if (identity?.portraitSvg) return <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(identity.portraitSvg)}`} alt={`${alt} (local portrait)`} width={1024} height={1024} unoptimized className="seat-portrait" />;
  return <div role="img" aria-label={`${alt} (portrait unavailable)`} className="seat-portrait aspect-square bg-raised" />;
}

export function ExecutiveCouncil({ s }: { s: DemoSnapshot }) {
  return (
    <section id="council" aria-labelledby="council-title" className="council-stage border-b border-line">
      <div className="shell space-y-10 py-14">
        <div className="grid items-end gap-10 lg:grid-cols-[minmax(0,1fr)_28rem]">
          <div className="reveal space-y-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">The AI Executive Council</p>
            <h2 id="council-title" className="type-condensed text-[clamp(2.25rem,5vw,3.75rem)] font-extrabold leading-[0.95] text-ink">
              {COUNCIL_HEADLINE}
            </h2>
            <p className="max-w-2xl text-lg text-ink-soft">{COUNCIL_SUPPORT}</p>
            <p className="max-w-2xl text-sm text-muted">
              Each specialist recommends and can object; the human founder chairs the council, and release decisions stay with people. Iris Vale appears with her real
              Masky avatar and voice. The other four are previewed with NativeFrame&apos;s local portraits and captions.
            </p>
          </div>
          <FounderCard />
        </div>

        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-label="Council members, in the order a case moves through them">
          {COUNCIL.map((seat, k) => {
            const live = s.masky.identities.find((i) => i.role === seat.role)?.mode === "masky";
            return (
              <li key={seat.role} className={`council-seat reveal-seat ${live ? "council-seat--live" : ""}`} style={seatStyle(seat, k)}>
                <article aria-labelledby={`seat-${seat.role}`} className="flex h-full flex-col">
                  <div className="relative">
                    <SeatPortrait s={s} seat={seat} />
                    <span className="seat-index" aria-hidden="true">
                      {String(k + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3 p-5">
                    <SeatStatus live={live} />
                    <div>
                      <p className="seat-archetype">{seat.archetype}</p>
                      <h3 id={`seat-${seat.role}`} className="type-condensed text-2xl font-extrabold leading-tight text-ink">
                        {seat.name}
                      </h3>
                      <p className="text-sm text-muted">{seat.title}</p>
                    </div>
                    <p className="text-sm text-ink-soft">{seat.personality}</p>
                    <blockquote className="seat-quote mt-auto">“{seat.signatureLine}”</blockquote>
                    <dl className="space-y-0.5 text-xs text-muted">
                      <div className="flex gap-1.5">
                        <dt>Voice:</dt>
                        <dd className="text-ink-soft">{seat.voice}</dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt>Look:</dt>
                        <dd className="text-ink-soft">
                          {seat.visualDirection}; {seat.palette.label.toLowerCase()}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
