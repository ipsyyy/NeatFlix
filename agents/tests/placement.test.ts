import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HistoryProvider } from "@band-ai/sdk/runtime";
import type { Logger } from "@band-ai/sdk/core";
import { buildRedelivery } from "@/agents/band/redeliver";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { validateHandoff } from "@/agents/handoff/envelope";
import { RELEASE_GOVERNOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE, validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { formatHandoffBlock } from "@/agents/handoff/protocol";
import { stampOutgoingContent, validateDraft } from "@/agents/handoff/stamp";
import { HandoffGate, screenIncomingMessage } from "@/agents/runtime/handoff-gate";
import { withHandoffStamping } from "@/agents/runtime/stamping-adapter";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { curatorApproval, validPlacementPlan } from "./fixtures";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Placement Director → Release Governor handoff carrying a plan. */
function pdHandoff(plan: unknown = validPlacementPlan(), over: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return curatorApproval({
    senderRole: "placement-director",
    recipientRole: "release-governor",
    decision: "instructions-ready",
    artifactId: "plan:daybreak-cold-brew:hh-scene-1:v1",
    evidence: [
      { claim: "Daybreak Cold Brew was recommended for hh-scene-1.", source: "handoff.decision" },
      { claim: "The lab desk is clear and in frame.", source: "nativeframe_get_selected_scene.scene.surface" },
    ],
    nextAction: "Review the placement plan before any generation step.",
    artifact: plan as PlacementPlan,
    ...over,
  });
}

const readable =
  `@ipchoudhury Placement plan for Daybreak Cold Brew on the visible lab desk in hh-scene-1 (00:42–00:47). ` +
  `Both generation prompts have not been executed. ${STAND_IN_DISCLOSURE} ${RELEASE_GOVERNOR_DISCLOSURE}`;
const message = (env: HandoffEnvelope, text = readable) => `${text}\n\n${formatHandoffBlock(env)}`;
const plan = (over: Partial<PlacementPlan>) => validPlacementPlan(over);
const base = validPlacementPlan();

describe("placement plan: valid plan", () => {
  it("accepts a complete plan with a cited, disclosed result", () => {
    assert.deepEqual(validatePlacementPlan(base, "NF-DEMO-0001"), []);
    assert.equal(validateHandoff(pdHandoff()).ok, true);
    assert.deepEqual(validateResult(pdHandoff(), readable), []);
    assert.equal(stampOutgoingContent(message(pdHandoff())).ok, true);
  });

  it("is accepted by Release Governor only from the authenticated Placement Director", () => {
    const content = message(pdHandoff());
    assert.equal(screenIncomingMessage("release-governor", content, { role: "placement-director", type: "Agent" }).consume, true);
    assert.equal(screenIncomingMessage("release-governor", content, { role: "campaign-matcher", type: "Agent" }).consume, false);
  });
});

describe("placement plan: rejections", () => {
  it("rejects the wrong surface", () => {
    assert.ok(validatePlacementPlan(plan({ placement: { ...base.placement, region: "café table" } })).some((e) => /region/.test(e)));
    assert.ok(validatePlacementPlan(plan({ scene: { ...base.scene, sceneId: "hh-scene-2", name: "Campus café conversation", startSeconds: 78, endSeconds: 83 } })).some((e) => /lab desk/.test(e)));
  });

  it("rejects hand interaction", () => {
    assert.ok(validatePlacementPlan(plan({ placement: { ...base.placement, handInteraction: "light" as never } })).length > 0);
    const holding = plan({ prompts: { ...base.prompts, stillImageEdit: { ...base.prompts.stillImageEdit, prompt: "The researcher is holding the Daybreak cup on the desk. No hand interaction." } } });
    assert.ok(validatePlacementPlan(holding).some((e) => /Hand interaction/.test(e)));
    const noStatement = plan({ prompts: { ...base.prompts, motion: { ...base.prompts.motion, prompt: "Keep the cup stationary for 5 seconds." } } });
    assert.ok(validatePlacementPlan(noStatement).some((e) => /no hand interaction/.test(e)));
  });

  it("rejects face obstruction", () => {
    const blocking = plan({ placement: { ...base.placement, description: "Place the cup in front of the woman's face so it reads clearly." } });
    assert.ok(validatePlacementPlan(blocking).some((e) => /Face obstruction/.test(e)));
  });

  it("rejects missing preservation constraints", () => {
    for (const key of ["faces", "bodies", "background", "composition"] as const) {
      const missing = plan({ preservation: { ...base.preservation, [key]: [] } });
      assert.ok(validatePlacementPlan(missing).some((e) => e.includes(`preservation.${key}`)), key);
    }
  });

  it("rejects missing or incomplete negative constraints", () => {
    assert.ok(validatePlacementPlan(plan({ negativeConstraints: [] })).some((e) => /negativeConstraints/.test(e)));
    assert.ok(validatePlacementPlan(plan({ negativeConstraints: ["No camera movement."] })).some((e) => /hand interaction/.test(e)));
  });

  it("rejects missing evidence in the plan and the handoff", () => {
    assert.ok(validatePlacementPlan(plan({ evidence: [] })).some((e) => /evidence/.test(e)));
    assert.equal(validateHandoff(pdHandoff(base, { evidence: [] })).ok, false);
  });

  it("rejects unsupported durations", () => {
    for (const durationSeconds of [2, 6, 10]) {
      const bad = plan({ prompts: { ...base.prompts, motion: { ...base.prompts.motion, durationSeconds } } });
      assert.ok(validatePlacementPlan(bad).some((e) => /durationSeconds/.test(e)), String(durationSeconds));
    }
    const window = plan({ scene: { ...base.scene, startSeconds: 40, endSeconds: 50 } });
    assert.ok(validatePlacementPlan(window).some((e) => /recorded 42–47/.test(e)));
  });

  it("rejects false claims that generation occurred", () => {
    const executed = plan({ prompts: { ...base.prompts, stillImageEdit: { ...base.prompts.stillImageEdit, status: "executed" as never } } });
    assert.ok(validatePlacementPlan(executed).length > 0);
    const claimInPlan = plan({ placement: { ...base.placement, description: "Gemini generated the edited frame with the cup on the desk." } });
    assert.ok(validatePlacementPlan(claimInPlan).some((e) => /must not claim generation/.test(e)));
    const sceneFrame = plan({ sourceMedia: { ...base.sourceMedia, isSceneFrame: true as never } });
    assert.ok(validatePlacementPlan(sceneFrame).some((e) => /sourceMedia/.test(e)));
    assert.ok(validateResult(pdHandoff(), `${readable} Reactor rendered the 5-second preview video.`).some((e) => /No generation has run/.test(e)));
  });

  it("rejects a result missing the downstream-consumption disclosure", () => {
    const text = readable.replace(RELEASE_GOVERNOR_DISCLOSURE, "");
    assert.ok(validateResult(pdHandoff(), text).some((e) => e.includes(RELEASE_GOVERNOR_DISCLOSURE)));
    assert.equal(stampOutgoingContent(message(pdHandoff(), text)).ok, false);
    assert.ok(validateResult(pdHandoff(), readable.replace("have not been executed", "are ready")).some((e) => /not been executed/.test(e)));
  });

  it("rejects the wrong upstream role reaching Placement Director", () => {
    const fromScout = formatHandoffBlock(curatorApproval({ senderRole: "scene-scout", recipientRole: "placement-director", decision: "select", artifactId: "scene:hh-scene-1" }));
    assert.equal(screenIncomingMessage("placement-director", fromScout, { role: "scene-scout", type: "Agent" }).consume, false);
    const matcher = formatHandoffBlock(curatorApproval({ senderRole: "campaign-matcher", recipientRole: "placement-director", decision: "recommend", artifactId: "match:daybreak-cold-brew:hh-scene-1" }));
    assert.equal(screenIncomingMessage("placement-director", matcher, { role: "campaign-matcher", type: "Agent" }).consume, true);
    assert.equal(screenIncomingMessage("placement-director", matcher, { role: "content-curator", type: "Agent" }).consume, false);
    assert.equal(validateHandoff(curatorApproval({ artifact: base })).ok, false, "only Placement Director may carry an artifact");
    const { artifact: _plan, ...withoutPlan } = pdHandoff();
    void _plan;
    assert.equal(validateHandoff(withoutPlan).ok, false, "instructions-ready requires the plan");
  });

  it("rejects room-history contamination and uncited sources", () => {
    const history = pdHandoff(base, { assumptions: ["The Content Curator confirmed rights in an earlier message."] });
    assert.ok(validateResult(history, readable).some((e) => /room history/.test(e)));
    const planHistory = pdHandoff(plan({ evidence: [{ claim: "Rights were cleared in the room history.", source: "handoff.evidence" }] }));
    assert.ok(validateResult(planHistory, readable).some((e) => /artifact.evidence\[0\]/.test(e)));
    const uncited = pdHandoff(plan({ evidence: [{ claim: "The desk is clear.", source: "catalogue.scene" }] }));
    assert.ok(validateResult(uncited, readable).some((e) => /artifact.evidence\[0\].source/.test(e)));
  });

  it("refuses an invalid plan at the agent send boundary without posting it", async () => {
    const posts: string[] = [];
    const tools = { executeToolCall: async (_n: string, a: Record<string, unknown>) => (posts.push(String(a.content)), { ok: true }) };
    const bad = pdHandoff(plan({ placement: { ...base.placement, region: "shelf" } }));
    const res = (await withHandoffStamping(tools, quiet).executeToolCall("band_send_message", { content: message(bad) })) as { ok: boolean };
    assert.equal(res.ok, false);
    assert.deepEqual(posts, []);
  });
});

describe("placement validator: feedback the model can satisfy in one revision", () => {
  const frameErrors = (errors: string[]) => errors.filter((e) => /Do not call the stand-in/.test(e));

  it("allows directly negated frame terms, which the prompt and tools ask for", () => {
    const negated = plan({
      negativeConstraints: [...base.negativeConstraints, "Do not present the title artwork as a scene frame or video frame."],
      assumptions: ["This is not a source frame; no video exists yet."],
    });
    assert.deepEqual(frameErrors(validatePlacementPlan(negated)), []);
    assert.deepEqual(frameErrors(validateResult(pdHandoff(base, { assumptions: ["The visual is not a scene frame."] }), readable)), []);
  });

  it("still rejects affirmative frame terms, including after a negation in another clause", () => {
    const affirmative = plan({ placement: { ...base.placement, description: "Place the cup on the desk in the scene frame." } });
    assert.ok(frameErrors(validatePlacementPlan(affirmative)).length > 0);
    const otherClause = plan({ placement: { ...base.placement, description: "Do not move anyone; set the cup into the source frame." } });
    assert.ok(frameErrors(validatePlacementPlan(otherClause)).length > 0);
    const otherVerb = plan({ assumptions: ["Do not alter the source frame beyond the cup."] });
    assert.ok(frameErrors(validatePlacementPlan(otherVerb)).length > 0, "negating another verb does not excuse the term");
    assert.ok(frameErrors(validateResult(pdHandoff(), `${readable} Nothing else changes in the scene frame.`)).length > 0);
  });

  it("reports plan errors and output-rule errors together, in the draft check and at send", () => {
    const both = pdHandoff(plan({ placement: { ...base.placement, region: "shelf" } }), {
      assumptions: ["The Content Curator confirmed rights in an earlier message."],
    });
    for (const result of [validateDraft(both), stampOutgoingContent(message(both))]) {
      assert.equal(result.ok, false);
      const errors = result.ok ? [] : result.errors;
      assert.ok(errors.some((e) => /region/.test(e)), "plan error");
      assert.ok(errors.some((e) => /room history/.test(e)), "output-rule error");
    }
  });

  it("checks the readable text in nativeframe_validate_handoff when it is passed", async () => {
    const tool = toolsForRole("placement-director").find((t) => t.name === "nativeframe_validate_handoff")!;
    const handoffJson = JSON.stringify(pdHandoff());
    assert.equal(((await tool.handler({ handoffJson })) as { ok: boolean }).ok, true);
    assert.equal(((await tool.handler({ handoffJson, readableText: readable })) as { ok: boolean }).ok, true);
    const missing = (await tool.handler({ handoffJson, readableText: readable.replace(RELEASE_GOVERNOR_DISCLOSURE, "") })) as { ok: boolean; errors?: string[] };
    assert.equal(missing.ok, false);
    assert.ok(missing.errors?.some((e) => e.includes(RELEASE_GOVERNOR_DISCLOSURE)));
  });
});

describe("Placement Director evidence tools and isolation", () => {
  it("gives Placement Director only its approved tools", () => {
    assert.deepEqual(toolsForRole("placement-director").map((t) => t.name).sort(), [
      "nativeframe_get_campaign",
      "nativeframe_get_selected_scene",
      "nativeframe_get_source_artwork",
      "nativeframe_validate_handoff",
    ]);
  });

  it("returns real artwork metadata and says it is a stand-in, not a scene frame", async () => {
    const tool = toolsForRole("placement-director").find((t) => t.name === "nativeframe_get_source_artwork")!;
    const r = (await tool.handler({ titleId: "hate-hypothesis" })) as Record<string, unknown>;
    assert.equal(r.src, "/artwork/the-hate-hypothesis-hero.png");
    assert.equal(r.widthPx, 1672);
    assert.equal(r.heightPx, 941);
    assert.equal(r.isSceneFrame, false);
    assert.match(String(r.note), /stand-in/);
  });

  it("withholds room history when Placement Director accepts a Campaign Matcher handoff", async () => {
    const g = new HandoffGate("placement-director", new Map([["cm-id", "campaign-matcher"]]), quiet);
    const content = formatHandoffBlock(curatorApproval({ senderRole: "campaign-matcher", recipientRole: "placement-director", decision: "recommend", artifactId: "match:daybreak-cold-brew:hh-scene-1" }));
    const input = {
      message: { id: "m", roomId: "r", content, senderId: "cm-id", senderType: "Agent", senderName: null, messageType: "text", metadata: {}, createdAt: new Date() },
      history: new HistoryProvider([{ id: "old", content: "Content Curator said rights are cleared." }]),
    };
    (g as unknown as { inner: { process: () => Promise<unknown> } }).inner = { process: async () => input };
    const result = (await g.process({} as never, {} as never, "self")) as { history: HistoryProvider };
    assert.equal(result.history.length, 0);
  });

  it("re-delivers the Campaign Matcher recommendation with its required disclosure", () => {
    const rec = curatorApproval({
      senderRole: "campaign-matcher",
      recipientRole: "placement-director",
      decision: "recommend",
      artifactId: "match:daybreak-cold-brew:hh-scene-1",
      evidence: [{ claim: "All checks pass.", source: "nativeframe_evaluate_campaign_match.decision" }],
    });
    const r = buildRedelivery({
      originalContent: formatHandoffBlock(rec),
      originalMessageId: "fceebd8f",
      expect: { senderRole: "campaign-matcher", recipientRole: "placement-director", decision: "recommend" },
      recipientMention: "@ipchoudhury/nf-placement-director",
    });
    assert.ok(r.ok);
    assert.match(r.draftContent, /Placement Director has not consumed this handoff yet\./);
    assert.equal(stampOutgoingContent(r.draftContent).ok, true);
  });
});
