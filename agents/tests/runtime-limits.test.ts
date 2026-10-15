import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_MAX_TOOL_ROUNDS,
  DEFAULT_TURN_TIMEOUT_MS,
  PLACEMENT_DIRECTOR_TURN_TIMEOUT_MS,
  turnLimitsFor,
} from "@/agents/config/model";
import { AGENT_ROLES } from "@/agents/config/roles";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { RELEASE_GOVERNOR_DISCLOSURE } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { curatorApproval, validPlacementPlan } from "./fixtures";

describe("role-specific turn limits", () => {
  it("gives only Placement Director the 12-minute turn budget", () => {
    assert.equal(PLACEMENT_DIRECTOR_TURN_TIMEOUT_MS, 12 * 60_000);
    assert.equal(turnLimitsFor("placement-director").turnTimeoutMs, PLACEMENT_DIRECTOR_TURN_TIMEOUT_MS);
    for (const role of AGENT_ROLES.filter((r) => r !== "placement-director")) {
      assert.equal(turnLimitsFor(role).turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS, role);
    }
    assert.equal(DEFAULT_TURN_TIMEOUT_MS, 5 * 60_000);
  });

  it("keeps a finite repair-round limit that fits inside the Placement Director budget", () => {
    for (const role of AGENT_ROLES) {
      const { maxToolRounds } = turnLimitsFor(role);
      assert.ok(Number.isInteger(maxToolRounds) && maxToolRounds > 0 && maxToolRounds === AGENT_MAX_TOOL_ROUNDS, role);
    }
    // A full plan draft took up to about 68 s per round in R3; every allowed round must fit.
    assert.ok(PLACEMENT_DIRECTOR_TURN_TIMEOUT_MS >= AGENT_MAX_TOOL_ROUNDS * 75_000);
  });
});

describe("validator reports every problem in one response", () => {
  const tool = toolsForRole("placement-director").find((t) => t.name === "nativeframe_validate_handoff")!;
  const base = validPlacementPlan();
  const envelope = (plan: PlacementPlan, over: Partial<HandoffEnvelope> = {}) =>
    curatorApproval({
      senderRole: "placement-director",
      recipientRole: "release-governor",
      decision: "instructions-ready",
      artifactId: "plan:daybreak-cold-brew:hh-scene-1:v1",
      evidence: [{ claim: "The lab desk is clear.", source: "nativeframe_get_selected_scene.scene.surface" }],
      artifact: plan,
      ...over,
    });
  const goodText = `@ipchoudhury Placement plan ready. Both generation prompts have not been executed. ${STAND_IN_DISCLOSURE} ${RELEASE_GOVERNOR_DISCLOSURE}`;
  const run = async (env: HandoffEnvelope, readableText: string) =>
    (await tool.handler({ handoffJson: JSON.stringify(env), readableText })) as { ok: boolean; errors?: string[] };

  it("returns several simultaneous plan, envelope and readable-text errors together, and one repair clears them", async () => {
    const broken = envelope(
      validPlacementPlan({
        placement: { ...base.placement, region: "shelf" },
        prompts: { ...base.prompts, motion: { ...base.prompts.motion, durationSeconds: 9 } },
        sourceMedia: { ...base.sourceMedia, note: "Title artwork." },
        assumptions: ["Lighting is taken from the source frame."],
      }),
      { evidence: [{ claim: "The desk is clear.", source: "memory" }] },
    );
    const first = await run(broken, "@ipchoudhury Plan ready.");
    assert.equal(first.ok, false);
    const errors = first.errors ?? [];
    const expected = {
      region: /placement\.region/,
      duration: /durationSeconds/,
      note: /sourceMedia\.note/,
      frameTerm: /source frame/,
      citation: /evidence\[0\]\.source/,
      governorDisclosure: new RegExp(RELEASE_GOVERNOR_DISCLOSURE.replace(/\./g, "\\.")),
      standIn: /approved title artwork used as a stand-in/,
      notExecuted: /not been executed/,
    };
    for (const [name, pattern] of Object.entries(expected)) {
      assert.ok(errors.some((e) => pattern.test(e)), `missing ${name} error in the single response`);
    }

    // One repair round fixing everything listed returns ok.
    const repaired = envelope(base);
    assert.deepEqual(await run(repaired, goodText), { ok: true, note: "Timestamp is attached by NativeFrame at send time." });
  });
});
