import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateHandoff } from "@/agents/handoff/envelope";
import {
  canConsume,
  canRelease,
  extractHandoffs,
  formatHandoffBlock,
  validateOutgoing,
  type HumanApproval,
} from "@/agents/handoff/protocol";
import { screenIncomingMessage } from "@/agents/runtime/handoff-gate";
import { curatorApproval, governorHandoff } from "./fixtures";

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
  const approval: HumanApproval = {
    caseId: "NF-DEMO-0001",
    artifactId: "placement:hh-scene-1:v1",
    approved: true,
    approverName: "Demo reviewer",
    approvedAt: "2026-10-14T12:30:00Z",
  };

  it("has no governor decision that means release", () => {
    assert.equal(validateHandoff(governorHandoff({ decision: "release" as never })).ok, false);
    assert.equal(validateHandoff(governorHandoff({ decision: "approve" as never })).ok, false);
  });

  it("cannot release on the governor's approval alone", () => {
    const result = canRelease(governorHandoff(), null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.includes("Explicit human approval is required before release."));
  });

  it("releases only with matching explicit human approval", () => {
    assert.equal(canRelease(governorHandoff(), approval).ok, true);
    assert.equal(canRelease(governorHandoff(), { ...approval, artifactId: "placement:other" }).ok, false);
    assert.equal(canRelease(governorHandoff(), { ...approval, approverName: " " }).ok, false);
  });

  it("never releases after revise or stop, even with human approval", () => {
    const stop = governorHandoff({ decision: "stop", blockers: ["Brand-safety veto"] });
    const revise = governorHandoff({ decision: "revise", recipientRole: "placement-director", blockers: ["Fix lighting"] });
    assert.equal(canRelease(stop, approval).ok, false);
    assert.equal(canRelease(revise, approval).ok, false);
  });

  it("cannot treat another role's handoff as a release decision", () => {
    assert.equal(canRelease(curatorApproval({ caseId: approval.caseId }), approval).ok, false);
  });
});
