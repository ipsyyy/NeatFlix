"use client";

import { Play, Square, Volume2, VolumeX } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from "react";
import {
  HOVER_DELAY_MS,
  heroPreviewReducer,
  initialHeroPreview,
  type HeroPreviewEvent,
  type HeroPreviewState,
} from "@/lib/catalogue/hero-preview";

type HeroPreviewContextValue = {
  src: string;
  label: string;
  state: HeroPreviewState;
  dispatch: Dispatch<HeroPreviewEvent>;
  videoRef: RefObject<HTMLVideoElement | null>;
  mediaRef: RefObject<HTMLDivElement | null>;
};

const HeroPreviewContext = createContext<HeroPreviewContextValue | null>(null);

function useHeroPreview() {
  const ctx = useContext(HeroPreviewContext);
  if (!ctx) throw new Error("Hero preview parts must be used inside HeroPreview");
  return ctx;
}

const matches = (query: string) => window.matchMedia(query).matches;
const NO_SOURCE = 3; // HTMLMediaElement.NETWORK_NO_SOURCE

/**
 * Owns the hero preview: drives the video from the reducer, and listens for
 * hover on the media area, Escape, and pointer presses outside the hero.
 * Focus is never moved or trapped.
 */
export function HeroPreview({ src, label, children }: { src: string; label: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(heroPreviewReducer, initialHeroPreview);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);

  // A load failure can happen before hydration attaches onError; catch it here too.
  useEffect(() => {
    const v = videoRef.current;
    if (v && (v.error || v.networkState === NO_SOURCE)) dispatch({ type: "error" });
  }, []);

  useEffect(() => {
    if (state.status !== "waiting") return;
    const timer = setTimeout(() => dispatch({ type: "hover-elapsed" }), HOVER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state.status]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (state.status === "playing") {
      // An interrupted play() (stopped mid-load) rejects harmlessly; real failures raise the error event.
      v.play().catch(() => {});
    } else if (state.status === "idle") {
      v.pause();
      v.currentTime = 0;
    }
  }, [state.status]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = state.muted;
  }, [state.muted]);

  // Hover is tracked on the whole hero, because the text column sits over the media area.
  useEffect(() => {
    const media = mediaRef.current;
    const hero = media?.closest("section");
    if (!media || !hero) return;
    let inside = false;
    const track = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = media.getBoundingClientRect();
      const now = e.type !== "pointerleave" && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (now === inside) return;
      inside = now;
      dispatch(
        now
          ? { type: "pointer-enter", hoverCapable: matches("(hover: hover) and (pointer: fine)"), reducedMotion: matches("(prefers-reduced-motion: reduce)") }
          : { type: "pointer-leave" },
      );
    };
    hero.addEventListener("pointermove", track);
    hero.addEventListener("pointerleave", track);
    return () => {
      hero.removeEventListener("pointermove", track);
      hero.removeEventListener("pointerleave", track);
    };
  }, []);

  const active = state.status !== "idle";
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dispatch({ type: "escape" });
    const onDown = (e: PointerEvent) => {
      const hero = mediaRef.current?.closest("section");
      if (hero && !hero.contains(e.target as Node)) dispatch({ type: "pointer-outside" });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [active]);

  const value = useMemo(() => ({ src, label, state, dispatch, videoRef, mediaRef }), [src, label, state]);
  return <HeroPreviewContext.Provider value={value}>{children}</HeroPreviewContext.Provider>;
}

/**
 * The preview video, layered over the poster artwork in the hero frame. It
 * stays transparent until it has frames, so no empty video frame ever shows.
 */
export function HeroPreviewVideo() {
  const { src, label, state, dispatch, videoRef, mediaRef } = useHeroPreview();
  const shown = state.visible && !state.failed;
  return (
    <div ref={mediaRef} className="absolute inset-0" data-testid="hero-media">
      {!state.failed && (
        <video
          ref={videoRef}
          src={src}
          muted
          playsInline
          preload="metadata"
          disablePictureInPicture
          aria-label={label}
          aria-hidden={!shown}
          tabIndex={-1}
          data-testid="hero-preview-video"
          data-state={shown ? "playing" : "poster"}
          onPlaying={() => dispatch({ type: "frames-ready" })}
          onEnded={() => dispatch({ type: "ended" })}
          onError={() => dispatch({ type: "error" })}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-500 ease-out motion-reduce:transition-none ${
            shown ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}

const controlClass =
  "inline-flex h-12 items-center gap-2 rounded-full border border-line-strong bg-canvas/60 px-5 text-[0.9375rem] font-semibold text-ink backdrop-blur-sm transition-colors hover:border-ink-soft";

/** Explicit Preview / Stop control, plus mute once frames are playing. Native buttons: Enter and Space work. */
export function HeroPreviewControls() {
  const { label, state, dispatch } = useHeroPreview();
  if (state.failed) {
    return (
      <p role="status" className="text-sm text-muted" data-testid="hero-preview-unavailable">
        Preview unavailable
      </p>
    );
  }
  const playing = state.status === "playing";
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: "toggle" })} aria-pressed={playing} className={controlClass} data-testid="hero-preview-toggle">
        {playing ? <Square aria-hidden="true" className="size-4 fill-current" /> : <Play aria-hidden="true" className="size-4 fill-current" />}
        {playing ? "Stop preview" : "Play preview"}
      </button>
      {playing && state.visible && (
        <button
          type="button"
          onClick={() => dispatch({ type: "toggle-mute" })}
          aria-label={state.muted ? "Unmute preview" : "Mute preview"}
          className="grid size-12 place-items-center rounded-full border border-line-strong bg-canvas/60 text-ink backdrop-blur-sm transition-colors hover:border-ink-soft"
          data-testid="hero-preview-mute"
        >
          {state.muted ? <VolumeX aria-hidden="true" className="size-5" /> : <Volume2 aria-hidden="true" className="size-5" />}
        </button>
      )}
      <p aria-live="polite" className="sr-only">
        {state.visible ? `Playing muted: ${label}` : ""}
      </p>
      {/* Provenance stays on screen while the generated preview plays. */}
      {state.visible && (
        <p className="basis-full text-xs text-muted" data-testid="hero-preview-caption">
          {label}
        </p>
      )}
    </>
  );
}
