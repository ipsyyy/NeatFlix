import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildDecisionGraph, GRAPH_LABEL, MEMORY_NOTE, NODE_TYPES, priorRejections, revisionCites, type GraphNode } from "@/lib/demo/decision-graph";
import type { DemoSnapshot } from "@/lib/demo/snapshot";

/** The verified snapshot built from the stored records by npm run demo:snapshot (git-ignored). */
const FILE = join(process.cwd(), ".demo", "snapshot.json");
const snapshot = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as DemoSnapshot) : null;
const skip = snapshot?.memory ? false : "no .demo snapshot with decision memory: run npm run demo:snapshot";

/** The stored record each node claims, looked up in the snapshot's copies of the registry. */
function recordExists(s: DemoSnapshot, n: GraphNode): boolean {
  const { source, id } = n.record;
  const assets = [...s.revisions.map((r) => r.assetId), s.preview.assetId, ...(s.fullScene ? [s.fullScene.assetId] : [])];
  switch (source) {
    case "cases":
      return id === s.case.caseId;
    case "catalogue-fixture":
      return [s.case.titleId, s.case.sceneId, s.case.campaignId].includes(id);
    case "band-agent":
      return s.agents.some((a) => a.role === id);
    case "placement_plans":
      return Boolean(s.memory?.plans.some((p) => p.planId === id));
    case "media_assets":
      return assets.includes(id) || (id === "source-frame" && s.media.some((m) => m.key === "source-frame" && m.verified));
    case "media_visual_reviews":
      return (
        s.revisions.some((r) => r.assetId === id && r.decision !== "pending") ||
        (id === s.preview.assetId && s.preview.decision !== "pending") ||
        (id === s.fullScene?.assetId && Boolean(s.fullScene.reviewedAt))
      );
    case "governor_reviews":
      return id === s.governor.reviewId;
    case "human_approvals":
      return id === s.approval.approvalId;
    case "langsmith-trace":
      return id === s.langsmith.traceId;
    case "langsmith-evaluation":
      return s.langsmith.evaluations.some((e) => e.key === id);
  }
}

describe("decision memory graph (verified snapshot)", { skip }, () => {
  const s = snapshot!;
  const g = skip ? { nodes: [], edges: [] } : buildDecisionGraph(s);
  const label = (l: string) => g.nodes.find((n) => n.label === l);

  it("maps every node to a real stored record, and every edge to two nodes", () => {
    for (const n of g.nodes) assert.ok(recordExists(s, n), `${n.id} → ${n.record.source}:${n.record.id}`);
    const ids = new Set(g.nodes.map((n) => n.id));
    assert.equal(ids.size, g.nodes.length, "node ids are unique");
    for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} → ${e.to}`);
    assert.deepEqual(buildDecisionGraph(s), g, "deterministic");
  });

  it("contains every required node type and real node", () => {
    assert.deepEqual([...new Set(g.nodes.map((n) => n.type))].sort(), [...NODE_TYPES].sort());
    for (const l of [
      "NF-DEMO-0001",
      "The LUV Hypothesis",
      "Café table conversation",
      "Daybreak Cold Brew",
      "Content Curator — Iris Vale",
      "Scene Scout — Theo Park",
      "Campaign Matcher — Ana Reyes",
      "Placement Director — Jun Sato",
      "Release Governor — Ada Sterling",
      "Plan V1",
      "Plan V2",
      "Plan V3",
      "Edited still V1 rejected",
      "Edited still V2 rejected",
      "Edited still V3 approved",
      "V3 fallback preview",
      "Runway V4 full-scene video",
      "V4 approved-with-limitation",
      "Release Governor decision",
      "Final human approval",
      "LangSmith case trace",
      "prompt_label_currency = 0",
      "Minor temporal typography instability",
    ]) assert.ok(label(l), l);
    assert.equal(label("Minor temporal typography instability")!.explanation, "Fine generated cup lettering shows minor temporal instability during motion.");
    assert.match(label("prompt_label_currency = 0")!.explanation, /stale "not-executed" prompt labels/);
    assert.deepEqual([label("Edited still V1 rejected")!.tone, label("Edited still V3 approved")!.tone, label("Minor temporal typography instability")!.tone, label("Plan V1")!.tone], ["rejected", "approved", "limitation", "context"]);
    assert.equal(label("Scene Scout — Theo Park")!.tone, "agent");
    assert.equal(label("LangSmith case trace")!.tone, "evidence");
  });

  it("answers the product-scene query with V1 and V2 and their real rejection reasons", () => {
    const q = priorRejections(s, "daybreak-cold-brew", "luv-scene-1");
    assert.equal(q.answer, "yes");
    assert.deepEqual(q.rejections.map((r) => r.version), [1, 2]);
    for (const r of q.rejections) assert.deepEqual(r.reasons, s.revisions.find((x) => x.version === r.version)!.reasons);
    assert.match(q.rejections[0].reasons.join(" "), /forearm/);
    assert.match(q.rejections[1].reasons.join(" "), /mouth and expression/);
    assert.deepEqual(q.rejections.map((r) => r.informedPlans), [["Plan V2", "Plan V3"], ["Plan V3"]]);
    assert.equal(priorRejections(s, "daybreak-cold-brew", "some-other-scene").answer, "no");
  });

  it("shows how the V1 and V2 failures informed V3", () => {
    const informed = g.edges.filter((e) => e.label === "informed").map((e) => `${e.from}>${e.to}`);
    assert.deepEqual(informed.sort(), ["review:still-v1>plan:v2", "review:still-v1>plan:v3", "review:still-v2>plan:v3"]);
    const v3 = s.memory!.plans.find((p) => p.version === 3)!;
    assert.equal(v3.mode, "rebrand-existing-cups");
    assert.equal(v3.addedObjects, 0);
  });

  it("carries no private path, credential, signed URL, or person identifier", () => {
    const text = JSON.stringify(g);
    assert.doesNotMatch(text, /storage:\/\/|nf-media\/|sb_secret|sb_publishable|lsv2_|mky_|sk-ant-|AIza|token=|\/object\/sign\/|https?:\/\//i);
    assert.doesNotMatch(text, /reviewer|owner_uuid|user_id/i);
    for (const n of g.nodes) assert.ok(n.identifier.length > 0 && !/\s/.test(n.identifier.replace("…", "")), n.id);
  });
});

describe("decision memory rules", () => {
  it("cites a rejection only when the recorded revision note names it", () => {
    const v1 = { version: 1, assetId: "asset:t:edited-still:s:v1" };
    const v2 = { version: 2, assetId: "asset:t:edited-still:s:v2" };
    assert.ok(revisionCites("Revision after the human visual rejection of asset:t:edited-still:s:v1: …", v1));
    assert.ok(revisionCites("… Edited stills v1 and v2 were rejected in human visual review.", v2));
    assert.ok(!revisionCites("… Edited stills v1 and v2 were rejected.", { version: 3, assetId: "x" }));
    assert.ok(!revisionCites("Edited still v12 was rejected.", v1));
    assert.ok(!revisionCites(null, v1));
  });

  it("labels the graph as read-only recorded memory, never as learning", () => {
    assert.equal(GRAPH_LABEL, "Recorded decision memory — read-only.");
    assert.match(MEMORY_NOTE, /future snapshot/);
    assert.doesNotMatch(`${GRAPH_LABEL} ${MEMORY_NOTE}`, /autonomous|live learning|learns from/i);
  });
});
