import { Lock } from "lucide-react";
import { matchDecisionLabel, type CampaignMatch } from "@/lib/campaigns/matching";
import type { Campaign } from "@/lib/campaigns/types";
import { formatTimecode } from "@/lib/scenes/format";
import type { SceneCandidate } from "@/lib/scenes/types";

export function CampaignSummary({
  caseId,
  scene,
  campaign,
  match,
  className = "",
}: {
  caseId: string;
  scene: SceneCandidate;
  campaign: Campaign;
  match: CampaignMatch;
  className?: string;
}) {
  const { minAge, maxAge } = campaign.audience;
  const rows: { label: string; value: string }[] = [
    { label: "Case", value: caseId },
    { label: "Product", value: campaign.product },
    { label: "Placed as", value: `${campaign.placementObject}, stationary with no hand interaction` },
    { label: "Scene", value: `${scene.name}, ${formatTimecode(scene.startSeconds)}–${formatTimecode(scene.endSeconds)}` },
    { label: "Audience", value: `Ages ${minAge}–${maxAge}, ad-supported tier, ${campaign.market}` },
    { label: "Decision", value: matchDecisionLabel[match.decision] },
  ];

  return (
    <section aria-labelledby="campaign-summary-heading" className={`panel p-5 ${className}`}>
      <h2 id="campaign-summary-heading" className="panel-heading">
        Selected campaign
      </h2>
      <dl className="mt-3 divide-y divide-line text-sm">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-2.5">
            <dt className="text-muted">{r.label}</dt>
            <dd className="font-medium text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 border-t border-line pt-4">
        <button
          type="button"
          disabled
          aria-describedby="placement-preview-note"
          className="inline-flex h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-line-strong bg-white/[0.04] px-5 text-[0.9375rem] font-semibold text-muted"
        >
          <Lock aria-hidden="true" className="size-4" />
          Continue to placement preview
        </button>
        <p id="placement-preview-note" className="mt-2 text-center text-xs text-muted">
          Not built yet. Placement preview comes in a later build.
        </p>
      </div>
    </section>
  );
}
