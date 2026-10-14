import type { CSSProperties } from "react";
import type { ArtworkRef } from "@/lib/catalogue/types";

/**
 * Renders a title's artwork. Placeholders are original CSS compositions:
 * a soft light source over a dark two-hue field, with film grain on top.
 */
export function TitleArtwork({
  artwork,
  title,
  className = "",
  decorative = false,
}: {
  artwork: ArtworkRef;
  title: string;
  className?: string;
  /** Set when an adjacent heading already names the title. */
  decorative?: boolean;
}) {
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": `Placeholder artwork for ${title}` };

  if (artwork.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- real artwork source is not decided yet
      <img
        src={artwork.src}
        alt={decorative ? "" : artwork.alt}
        className={`object-cover ${className}`}
      />
    );
  }

  const [h1, h2] = artwork.hues;
  const { x, y } = artwork.focus;
  const style: CSSProperties = {
    backgroundImage: [
      `radial-gradient(ellipse 55% 70% at ${x}% ${y}%, hsl(${h1} 70% 62% / 0.55), transparent 70%)`,
      `radial-gradient(ellipse 80% 60% at ${100 - x}% ${100 - y}%, hsl(${h2} 55% 38% / 0.6), transparent 75%)`,
      `linear-gradient(${155 + (h1 % 40)}deg, hsl(${h2} 35% 12%), hsl(${h1} 30% 7%) 70%)`,
    ].join(", "),
  };

  return <div {...a11y} className={`artwork-grain ${className}`} style={style} />;
}

/**
 * Broadcast-style corner marks and a title-safe guide. The gate is
 * NativeFrame's signature: it frames where a placement could live.
 */
export function GateMarks({
  always = false,
  className = "",
}: {
  always?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`gate-marks ${always ? "gate-marks--static" : ""} ${className}`}
    >
      <span className="gate-corner gate-corner--tl" />
      <span className="gate-corner gate-corner--tr" />
      <span className="gate-corner gate-corner--bl" />
      <span className="gate-corner gate-corner--br" />
      <span className="gate-safe" />
    </div>
  );
}
