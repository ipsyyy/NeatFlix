import { ArrowRight, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import {
  APPROVED_RESULT_HEADING,
  CASE_DEMO_PATH,
  ORIGINAL_REGISTERED_SCENE_LABEL,
  PLACEMENT_STAGE_LABEL,
  placementResultFor,
  placementResultSrc,
  placementStage,
  sourceSceneLabel,
  sourceVideoSrc,
  TITLE_SOURCE_VIDEOS,
  type PlacementStage,
  type TitleMedia,
} from "@/lib/catalogue/title-media";
import type { CatalogueTitle } from "@/lib/catalogue/types";

const decisionLabel: Record<string, string> = {
  approved: "Approved",
  "approved-with-limitation": "Approved with limitation",
};

const stageClass: Record<PlacementStage, string> = {
  "screened-out": "border-blocked/40 bg-blocked/[0.07]",
  review: "border-line-strong bg-white/[0.03]",
  selected: "border-accent/30 bg-accent/[0.07]",
};

const stageHeadingClass: Record<PlacementStage, string> = {
  "screened-out": "text-blocked",
  review: "text-ink",
  selected: "text-accent",
};

/**
 * A title record's video section: the unedited source clip, where the title
 * stands for placement, and, only for the recorded case's title, the approved
 * placement result. Renders nothing for titles without a source clip.
 */
export function TitleMediaPanel({ title, media }: { title: CatalogueTitle; media: TitleMedia }) {
  const file = TITLE_SOURCE_VIDEOS[title.id];
  if (!file) return null;
  const check = media.sourceVideos[title.id];
  const label = sourceSceneLabel(title.id, media.cases);
  const stage = placementStage(title, media.cases);
  const result = placementResultFor(title.id, media.cases);
  const poster = title.artwork.kind === "image" ? title.artwork.src : undefined;

  return (
    <section aria-label="Title video" className="space-y-5">
      {check?.ok ? (
        <TitleVideo id="title-source-video" src={sourceVideoSrc(file)} label={label} poster={poster}>
          <span className="block">
            {label === ORIGINAL_REGISTERED_SCENE_LABEL
              ? "The unedited source clip registered for the placement pipeline."
              : "The unedited source clip. No placement has been applied to it."}
          </span>
        </TitleVideo>
      ) : (
        <VideoUnavailable label={label} reason={check?.reason ?? "The source video was not checked."} />
      )}

      <div data-testid="placement-stage" className={`rounded-xl border px-4 py-3 text-sm text-ink-soft ${stageClass[stage.stage]}`}>
        <p>
          <strong className={`font-semibold ${stageHeadingClass[stage.stage]}`}>{PLACEMENT_STAGE_LABEL[stage.stage]}.</strong>{" "}
          <span className="text-ink">{stage.status}</span>
        </p>
        <p className="mt-1">{stage.detail}</p>
      </div>

      {stage.stage === "selected" && (
        <section aria-labelledby="placement-result-heading" className="space-y-3 border-t border-line pt-5">
          <h3 id="placement-result-heading" className="text-lg font-semibold text-ink">
            {APPROVED_RESULT_HEADING}
          </h3>
          {result ? (
            <TitleVideo id="placement-result-video" src={placementResultSrc} label={result.label} poster={poster}>
              <span className="block">
                Human review: <strong className="font-semibold text-ink">{decisionLabel[result.decision] ?? result.decision}</strong>
              </span>
              {result.limitations.length > 0 && (
                <ul className="list-disc space-y-1 pl-5" aria-label="Limitations">
                  {result.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
              <span className="block">{result.disclosure}</span>
            </TitleVideo>
          ) : (
            <VideoUnavailable
              label={APPROVED_RESULT_HEADING}
              reason="The registered Runway video is not verified on this machine. Run npm run demo:snapshot."
            />
          )}
          <a
            href={CASE_DEMO_PATH}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent underline-offset-4 hover:underline"
          >
            View the complete case and pipeline
            <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        </section>
      )}
    </section>
  );
}

/**
 * An accessible, never-autoplaying video with a visible caption. The caption
 * names the video for assistive technology; `poster` is the title's artwork.
 */
export function TitleVideo({
  id,
  src,
  label,
  poster,
  children,
}: {
  id: string;
  src: string;
  label: string;
  poster?: string;
  /** Status and disclosure shown under the player. */
  children?: ReactNode;
}) {
  return (
    <figure className="space-y-3">
      <video
        src={src}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        aria-labelledby={`${id}-label`}
        data-testid={id}
        className="aspect-video w-full rounded-xl border border-line bg-canvas"
      />
      <figcaption className="space-y-2 text-sm text-ink-soft">
        <span id={`${id}-label`} className="block font-semibold text-ink">
          {label}
        </span>
        {children}
      </figcaption>
    </figure>
  );
}

/** Shown in place of a player whose media failed its check, so nothing renders broken. */
export function VideoUnavailable({ label, reason }: { label: string; reason: string }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-dashed border-line-strong px-4 py-3 text-sm text-ink-soft">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-blocked" />
      <p>
        <strong className="font-semibold text-ink">{label} unavailable.</strong> {reason}
      </p>
    </div>
  );
}
