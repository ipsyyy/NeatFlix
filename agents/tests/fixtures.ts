import type { HandoffEnvelope } from "@/agents/handoff/envelope";

/** A valid Content Curator → Scene Scout handoff to derive test cases from. */
export function curatorApproval(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    caseId: "NF-DEMO-0001",
    artifactId: "title:hate-hypothesis",
    senderRole: "content-curator",
    recipientRole: "scene-scout",
    decision: "approve",
    evidence: [{ claim: "Rights cleared for placement work", source: "catalogue.rightsStatus" }],
    confidence: 0.9,
    assumptions: [],
    blockers: [],
    nextAction: "Evaluate candidate scenes for The Hate Hypothesis.",
    timestamp: "2026-10-14T12:00:00Z",
    ...overrides,
  };
}

export function governorHandoff(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return curatorApproval({
    artifactId: "placement:hh-scene-1:v1",
    senderRole: "release-governor",
    recipientRole: "human-reviewer",
    decision: "approve-for-human-review",
    nextAction: "Human reviewer to approve or reject release.",
    ...overrides,
  });
}

/** Fake credential-shaped values. Not real secrets. */
export const FAKE_UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
