import { TitleArtwork } from "@/components/catalogue/title-artwork";
import type { Campaign } from "@/lib/campaigns/types";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import { formatTimecode } from "@/lib/scenes/format";
import type { SceneCandidate } from "@/lib/scenes/types";

/** The scene carried forward from scene selection. */
export function SceneContext({
  title,
  scene,
  campaign,
  className = "",
}: {
  title: CatalogueTitle;
  scene: SceneCandidate;
  campaign: Campaign;
  className?: string;
}) {
  return (
    <section aria-labelledby="scene-context-heading" className={`panel overflow-hidden ${className}`}>
      <div className="relative aspect-[21/9] border-b border-line bg-canvas">
        <TitleArtwork
          artwork={title.artwork}
          title={title.title}
          decorative
          sizes="(min-width: 1024px) 30vw, 100vw"
          className="absolute inset-0"
        />
        <p className="absolute bottom-2 left-2 rounded-md bg-canvas/80 px-2 py-1 text-xs text-ink-soft backdrop-blur">
          Title artwork, not a scene frame
        </p>
      </div>
      <div className="p-5">
        <h2 id="scene-context-heading" className="panel-heading">
          Selected scene
        </h2>
        <p className="mt-2 text-lg font-semibold text-ink">{scene.name}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Item label="Timestamp" value={`${formatTimecode(scene.startSeconds)}–${formatTimecode(scene.endSeconds)}`} />
          <Item label="Tone" value={scene.tone} />
          <Item label="Camera" value={scene.camera} />
          <Item label="Surface" value={scene.surface} />
          <div className="col-span-2">
            <dt className="text-muted">Natural opportunities</dt>
            <dd className="mt-1.5 flex flex-wrap gap-1.5">
              {scene.opportunities.map((o) => {
                const matched = o === campaign.placementObject;
                return (
                  <span
                    key={o}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                      matched ? "border-accent/50 bg-accent/10 text-accent" : "border-line-strong text-ink-soft"
                    }`}
                  >
                    {o}
                    {matched && <span className="sr-only"> (matched to this campaign)</span>}
                  </span>
                );
              })}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}
