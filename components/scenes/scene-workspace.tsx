"use client";

import { useState } from "react";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import type { SceneReview } from "@/lib/scenes/types";
import { EvidencePanel } from "./evidence-panel";
import { MediaReview } from "./media-review";
import { SceneCandidateList } from "./scene-candidate-list";
import { SelectedSceneSummary } from "./selected-scene-summary";

/**
 * Scene-selection workspace. Holds which candidate is selected; rejected
 * scenes are never selectable. Defaults to the recommended scene.
 */
export function SceneWorkspace({
  title,
  review,
}: {
  title: CatalogueTitle;
  review: SceneReview;
}) {
  const recommended = review.scenes.find((s) => s.decision === "recommended") ?? review.scenes[0];
  const [selectedId, setSelectedId] = useState(recommended.id);
  const selected = review.scenes.find((s) => s.id === selectedId) ?? recommended;

  const select = (id: string) => {
    const scene = review.scenes.find((s) => s.id === id);
    if (scene && scene.decision !== "rejected") setSelectedId(id);
  };

  // DOM order is the mobile reading order; the grid places panels into two columns on large screens.
  return (
    <div className="shell grid gap-6 py-10 lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,1fr)] lg:items-start">
      <MediaReview
        className="lg:col-start-1 lg:row-start-1"
        title={title}
        scenes={review.scenes}
        selected={selected}
      />
      <SceneCandidateList
        className="lg:col-start-2 lg:row-start-1"
        scenes={review.scenes}
        selectedId={selected.id}
        onSelect={select}
      />
      <EvidencePanel className="lg:col-start-1 lg:row-start-2" title={title} scene={selected} />
      <SelectedSceneSummary
        className="lg:col-start-2 lg:row-start-2"
        caseId={review.caseId}
        scene={selected}
      />
    </div>
  );
}
