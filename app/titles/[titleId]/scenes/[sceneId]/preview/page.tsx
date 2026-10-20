import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { join } from "node:path";
import { checkSourceVideo } from "@/app/load-title-media";
import { PlacementReplay } from "@/components/placement/placement-replay";
import { WorkspaceHeader } from "@/components/workflow/workspace-header";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { canStartPlacementReview } from "@/lib/catalogue/eligibility";
import { recordedReplayFor, REPLAY_DISCLOSURE, RECORDED_REPLAYS } from "@/lib/placement/replay";
import { formatTimecode } from "@/lib/scenes/format";
import { canProceedToCampaignMatching } from "@/lib/scenes/workflow";

/**
 * The placement preview of a recorded case: the same gates as campaign
 * matching, and a recorded replay must exist. Anything else is not found.
 */
function resolvePreviewContext(titleId: string, sceneId: string) {
  const title = catalogue.find((t) => t.id === titleId);
  if (!title || !canStartPlacementReview(title)) return null;
  const scene = getSceneReview(title.id)?.scenes.find((s) => s.id === sceneId);
  const replay = recordedReplayFor(titleId, sceneId);
  if (!scene || !canProceedToCampaignMatching(scene) || !replay) return null;
  return { title, scene, replay };
}

export async function generateStaticParams() {
  return RECORDED_REPLAYS.map((r) => ({ titleId: r.titleId, sceneId: r.sceneId }));
}

export async function generateMetadata({ params }: PageProps<"/titles/[titleId]/scenes/[sceneId]/preview">): Promise<Metadata> {
  const { titleId, sceneId } = await params;
  const ctx = resolvePreviewContext(titleId, sceneId);
  return { title: ctx ? `Placement preview: ${ctx.title.title} | NeatFlix` : "NeatFlix" };
}

export default async function PlacementPreviewPage({ params }: PageProps<"/titles/[titleId]/scenes/[sceneId]/preview">) {
  const { titleId, sceneId } = await params;
  const ctx = resolvePreviewContext(titleId, sceneId);
  if (!ctx) notFound();
  const { title, scene, replay } = ctx;
  // Not awaited: checked at request time, read by the player once the replay completes.
  const video = checkSourceVideo(join(process.cwd(), "public", replay.video.src), replay.video.src.split("/").pop()!);

  return (
    <main id="main" tabIndex={-1} className="flex-1 outline-none">
      <WorkspaceHeader
        title={title}
        stage="Placement preview"
        back={{ href: `/titles/${title.id}/scenes/${scene.id}/campaign`, label: "Back to campaign matching" }}
        context={[
          { label: "Case", value: replay.caseId },
          { label: "Scene", value: scene.name },
          { label: "Timestamp", value: `${formatTimecode(scene.startSeconds)}–${formatTimecode(scene.endSeconds)}` },
          { label: "Product", value: replay.product },
        ]}
        fixtureNote={
          <>
            <strong className="font-semibold text-ink">{REPLAY_DISCLOSURE}</strong> The steps below replay the
            decisions the five agents recorded for this case, and the video was generated and approved earlier.
          </>
        }
      />
      <PlacementReplay replay={replay} poster={title.artwork.kind === "image" ? title.artwork.src : undefined} video={video} />
    </main>
  );
}
