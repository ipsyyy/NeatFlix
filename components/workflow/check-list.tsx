import type { CheckOutcome } from "@/lib/scenes/types";
import { Outcome } from "./outcome";

export type CheckRow = { label: string; outcome: CheckOutcome; evidence: string };

/**
 * A labelled list of checks: name, outcome (icon + text), and the evidence behind it.
 * "stacked" keeps evidence on its own line at every width, for narrow columns.
 */
export function CheckList({
  label,
  rows,
  layout = "table",
}: {
  label: string;
  rows: CheckRow[];
  layout?: "table" | "stacked";
}) {
  const wide = layout === "table";
  return (
    <ul aria-label={label} className="mt-3 text-sm">
      {rows.map((r) => (
        <li
          key={r.label}
          className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-line py-3 ${
            wide ? "sm:grid-cols-[11rem_7.5rem_minmax(0,1fr)]" : ""
          }`}
        >
          <span className="font-medium text-ink">{r.label}</span>
          <span className={`justify-self-end ${wide ? "sm:justify-self-start" : ""}`}>
            <Outcome outcome={r.outcome} />
          </span>
          <span className={`col-span-2 leading-relaxed text-ink-soft ${wide ? "sm:col-span-1" : ""}`}>
            {r.evidence}
          </span>
        </li>
      ))}
    </ul>
  );
}
