import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoSceneCandidates } from "@/components/scenes/no-scene-candidates";
import { SceneWorkspace } from "@/components/scenes/scene-workspace";
import { WorkspaceHeader } from "@/components/workflow/workspace-header";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { canStartPlacementReview, formatDuration } from "@/lib/catalogue/eligibility";

/** Only eligible, pipeline-enabled titles have a scene workspace. */
export async function generateStaticParams() {
  return catalogue.filter(canStartPlacementReview).map((t) => ({ titleId: t.id }));
}

function findReviewableTitle(titleId: string) {
  const title = catalogue.find((t) => t.id === titleId);
  return title && canStartPlacementReview(title) ? title : null;
}

export async function generateMetadata({
  params,
}: PageProps<"/titles/[titleId]/scenes">): Promise<Metadata> {
  const { titleId } = await params;
  const title = findReviewableTitle(titleId);
  return { title: title ? `Scene selection: ${title.title} | NeatFlix` : "NeatFlix" };
}

export default async function SceneWorkspacePage({
  params,
}: PageProps<"/titles/[titleId]/scenes">) {
  const { titleId } = await params;
  const title = findReviewableTitle(titleId);
  if (!title) notFound();

  const review = getSceneReview(title.id);

  return (
    <main id="main" tabIndex={-1} className="flex-1 outline-none">
      <WorkspaceHeader
        title={title}
        stage="Scene selection"
        back={{ href: "/#titles", label: "Back to catalogue" }}
        context={[
          { label: "Case", value: review?.caseId ?? "Not opened" },
          { label: "Runtime", value: formatDuration(title.durationSeconds) },
          { label: "Genre", value: title.genre },
          { label: "Rating", value: title.rating },
        ]}
        fixtureNote={
          <>
            <strong className="font-semibold text-ink">Demo fixtures.</strong> Scene records on
            this page are hand-authored stand-ins until real scene analysis is connected.
          </>
        }
      />
      {review ? (
        <SceneWorkspace title={title} review={review} />
      ) : (
        <NoSceneCandidates title={title} />
      )}
    </main>
  );
}
