import { CircleAlert, CircleCheck, CircleDashed, CircleX, type LucideIcon } from "lucide-react";
import { outcomeLabel } from "@/lib/scenes/format";
import type { CheckOutcome } from "@/lib/scenes/types";

const outcomeStyle: Record<CheckOutcome, { icon: LucideIcon; className: string }> = {
  pass: { icon: CircleCheck, className: "text-accent" },
  caution: { icon: CircleAlert, className: "text-ink" },
  fail: { icon: CircleX, className: "text-blocked" },
  "not-assessed": { icon: CircleDashed, className: "text-muted" },
};

/** Icon plus a text label, so the outcome never relies on colour alone. */
export function Outcome({ outcome }: { outcome: CheckOutcome }) {
  const { icon: Icon, className } = outcomeStyle[outcome];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${className}`}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {outcomeLabel[outcome]}
    </span>
  );
}
