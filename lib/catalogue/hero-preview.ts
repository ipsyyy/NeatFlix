/**
 * The hero's hover-to-preview behaviour as a pure state machine, so every rule
 * is testable without a browser. A fine hover pointer resting on the hero
 * media starts a muted preview after HOVER_DELAY_MS; leaving stops it. The
 * Preview button starts or stops it explicitly on any device. Reduced-motion
 * and touch users only ever get the explicit button. Nothing plays on load.
 */

export const HOVER_DELAY_MS = 400;

/** The deployable public copy of the approved full-scene V4 video, by featured title. */
export const HERO_PREVIEW_VIDEOS: Readonly<Record<string, string>> = Object.freeze({
  "luv-hypothesis": "/demo-videos/luv-hypothesis-daybreak-v4.mp4",
});

export type HeroPreviewState = {
  /** "waiting": a hover is resting, the delay has not elapsed yet. */
  status: "idle" | "waiting" | "playing";
  source: "hover" | "explicit" | null;
  /** The video has produced frames; only then does it fade in over the poster. */
  visible: boolean;
  muted: boolean;
  /** The video is missing or failed; the poster stays and no preview is offered. */
  failed: boolean;
};

export type HeroPreviewEvent =
  | { type: "pointer-enter"; hoverCapable: boolean; reducedMotion: boolean }
  | { type: "hover-elapsed" }
  | { type: "pointer-leave" }
  | { type: "toggle" }
  | { type: "toggle-mute" }
  | { type: "escape" }
  | { type: "pointer-outside" }
  | { type: "ended" }
  | { type: "frames-ready" }
  | { type: "error" };

export const initialHeroPreview: HeroPreviewState = { status: "idle", source: null, visible: false, muted: true, failed: false };

const stopped = (s: HeroPreviewState): HeroPreviewState => ({ ...initialHeroPreview, failed: s.failed });

export function heroPreviewReducer(s: HeroPreviewState, e: HeroPreviewEvent): HeroPreviewState {
  switch (e.type) {
    case "pointer-enter":
      // Hover never starts anything for touch, reduced motion, a failed video, or while already active.
      return s.failed || !e.hoverCapable || e.reducedMotion || s.status !== "idle" ? s : { ...s, status: "waiting", source: "hover" };
    case "hover-elapsed":
      return s.status === "waiting" ? { ...s, status: "playing", muted: true } : s;
    case "pointer-leave":
      return s.source === "hover" ? stopped(s) : s;
    case "toggle":
      if (s.failed) return s;
      return s.status === "playing" ? stopped(s) : { ...s, status: "playing", source: "explicit", visible: false, muted: true };
    case "toggle-mute":
      return s.status === "playing" && s.visible ? { ...s, muted: !s.muted } : s;
    case "escape":
    case "pointer-outside":
    case "ended":
      return s.status === "idle" ? s : stopped(s);
    case "frames-ready":
      return s.status === "playing" ? { ...s, visible: true } : s;
    case "error":
      return { ...initialHeroPreview, failed: true };
  }
}
