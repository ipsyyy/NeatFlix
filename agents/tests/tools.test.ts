import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_ROLES } from "@/agents/config/roles";
import { buildSystemPrompt } from "@/agents/runtime/prompts";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { curatorApproval } from "./fixtures";

function tool(role: Parameters<typeof toolsForRole>[0], name: string) {
  const found = toolsForRole(role).find((t) => t.name === name);
  assert.ok(found, `${role} should have ${name}`);
  return found;
}

describe("evidence tools", () => {
  it("gives each role only the evidence for its own step", () => {
    assert.deepEqual(toolsForRole("content-curator").map((t) => t.name).sort(), [
      "nativeframe_get_title_record",
      "nativeframe_validate_handoff",
    ]);
    assert.deepEqual(toolsForRole("scene-scout").map((t) => t.name).sort(), [
      "nativeframe_get_scene_candidates",
      "nativeframe_validate_handoff",
    ]);
  });

  it("returns The LUV Hypothesis catalogue record with its eligibility", async () => {
    const result = (await tool("content-curator", "nativeframe_get_title_record").handler({ title: "The LUV Hypothesis" })) as {
      found: boolean;
      record: { id: string; rightsStatus: string; pipelineEnabled: boolean };
      eligibility: { eligible: boolean; placementReviewAllowed: boolean };
      source: string;
    };
    assert.equal(result.found, true);
    assert.equal(result.record.id, "luv-hypothesis");
    assert.equal(result.record.rightsStatus, "cleared");
    assert.equal(result.eligibility.placementReviewAllowed, true);
    assert.match(result.source, /Demo fixture/);
  });

  it("reports sensitive titles as ineligible with the recorded reason", async () => {
    const result = (await tool("content-curator", "nativeframe_get_title_record").handler({ title: "squid-gamed" })) as {
      eligibility: { eligible: boolean; reasons: string[] };
    };
    assert.equal(result.eligibility.eligible, false);
    assert.ok(result.eligibility.reasons.some((r) => /brand-safety/i.test(r)));
  });

  it("returns the recorded scene candidates, including the Lab desk discussion", async () => {
    const result = (await tool("scene-scout", "nativeframe_get_scene_candidates").handler({ titleId: "luv-hypothesis" })) as {
      found: boolean;
      scenes: { id: string; name: string; startSeconds: number; endSeconds: number }[];
    };
    const lab = result.scenes.find((s) => s.id === "luv-scene-1");
    assert.equal(result.found, true);
    assert.deepEqual(lab && { name: lab.name, start: lab.startSeconds, end: lab.endSeconds }, {
      name: "Lab desk discussion",
      start: 42,
      end: 47,
    });
  });

  it("validates envelopes before sending", async () => {
    const validate = tool("content-curator", "nativeframe_validate_handoff");
    assert.equal(((await validate.handler({ handoffJson: JSON.stringify(curatorApproval()) })) as { ok: boolean }).ok, true);
    const bad = (await validate.handler({ handoffJson: JSON.stringify({ ...curatorApproval(), recipientRole: "campaign-matcher" }) })) as {
      ok: boolean;
    };
    assert.equal(bad.ok, false);
    assert.deepEqual(await validate.handler({ handoffJson: "{oops" }), { ok: false, errors: ["handoffJson is not valid JSON."] });
  });
});

describe("role prompts", () => {
  it("drop BAND's recruit-peers and public-thought instructions", () => {
    for (const role of AGENT_ROLES) {
      const prompt = buildSystemPrompt(role);
      assert.ok(!prompt.includes("band_lookup_peers()"), role);
      assert.ok(!prompt.includes('message_type="thought"'), role);
      assert.ok(prompt.includes("Do not add, remove, or recruit participants"), role);
    }
  });
});
