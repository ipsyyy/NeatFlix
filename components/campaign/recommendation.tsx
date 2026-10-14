import { CircleAlert, CircleCheck, CircleX, type LucideIcon } from "lucide-react";
import { matchDecisionLabel, type CampaignMatch, type MatchDecision } from "@/lib/campaigns/matching";
import type { Campaign } from "@/lib/campaigns/types";
import type { SceneCandidate } from "@/lib/scenes/types";

const decisionStyle: Record<MatchDecision, { icon: LucideIcon; panel: string; chip: string }> = {
  recommended: {
    icon: CircleCheck,
    panel: "border-accent/40 bg-accent/[0.06]",
    chip: "border-accent/40 bg-accent/10 text-accent",
  },
  "needs-review": {
    icon: CircleAlert,
    panel: "border-line-strong bg-white/[0.03]",
    chip: "border-line-strong bg-white/[0.06] text-ink",
  },
  "not-recommended": {
    icon: CircleX,
    panel: "border-blocked/40 bg-blocked/[0.06]",
    chip: "border-blocked/40 bg-blocked/10 text-blocked",
  },
};

export function Recommendation({
  campaign,
  scene,
  match,
  className = "",
}: {
  campaign: Campaign;
  scene: SceneCandidate;
  match: CampaignMatch;
  className?: string;
}) {
  const style = decisionStyle[match.decision];
  const Icon = style.icon;
  const checkCount = match.audienceRules.length + match.fitChecks.length + match.safetyChecks.length;

  return (
    <section
      aria-labelledby="recommendation-heading"
      className={`rounded-2xl border p-6 sm:p-7 ${style.panel} ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="recommendation-heading" className="panel-heading">
          Recommendation
        </h2>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-semibold ${style.chip}`}>
          <Icon aria-hidden="true" className="size-4" />
          {matchDecisionLabel[match.decision]}
        </span>
      </div>

      <p className="type-condensed mt-4 text-[clamp(2rem,4vw,3rem)] font-extrabold leading-[0.95] text-ink">
        {campaign.product}
      </p>
      <p className="mt-1 text-ink-soft">
        {campaign.advertiser}, for {scene.name}
      </p>
      <p className="mt-4 max-w-[60ch] leading-relaxed text-ink">{match.summary}</p>
      <p className="mt-1 text-sm text-muted">
        Based on {checkCount} rule-based checks over demo fixtures. Not an agent decision.
      </p>

      {match.whyItFits.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-semibold text-ink">Why the {campaign.placementObject.toLowerCase()} fits naturally</h3>
          <ul className="mt-2 space-y-2 text-sm leading-relaxed text-ink-soft">
            {match.whyItFits.map((reason) => (
              <li key={reason} className="flex gap-2.5">
                <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
