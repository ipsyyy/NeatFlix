import { categoryLabel } from "@/lib/campaigns/rules";
import type { Campaign } from "@/lib/campaigns/types";

const riskLabel: Record<Campaign["brandSafetyRisk"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

export function CampaignBrief({ campaign, className = "" }: { campaign: Campaign; className?: string }) {
  const rows: { label: string; value: string }[] = [
    { label: "Advertiser", value: campaign.advertiser },
    { label: "Product", value: campaign.product },
    { label: "On-screen format", value: campaign.productFormat },
    { label: "Category", value: categoryLabel[campaign.category] },
    { label: "Market", value: campaign.market },
    { label: "Brand safety", value: riskLabel[campaign.brandSafetyRisk] },
    {
      label: "Placement length",
      value: `${campaign.placementSeconds.min}–${campaign.placementSeconds.max} seconds`,
    },
  ];

  return (
    <section aria-labelledby="brief-heading" className={`panel p-5 ${className}`}>
      <h2 id="brief-heading" className="panel-heading">
        Campaign brief
      </h2>
      <p className="mt-1 text-sm text-muted">Fictional advertiser. Demo fixture.</p>

      <div className="mt-4 rounded-xl bg-white/[0.03] p-4">
        <p className="text-sm text-muted">Objective</p>
        <p className="mt-0.5 font-medium leading-relaxed text-ink">{campaign.objective}</p>
      </div>

      <dl className="mt-4 divide-y divide-line text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted">{r.label}</dt>
            <dd className="text-right font-medium text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
