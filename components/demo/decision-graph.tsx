"use client";

import { useState, type KeyboardEvent } from "react";
import { GRAPH_COLUMNS, GRAPH_LABEL, MEMORY_NOTE, type DecisionGraph, type GraphNode, type NodeTone, type PriorRejection } from "@/lib/demo/decision-graph";

const COL_W = 210;
const NODE_W = 176;
const NODE_H = 46;
const ROW_H = 62;
const TOP = 34;

/** Tone styling from the existing design tokens; shape and dash also differ, so colour is never the only cue. */
const TONE: Record<NodeTone, { stroke: string; fill: string; dash?: string; rx: number; label: string }> = {
  approved: { stroke: "var(--color-accent)", fill: "var(--color-raised)", rx: 8, label: "Approved" },
  rejected: { stroke: "var(--color-blocked)", fill: "var(--color-raised)", dash: "6 4", rx: 8, label: "Rejected" },
  evidence: { stroke: "var(--color-ink-soft)", fill: "var(--color-surface)", dash: "2 3", rx: 2, label: "Evidence" },
  agent: { stroke: "var(--color-muted)", fill: "var(--color-surface)", rx: 23, label: "Agent" },
  limitation: { stroke: "var(--color-blocked)", fill: "var(--color-surface)", dash: "1 3", rx: 2, label: "Limitation / failure" },
  context: { stroke: "var(--color-line-strong)", fill: "var(--color-surface)", rx: 8, label: "Case context / plan" },
};

const fmt = (iso: string) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function layout(graph: DecisionGraph) {
  const rows = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) {
    const row = rows.get(n.column) ?? 0;
    rows.set(n.column, row + 1);
    pos.set(n.id, { x: 12 + n.column * COL_W, y: TOP + row * ROW_H });
  }
  const height = TOP + Math.max(...rows.values()) * ROW_H;
  return { pos, width: 12 + GRAPH_COLUMNS.length * COL_W, height };
}

export function DecisionMemoryGraph({ graph, query, v3 }: { graph: DecisionGraph; query: { question: string; pair: string; answer: "yes" | "no"; rejections: PriorRejection[] }; v3: { mode: string; addedObjects: number | null; constraints: string[]; notes: { plan: string; note: string }[] } }) {
  const [selectedId, setSelectedId] = useState<string>("case");
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? graph.nodes[0];
  const { pos, width, height } = layout(graph);
  const related = new Set(graph.edges.filter((e) => e.from === selected.id || e.to === selected.id).flatMap((e) => [e.from, e.to]));
  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelectedId(id);
    }
  };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-4" data-testid="decision-graph">
      <p className="text-sm font-semibold text-ink" data-testid="decision-graph-label">
        {GRAPH_LABEL}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Graph legend">
        {(Object.keys(TONE) as NodeTone[]).map((t) => (
          <li key={t} className="inline-flex items-center gap-1.5">
            <svg width="18" height="12" aria-hidden="true">
              <rect x="1" y="1" width="16" height="10" rx={Math.min(TONE[t].rx, 5)} fill={TONE[t].fill} stroke={TONE[t].stroke} strokeDasharray={TONE[t].dash} strokeWidth="1.5" />
            </svg>
            {TONE[t].label}
          </li>
        ))}
      </ul>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="overflow-x-auto rounded-xl border border-line bg-canvas" tabIndex={-1}>
          <svg role="group" aria-label="Decision memory graph: select a node to see its record" viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block min-w-[56rem] max-w-none" style={{ width: "100%", height: "auto" }}>
            {GRAPH_COLUMNS.map((c, i) => (
              <text key={c} x={12 + i * COL_W} y={18} fill="var(--color-muted)" fontSize="11" fontWeight="600" letterSpacing="0.06em">
                {c.toUpperCase()}
              </text>
            ))}
            <g aria-hidden="true">
              {graph.edges.map((e) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                if (!a || !b) return null;
                const on = e.from === selected.id || e.to === selected.id;
                const informed = e.label === "informed";
                const [x1, y1, x2, y2] = a.x <= b.x ? [a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2] : [a.x, a.y + NODE_H / 2, b.x + NODE_W, b.y + NODE_H / 2];
                const mid = (x1 + x2) / 2;
                const d = a.x === b.x ? `M${a.x + NODE_W} ${y1} C ${a.x + NODE_W + 26} ${y1}, ${a.x + NODE_W + 26} ${b.y + NODE_H / 2}, ${a.x + NODE_W} ${b.y + NODE_H / 2}` : `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
                return <path key={`${e.from}>${e.to}`} d={d} fill="none" stroke={informed ? "var(--color-blocked)" : on ? "var(--color-accent)" : "var(--color-line-strong)"} strokeWidth={on || informed ? 1.8 : 1} strokeDasharray={informed ? "5 4" : undefined} opacity={on || informed ? 1 : 0.7} />;
              })}
            </g>
            {graph.nodes.map((n) => {
              const p = pos.get(n.id)!;
              const t = TONE[n.tone];
              const isSel = n.id === selected.id;
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  aria-label={`${n.type}: ${n.label}, ${n.outcome}`}
                  data-testid={`graph-node-${n.id}`}
                  onClick={() => setSelectedId(n.id)}
                  onKeyDown={(e) => onKey(e, n.id)}
                  className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[3]"
                  opacity={isSel || related.has(n.id) || related.size === 0 ? 1 : 0.55}
                >
                  <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={t.rx} fill={t.fill} stroke={isSel ? "var(--color-accent-strong)" : t.stroke} strokeDasharray={isSel ? undefined : t.dash} strokeWidth={isSel ? 2.5 : 1.5} />
                  <text x={p.x + 10} y={p.y + 18} fill="var(--color-ink)" fontSize="12" fontWeight="600">
                    {clip(n.label, 26)}
                  </text>
                  <text x={p.x + 10} y={p.y + 35} fill="var(--color-muted)" fontSize="10.5">
                    {clip(`${n.type} · ${n.outcome}`, 30)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <aside aria-live="polite" aria-label="Selected record" data-testid="graph-evidence" className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{selected.type}</p>
          <h4 className="text-base font-semibold text-ink">{selected.label}</h4>
          <dl className="space-y-1">
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted">Record</dt>
              <dd className="break-all text-ink-soft">
                <code>
                  {selected.record.source}: {selected.record.id}
                </code>
              </dd>
            </div>
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted">Outcome</dt>
              <dd className="text-ink">{selected.outcome}</dd>
            </div>
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted">Timestamp</dt>
              <dd className="text-ink-soft">{fmt(selected.timestamp)}</dd>
            </div>
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted">Identifier</dt>
              <dd className="break-all text-ink-soft">
                <code>{selected.identifier}</code>
              </dd>
            </div>
          </dl>
          <p className="text-ink-soft">{selected.explanation}</p>
          <ul className="space-y-0.5 text-xs text-muted" aria-label="Connections">
            {graph.edges
              .filter((e) => e.from === selected.id || e.to === selected.id)
              .map((e) => {
                const other = byId.get(e.from === selected.id ? e.to : e.from) as GraphNode;
                return (
                  <li key={`${e.from}>${e.to}`}>
                    {e.from === selected.id ? "→" : "←"} {e.label}:{" "}
                    <button type="button" onClick={() => setSelectedId(other.id)} className="text-accent underline underline-offset-2">
                      {other.label}
                    </button>
                  </li>
                );
              })}
          </ul>
        </aside>
      </div>

      <section aria-label="Memory query" data-testid="memory-query" className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Query the recorded memory</p>
        <h4 className="text-base font-semibold text-ink">{query.question}</h4>
        <p className="text-ink-soft">
          {query.pair}:{" "}
          <span data-testid="memory-query-answer" className={`font-semibold ${query.answer === "yes" ? "text-blocked" : "text-accent"}`}>
            {query.answer === "yes" ? "Yes" : "No"}
          </span>
          {query.answer === "yes" && ` — ${query.rejections.length} recorded human rejection${query.rejections.length === 1 ? "" : "s"}.`}
        </p>
        <ol className="space-y-3">
          {query.rejections.map((r) => (
            <li key={r.version} data-testid={`memory-rejection-v${r.version}`} className="border-l-2 border-blocked pl-3">
              <button type="button" onClick={() => setSelectedId(`review:still-v${r.version}`)} className="font-semibold text-ink underline underline-offset-2">
                Edited still V{r.version}: rejected
              </button>
              <span className="text-muted"> · {fmt(r.reviewedAt)}</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-soft">
                {r.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              {r.informedPlans.length > 0 && <p className="mt-1 text-xs text-muted">Cited by the recorded revision note of {r.informedPlans.join(" and ")}.</p>}
            </li>
          ))}
        </ol>
        <div className="space-y-2 border-t border-line pt-3" data-testid="memory-informed-v3">
          <p className="font-semibold text-ink">How these rejections shaped Plan V3</p>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">
            {v3.notes.map((n) => (
              <li key={n.plan}>
                <span className="text-ink">{n.plan}:</span> {n.note}
              </li>
            ))}
            <li>
              <span className="text-ink">Plan V3 placement mode:</span> {v3.mode}
              {v3.addedObjects !== null && `, ${v3.addedObjects} objects added`}.
            </li>
          </ul>
          <details>
            <summary className="cursor-pointer text-ink">Plan V3 constraints ({v3.constraints.length})</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-soft">
              {v3.constraints.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        </div>
      </section>
      <p className="text-xs text-muted">{MEMORY_NOTE}</p>
    </div>
  );
}
