import Image from "next/image";
import type { CSSProperties } from "react";
import type { ArtworkRef, PlaceholderArtwork } from "@/lib/catalogue/types";

/**
 * Renders a title's artwork. Image artwork is layered over its placeholder
 * gradient: next/image hides a broken image (transparent alt text), so the
 * gradient shows through with no JavaScript needed. Placeholders are original
 * CSS compositions with film grain on top.
 */
export function TitleArtwork({
  artwork,
  title,
  className = "",
  decorative = false,
  sizes = "100vw",
  fit = "wide",
  eager = false,
}: {
  artwork: ArtworkRef;
  title: string;
  className?: string;
  /** Set when an adjacent heading already names the title. */
  decorative?: boolean;
  /** Rendered width hints for responsive image selection. */
  sizes?: string;
  /** "responsive" uses the tall crop below md and the wide crop above it. */
  fit?: "wide" | "responsive";
  /** Load immediately; use for above-the-fold artwork. */
  eager?: boolean;
}) {
  if (artwork.kind === "image") {
    const style = {
      ...gradientStyle(artwork.fallback),
      "--art-pos-wide": artwork.position.wide,
      "--art-pos-tall": artwork.position.tall,
    } as CSSProperties;

    return (
      <div className={className} style={style}>
        <Image
          src={artwork.src}
          alt={decorative ? "" : artwork.alt}
          fill
          sizes={sizes}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : undefined}
          className={`object-cover ${fit === "responsive" ? "art-pos-responsive" : "art-pos-wide"}`}
        />
      </div>
    );
  }

  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": `Placeholder artwork for ${title}` };

  return <div {...a11y} className={`artwork-grain ${className}`} style={gradientStyle(artwork)} />;
}

function gradientStyle(artwork: PlaceholderArtwork): CSSProperties {
  const [h1, h2] = artwork.hues;
  const { x, y } = artwork.focus;
  return {
    backgroundImage: [
      `radial-gradient(ellipse 55% 70% at ${x}% ${y}%, hsl(${h1} 70% 62% / 0.55), transparent 70%)`,
      `radial-gradient(ellipse 80% 60% at ${100 - x}% ${100 - y}%, hsl(${h2} 55% 38% / 0.6), transparent 75%)`,
      `linear-gradient(${155 + (h1 % 40)}deg, hsl(${h2} 35% 12%), hsl(${h1} 30% 7%) 70%)`,
    ].join(", "),
  };
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
