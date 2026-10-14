import {
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  UserRoundSearch,
  UserX,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { CatalogueTitle } from "@/lib/catalogue/types";

type Tone = "positive" | "neutral" | "caution" | "blocked";

type BadgeSpec = { key: string; label: string; icon: LucideIcon; tone: Tone };

const toneClass: Record<Tone, string> = {
  positive: "text-accent border-accent/35 bg-accent/10",
  neutral: "text-muted border-line-strong bg-white/[0.03]",
  caution: "text-ink-soft border-line-strong bg-white/[0.06]",
  blocked: "text-blocked border-blocked/40 bg-blocked/10",
};

const rightsBadge: Record<CatalogueTitle["rightsStatus"], BadgeSpec> = {
  cleared: { key: "rights", label: "Rights cleared", icon: ShieldCheck, tone: "positive" },
  "pending-review": { key: "rights", label: "Rights in review", icon: ShieldAlert, tone: "caution" },
  "not-cleared": { key: "rights", label: "Rights not cleared", icon: ShieldX, tone: "blocked" },
};

const actorBadge: Record<CatalogueTitle["actorRestriction"], BadgeSpec | null> = {
  none: null,
  restricted: { key: "actor", label: "Restricted", icon: UserX, tone: "blocked" },
  unknown: { key: "actor", label: "Actor check needed", icon: UserRoundSearch, tone: "caution" },
};

const processingBadge: Record<CatalogueTitle["processingStatus"], BadgeSpec> = {
  "review-ready": { key: "processing", label: "Review ready", icon: CircleCheck, tone: "positive" },
  processing: { key: "processing", label: "Processing", icon: LoaderCircle, tone: "neutral" },
  "not-processed": { key: "processing", label: "Not processed", icon: CircleDashed, tone: "neutral" },
};

const pipelineBadge: BadgeSpec = {
  key: "pipeline",
  label: "Pipeline enabled",
  icon: Workflow,
  tone: "positive",
};

/** Operational badges in a fixed order: rights, actor, processing, pipeline. */
export function getStatusBadges(title: CatalogueTitle): BadgeSpec[] {
  return [
    rightsBadge[title.rightsStatus],
    actorBadge[title.actorRestriction],
    processingBadge[title.processingStatus],
    title.pipelineEnabled ? pipelineBadge : null,
  ].filter((b): b is BadgeSpec => b !== null);
}

export function StatusBadge({ spec, size = "md" }: { spec: BadgeSpec; size?: "sm" | "md" }) {
  const Icon = spec.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium leading-none ${toneClass[spec.tone]} ${
        size === "sm" ? "px-2 py-1 text-[0.75rem]" : "px-2.5 py-1.5 text-[0.8125rem]"
      }`}
    >
      <Icon aria-hidden="true" className={size === "sm" ? "size-3.5" : "size-4"} strokeWidth={2} />
      {spec.label}
    </span>
  );
}

export function StatusBadges({
  title,
  size,
  className = "",
}: {
  title: CatalogueTitle;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <ul className={`flex flex-wrap gap-1.5 ${className}`} aria-label="Status">
      {getStatusBadges(title).map((spec) => (
        <li key={spec.key}>
          <StatusBadge spec={spec} size={size} />
        </li>
      ))}
    </ul>
  );
}
