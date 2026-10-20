import { CheckList } from "@/components/workflow/check-list";
import type { CampaignMatch } from "@/lib/campaigns/matching";
import type { Campaign } from "@/lib/campaigns/types";
import type { CatalogueTitle } from "@/lib/catalogue/types";
import type { SceneCandidate } from "@/lib/scenes/types";
import { placementPreviewPath, recordedReplayFor } from "@/lib/placement/replay";
import { CampaignBrief } from "./campaign-brief";
import { CampaignSummary } from "./campaign-summary";
import { Recommendation } from "./recommendation";
import { SceneContext } from "./scene-context";

/**
 * Campaign-matching workspace. Presentation only: every outcome shown here
 * comes from the matching rules in lib/campaigns/matching.ts.
 *
 * Below lg the column wrappers use display: contents and `order` sets the
 * reading order; from lg up they become two independent columns.
 */
export function CampaignWorkspace({
  title,
  caseId,
  scene,
  campaign,
  match,
}: {
  title: CatalogueTitle;
  caseId: string;
  scene: SceneCandidate;
  campaign: Campaign;
  match: CampaignMatch;
}) {
  return (
    <div className="shell flex flex-col gap-6 py-10 lg:grid lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,1fr)] lg:items-start">
      <div className="contents lg:flex lg:flex-col lg:gap-6">
        <Recommendation className="order-1 lg:order-none" campaign={campaign} scene={scene} match={match} />

        <section aria-labelledby="fit-heading" className="panel order-5 p-5 lg:order-none">
          <h2 id="fit-heading" className="panel-heading">
            Scene-to-product fit
          </h2>
          <p className="mt-1 text-sm text-muted">
            {campaign.productFormat} in {scene.name}, checked against the scene&rsquo;s evidence.
          </p>
          <CheckList label="Scene-to-product fit checks" rows={match.fitChecks} />
        </section>

        <section aria-labelledby="safety-heading" className="panel order-6 p-5 lg:order-none">
          <h2 id="safety-heading" className="panel-heading">
            Brand-safety checks
          </h2>
          <p className="mt-1 text-sm text-muted">Any failure here blocks the recommendation outright.</p>
          <CheckList label="Brand-safety checks" rows={match.safetyChecks} />
        </section>

        <section aria-labelledby="limits-heading" className="panel order-7 p-5 lg:order-none">
          <h2 id="limits-heading" className="panel-heading">
            Limitations and assumptions
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-soft marker:text-muted">
            {match.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      </div>

      <div className="contents lg:flex lg:flex-col lg:gap-6">
        <SceneContext className="order-2 lg:order-none" title={title} scene={scene} campaign={campaign} />
        <CampaignBrief className="order-3 lg:order-none" campaign={campaign} />

        <section aria-labelledby="audience-heading" className="panel order-4 p-5 lg:order-none">
          <h2 id="audience-heading" className="panel-heading">
            Audience eligibility
          </h2>
          <p className="mt-1 text-sm text-muted">Rules only. No subscriber records are counted or targeted yet.</p>
          <CheckList label="Audience eligibility rules" rows={match.audienceRules} layout="stacked" />
        </section>

        <CampaignSummary
          className="order-8 lg:order-none"
          caseId={caseId}
          scene={scene}
          campaign={campaign}
          match={match}
          previewHref={recordedReplayFor(title.id, scene.id) ? placementPreviewPath(title.id, scene.id) : undefined}
        />
      </div>
    </div>
  );
}
