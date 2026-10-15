import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateHandoff } from "@/agents/handoff/envelope";
import { canRelease, recordHumanApproval, type HumanApproval } from "@/agents/handoff/human-approval";
import { canConsume, extractHandoffs, formatHandoffBlock, validateOutgoing } from "@/agents/handoff/protocol";
import { screenIncomingMessage } from "@/agents/runtime/handoff-gate";
import { curatorApproval, FUTURE_PREVIEWS, governorHandoff } from "./fixtures";

describe("handoff validation", () => {
  it("accepts a complete, consistent envelope", () => {
    assert.equal(validateHandoff(curatorApproval()).ok, true);
  });

  it("rejects missing evidence, bad confidence, bad timestamp, and unknown fields", () => {
    const result = validateHandoff({
      ...curatorApproval(),
      evidence: [],
      confidence: 1.4,
      timestamp: "yesterday",
      apiKey: "x",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("evidence")));
      assert.ok(result.errors.some((e) => e.includes("confidence")));
      assert.ok(result.errors.some((e) => e.includes("timestamp")));
      assert.ok(result.errors.some((e) => e.includes("Unknown field: apiKey")));
    }
  });

  it("rejects a decision that does not belong to the sender's role", () => {
    const result = validateHandoff(curatorApproval({ decision: "recommend" }));
    assert.equal(result.ok, false);
  });

  it("requires blockers for rejections and forbids them for approvals", () => {
    assert.equal(validateHandoff(curatorApproval({ blockers: ["Rights unclear"] })).ok, false);
    assert.equal(
      validateHandoff(curatorApproval({ decision: "reject", recipientRole: "human-reviewer" })).ok,
      false,
    );
    assert.equal(
      validateHandoff(
        curatorApproval({ decision: "reject", recipientRole: "human-reviewer", blockers: ["Rights unclear"] }),
      ).ok,
      true,
    );
  });

  it("round-trips through a BAND message block and reports malformed JSON", () => {
    const content = `@Scene Scout here is my decision.\n\n${formatHandoffBlock(curatorApproval())}`;
    const [block] = extractHandoffs(content);
    assert.equal(block.ok, true);
    assert.deepEqual(extractHandoffs("```nativeframe-handoff\n{not json}\n```"), [
      { ok: false, error: "Handoff block is not valid JSON." },
    ]);
  });
});

describe("role-order enforcement", () => {
  it("routes each decision to its only valid recipient", () => {
    assert.equal(validateOutgoing(curatorApproval()).ok, true);
    assert.equal(validateOutgoing(curatorApproval({ recipientRole: "campaign-matcher" })).ok, false);
    assert.equal(
      validateOutgoing(
        curatorApproval({ decision: "reject", recipientRole: "scene-scout", blockers: ["Sensitive content"] }),
      ).ok,
      false,
      "a rejection cannot be forwarded to the next specialist",
    );
  });

  it("lets Scene Scout consume only an approved Content Curator handoff", () => {
    assert.equal(canConsume("scene-scout", curatorApproval(), "content-curator").ok, true);
    assert.equal(canConsume("campaign-matcher", curatorApproval(), "content-curator").ok, false);
  });

  it("stops downstream agents from skipping a step", () => {
    const skipped = curatorApproval({ recipientRole: "placement-director" });
    assert.equal(canConsume("placement-director", skipped, "content-curator").ok, false);
  });

  it("rejects a handoff whose claimed sender role is not the real sender", () => {
    const spoofed = canConsume("scene-scout", curatorApproval(), "campaign-matcher");
    assert.equal(spoofed.ok, false);
    assert.equal(canConsume("scene-scout", curatorApproval(), null).ok, false);
  });

  it("allows the governor's revise loop back to the Placement Director only", () => {
    const revise = governorHandoff({
      decision: "revise",
      recipientRole: "placement-director",
      blockers: ["Cup scale too large for the desk"],
    });
    assert.equal(canConsume("placement-director", revise, "release-governor").ok, true);
    assert.equal(validateOutgoing({ ...revise, recipientRole: "campaign-matcher" }).ok, false);
  });

  it("screens BAND messages before an agent can consume them", () => {
    const valid = formatHandoffBlock(curatorApproval());
    const curatorAgent = { role: "content-curator", type: "Agent" } as const;
    assert.equal(screenIncomingMessage("scene-scout", valid, curatorAgent).consume, true);
    assert.equal(screenIncomingMessage("scene-scout", valid, { role: "release-governor", type: "Agent" }).consume, false);
    assert.equal(screenIncomingMessage("scene-scout", "just chatting", curatorAgent).consume, false);
    assert.deepEqual(screenIncomingMessage("content-curator", "Please review title X", { role: null, type: "User" }), {
      consume: true,
    });
  });
});

describe("Release Governor human-approval requirement", () => {
  const options = { previews: FUTURE_PREVIEWS };
  const owner = { id: "owner-user", type: "User", role: null };
  const approve = (handoff = governorHandoff()) => {
    const r = recordHumanApproval({ sender: owner, ownerUserId: owner.id, approverName: "Demo reviewer", governorHandoff: handoff, previews: FUTURE_PREVIEWS });
    assert.equal(r.ok, true, r.ok ? "" : r.errors.join(" "));
    return (r as { ok: true; value: HumanApproval }).value;
  };

  it("has no governor decision that means release", () => {
    assert.equal(validateHandoff(governorHandoff({ decision: "release" as never })).ok, false);
    assert.equal(validateHandoff(governorHandoff({ decision: "approve" as never })).ok, false);
  });

  it("cannot release on the governor's approval alone", () => {
    const result = canRelease(governorHandoff(), null, options);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.includes("Explicit human approval is required before release."));
  });

  it("releases only with matching, recorded human approval", () => {
    const approval = approve();
    assert.equal(canRelease(governorHandoff(), approval, options).ok, true);
    const other = governorHandoff({ caseId: "NF-DEMO-0002", artifact: { ...governorHandoff().artifact!, caseId: "NF-DEMO-0002" } as never });
    assert.equal(canRelease(other, approval, options).ok, false);
  });

  it("never releases after revise or stop, even with human approval", () => {
    const approval = approve();
    assert.equal(canRelease(governorHandoff({ decision: "stop" }), approval, options).ok, false);
    assert.equal(canRelease(governorHandoff({ decision: "revise" }), approval, options).ok, false);
  });

  it("cannot treat another role's handoff as a release decision", () => {
    assert.equal(canRelease(curatorApproval(), approve(), options).ok, false);
  });
});
