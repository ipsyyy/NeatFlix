import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALEPH_EDIT_PROMPT, estimateAlephCost, preflightProblems } from "@/agents/media/runway-aleph";

const sum = `sha256:${"a".repeat(64)}`;
describe("Runway Aleph full-scene edit", () => {
  it("prices the registered source under the hard ceiling", () => {
    assert.deepEqual(estimateAlephCost(20.064), { credits: 562, usd: 5.62 });
    assert.deepEqual(preflightProblems({ durationSeconds: 20.064, sourceChecksum: sum, referenceChecksum: sum }), []);
  });
  it("fails closed for an overlong or over-budget source", () => {
    assert.ok(preflightProblems({ durationSeconds: 31, sourceChecksum: sum, referenceChecksum: sum }).length >= 2);
  });
  it("constrains the edit and preserves the original production", () => {
    assert.match(ALEPH_EDIT_PROMPT, /two existing brown takeaway coffee cups/);
    assert.match(ALEPH_EDIT_PROMPT, /Preserve the exact original video duration/);
    assert.match(ALEPH_EDIT_PROMPT, /Do not add, remove, duplicate or move any cup/);
  });
});
