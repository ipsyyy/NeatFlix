import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CampaignWorkspace } from "@/components/campaign/campaign-workspace";
import { WorkspaceHeader } from "@/components/workflow/workspace-header";
import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { rankCampaignMatches } from "@/lib/campaigns/matching";
import { canStartPlacementReview, sceneWorkspacePath } from "@/lib/catalogue/eligibility";
import { formatTimecode } from "@/lib/scenes/format";
import { canProceedToCampaignMatching } from "@/lib/scenes/workflow";

/**
 * Resolves the title, review, and scene from the URL, applying every gate:
 * the title must be reviewable and the scene must pass all guardrails.
 * Anything else (including rejected scenes) is not found.
 */
function resolveCampaignContext(titleId: string, sceneId: string) {
  const title = catalogue.find((t) => t.id === titleId);
  if (!title || !canStartPlacementReview(title)) return null;
  const review = getSceneReview(title.id);
  const scene = review?.scenes.find((s) => s.id === sceneId);
  if (!review || !scene || !canProceedToCampaignMatching(scene)) return null;
  return { title, review, scene };
}

export async function generateStaticParams() {
  return catalogue.filter(canStartPlacementReview).flatMap((title) =>
    (getSceneReview(title.id)?.scenes ?? [])
      .filter(canProceedToCampaignMatching)
      .map((scene) => ({ titleId: title.id, sceneId: scene.id })),
  );
}

export async function generateMetadata({
  params,
}: PageProps<"/titles/[titleId]/scenes/[sceneId]/campaign">): Promise<Metadata> {
  const { titleId, sceneId } = await params;
  const ctx = resolveCampaignContext(titleId, sceneId);
  return { title: ctx ? `Campaign matching: ${ctx.title.title} | NeatFlix` : "NeatFlix" };
}

export default async function CampaignMatchingPage({
  params,
}: PageProps<"/titles/[titleId]/scenes/[sceneId]/campaign">) {
  const { titleId, sceneId } = await params;
  const ctx = resolveCampaignContext(titleId, sceneId);
  if (!ctx) notFound();
  const { title, review, scene } = ctx;

  const [best] = rankCampaignMatches(campaigns, scene, title);
  if (!best) notFound();

  return (
    <main id="main" tabIndex={-1} className="flex-1 outline-none">
      <WorkspaceHeader
        title={title}
        stage="Campaign matching"
        back={{ href: sceneWorkspacePath(title.id), label: "Back to scene selection" }}
        context={[
          { label: "Case", value: review.caseId },
          { label: "Scene", value: scene.name },
          { label: "Timestamp", value: `${formatTimecode(scene.startSeconds)}–${formatTimecode(scene.endSeconds)}` },
          { label: "Rating", value: title.rating },
        ]}
        fixtureNote={
          <>
            <strong className="font-semibold text-ink">Demo fixtures.</strong> Campaign, audience,
            and matching data are hand-authored. The recommendation comes from deterministic rules,
            not an AI agent.
          </>
        }
      />
      <CampaignWorkspace
        title={title}
        caseId={review.caseId}
        scene={scene}
        campaign={best.campaign}
        match={best.match}
      />
    </main>
  );
}
