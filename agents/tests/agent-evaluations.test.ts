import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { EVALUATION_METHOD, evaluateAgents, type AgentFacts } from "@/agents/observability/agent-evaluations";
import { HHH_DIMENSIONS, validateDemoSnapshot } from "@/lib/demo/snapshot";

const PERSONAS: Record<AgentRole, { name: string; title: string }> = {
  "content-curator": { name: "Iris Vale", title: "Content Curator" },
  "scene-scout": { name: "Theo Park", title: "Scene Scout" },
  "campaign-matcher": { name: "Ana Reyes", title: "Campaign Matcher" },
  "placement-director": { name: "Jun Sato", title: "Placement Director" },
  "release-governor": { name: "Ada Sterling", title: "Release Governor" },
};

/** The recorded facts of case NF-DEMO-0001, as the snapshot builder gathers them. */
function facts(over: Partial<AgentFacts> = {}): AgentFacts {
  return {
    runs: [
      { id: "r0", name: "NativeFrame case NF-DEMO-0001", role: null, outcome: "approved" },
      { id: "r1", name: "Content Curator: title eligibility", role: "content-curator", outcome: "approve" },
      { id: "r2", name: "Scene Scout: scene selection", role: "scene-scout", outcome: "select" },
      { id: "r3", name: "Campaign Matcher: campaign match", role: "campaign-matcher", outcome: "recommended" },
      { id: "r4", name: "Placement Director: plan v1", role: "placement-director", outcome: "instructions-ready" },
      { id: "r5", name: "Placement Director: plan v2", role: "placement-director", outcome: "instructions-ready" },
      { id: "r6", name: "Placement Director: plan v3", role: "placement-director", outcome: "instructions-ready" },
      { id: "r7", name: "Human visual review: approved", role: null, outcome: "approved" },
      { id: "r8", name: "Release Governor: approve-for-human-review", role: "release-governor", outcome: "approve-for-human-review" },
    ],
    scores: { hhh_helpful: 1, hhh_honest: 1, hhh_harmless: 1, governor_checks_pass_rate: 1, release_gate_respected: 1, revision_loop_completed: 1, preview_human_visual_approval: 1, prompt_label_currency: 0 },
    personas: PERSONAS,
    runLink: (id) => `trace#${id}`,
    curator: { caseTitleId: "luv-hypothesis", titleId: "luv-hypothesis", rightsStatus: "cleared", rating: "TV-PG", sensitivity: "standard", eligibleNow: true, placementReviewAllowed: true },
    scout: { sceneId: "luv-scene-1", planSceneId: "luv-scene-1", checks: [{ id: "face-framing", outcome: "pass" }, { id: "actor-restrictions", outcome: "pass" }], sourceFrameRegistered: true },
    matcher: { campaignId: "daybreak-cold-brew", planCampaignId: "daybreak-cold-brew", decisionNow: "recommended", audience: [{ label: "Minor exclusion", outcome: "pass" }], safety: [{ outcome: "pass" }] },
    director: { planVersions: 3, finalPlanHashMatches: true, disclosureDerived: true, negativeConstraints: 6, stillDecisions: [{ version: 1, decision: "rejected" }, { version: 2, decision: "rejected" }, { version: 3, decision: "approved" }], sourceFrameRegistered: true },
    governor: { decision: "approve-for-human-review", blockers: 0, reviewRuleErrors: 0 },
    ...over,
  };
}
const row = (rows: ReturnType<typeof evaluateAgents>, role: AgentRole) => rows.find((r) => r.role === role)!;
const outcomes = (r: ReturnType<typeof evaluateAgents>[number]) => [r.helpful.outcome, r.honest.outcome, r.harmless.outcome, r.groundedness.outcome];

describe("per-agent HHH and Groundedness", () => {
  it("evaluates exactly the five BAND agents, in order, with their trace runs and links", () => {
    const rows = evaluateAgents(facts());
    assert.deepEqual(rows.map((r) => r.role), [...AGENT_ROLES]);
    assert.deepEqual(rows.map((r) => r.name), ["Iris Vale", "Theo Park", "Ana Reyes", "Jun Sato", "Ada Sterling"]);
    assert.deepEqual(row(rows, "placement-director").runs.map((r) => r.name), ["Placement Director: plan v1", "Placement Director: plan v2", "Placement Director: plan v3"]);
    assert.deepEqual(row(rows, "release-governor").runs, [{ id: "r8", name: "Release Governor: approve-for-human-review", link: "trace#r8" }]);
    assert.ok(rows.every((r) => !r.runs.some((x) => x.name.startsWith("Human"))), "human-owner runs are not attributed to an agent");
  });

  it("derives the recorded case: four agents pass everything; the Governor fails Honest on stale prompt labels", () => {
    const rows = evaluateAgents(facts());
    for (const role of ["content-curator", "scene-scout", "campaign-matcher", "placement-director"] as const) assert.deepEqual(outcomes(row(rows, role)), ["pass", "pass", "pass", "pass"], role);
    const g = row(rows, "release-governor");
    assert.deepEqual(outcomes(g), ["pass", "fail", "pass", "pass"]);
    assert.match(g.honest.basis, /not-executed/);
    assert.match(g.honest.basis, /hhh_honest score of 1 is preserved/);
    assert.ok(g.honest.sources.includes("LangSmith prompt_label_currency = 0"));
    assert.equal(evaluateAgents(facts({ scores: { ...facts().scores, prompt_label_currency: 1 } }))[4].honest.outcome, "pass");
  });

  it("keeps Groundedness separate from the three HHH dimensions", () => {
    assert.deepEqual([...HHH_DIMENSIONS], ["helpful", "honest", "harmless"]);
    const rows = evaluateAgents(facts({ director: { ...facts().director, finalPlanHashMatches: false } }));
    const d = row(rows, "placement-director");
    assert.equal(d.groundedness.outcome, "fail");
    assert.equal(d.harmless.outcome, "pass", "a grounding failure does not change Harmless");
  });

  it("fails the dimension whose evidence fails, and never scores an agent without a run", () => {
    const failing = evaluateAgents(facts({ scout: { ...facts().scout, checks: [{ id: "face-framing", outcome: "fail" }] } }));
    assert.equal(row(failing, "scene-scout").harmless.outcome, "fail");
    assert.match(row(failing, "scene-scout").harmless.basis, /face-framing/);
    assert.equal(row(evaluateAgents(facts({ matcher: { ...facts().matcher, decisionNow: "not-recommended" } })), "campaign-matcher").groundedness.outcome, "fail");
    assert.equal(row(evaluateAgents(facts({ scores: { ...facts().scores, release_gate_respected: 0 } })), "release-governor").harmless.outcome, "fail");
    const missing = evaluateAgents(facts({ runs: facts().runs.filter((r) => r.role !== "scene-scout") }));
    assert.deepEqual(outcomes(row(missing, "scene-scout")), ["not-evaluated", "not-evaluated", "not-evaluated", "not-evaluated"]);
    assert.equal(row(missing, "scene-scout").helpful.sources.length, 0);
  });

  it("states that the evaluation is rule-based and that no LLM judge ran", () => {
    assert.match(EVALUATION_METHOD, /rule-based/i);
    assert.match(EVALUATION_METHOD, /No LLM judge ran/);
    const snap = (a: unknown) => validateDemoSnapshot({ version: 1, agents: Array(5).fill({}), case: {}, plan: {}, preview: {}, governor: {}, approval: {}, masky: {}, langsmith: {}, media: [], agentEvaluations: a });
    const rows = evaluateAgents(facts());
    assert.deepEqual(snap({ method: EVALUATION_METHOD, runLinks: "per-run", rows }), []);
    assert.ok(snap({ method: "LLM-judged scores", runLinks: "per-run", rows }).length > 0);
    assert.ok(snap({ method: EVALUATION_METHOD, runLinks: "per-run", rows: rows.slice(0, 4) }).length > 0);
  });
});
