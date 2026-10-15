import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postWithTrustedTimestamp } from "@/agents/band/post";
import { buildRedelivery } from "@/agents/band/redeliver";
import { PLACEMENT_DIRECTOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { stampOutgoingContent, validateDraft } from "@/agents/handoff/stamp";
import { withHandoffStamping } from "@/agents/runtime/stamping-adapter";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { extractHandoffs, formatHandoffBlock } from "@/agents/handoff/protocol";
import { screenIncomingMessage } from "@/agents/runtime/handoff-gate";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { campaigns } from "@/data/campaigns";
import { catalogue } from "@/data/catalogue";
import { getSceneReview } from "@/data/scene-candidates";
import { matchCampaignToScene, type CampaignMatch } from "@/lib/campaigns/matching";
import type { Campaign } from "@/lib/campaigns/types";
import { curatorApproval } from "./fixtures";

const daybreak = campaigns.find((c) => c.id === "daybreak-cold-brew")!;
const title = catalogue.find((t) => t.id === "hate-hypothesis")!;
const scene = (id: string) => getSceneReview("hate-hypothesis")!.scenes.find((s) => s.id === id)!;
/** A modified copy for a rejection case. The real fixture is never changed. */
const variant = (overrides: Partial<Campaign>): Campaign => ({ ...structuredClone(daybreak), ...overrides });
const failing = (m: CampaignMatch) =>
  [...m.audienceRules, ...m.fitChecks, ...m.safetyChecks].filter((c) => c.outcome === "fail").map((c) => c.label);

async function run(name: string, args: Record<string, unknown>) {
  const tool = toolsForRole("campaign-matcher").find((t) => t.name === name);
  assert.ok(tool, `campaign-matcher should have ${name}`);
  return (await tool.handler(args)) as Record<string, unknown>;
}

describe("Campaign Matcher evidence tools", () => {
  it("gives Campaign Matcher only its own tools", () => {
    assert.deepEqual(toolsForRole("campaign-matcher").map((t) => t.name).sort(), [
      "nativeframe_evaluate_campaign_match",
      "nativeframe_get_campaign",
      "nativeframe_get_selected_scene",
      "nativeframe_validate_handoff",
    ]);
  });

  it("returns the selected hh-scene-1 evidence", async () => {
    const r = (await run("nativeframe_get_selected_scene", { sceneId: "hh-scene-1" })) as {
      found: boolean;
      titleId: string;
      scene: { name: string; durationSeconds: number; surface: string; opportunities: string[] };
    };
    assert.equal(r.found, true);
    assert.equal(r.titleId, "hate-hypothesis");
    assert.equal(r.scene.name, "Lab desk discussion");
    assert.equal(r.scene.durationSeconds, 5);
    assert.match(r.scene.surface, /Lab desk/);
    assert.ok(r.scene.opportunities.includes("Coffee cup"));
  });

  it("returns the Daybreak Cold Brew campaign fixture and states that audience eligibility is rule-based", async () => {
    const r = (await run("nativeframe_get_campaign", { campaignId: "daybreak-cold-brew" })) as {
      campaign: Campaign;
      source: string;
    };
    assert.equal(r.campaign.product, "Daybreak Cold Brew");
    assert.equal(r.campaign.productFormat, "Branded takeaway coffee cup");
    assert.equal(r.campaign.market, "United States");
    assert.deepEqual(r.campaign.audience, {
      minAge: 25,
      maxAge: 45,
      eligibleTiers: ["ad-supported"],
      exclusions: ["premium-ad-free", "under-18"],
    });
    assert.match(r.source, /Subscriber records are not connected/);
    assert.match(r.source, /rule-based/);
  });

  it("recommends Daybreak Cold Brew for hh-scene-1 with every check passing", async () => {
    const r = (await run("nativeframe_evaluate_campaign_match", { sceneId: "hh-scene-1", campaignId: "daybreak-cold-brew" })) as unknown as CampaignMatch & {
      productFormat: string;
      surface: string;
    };
    assert.equal(r.decision, "recommended");
    assert.deepEqual(failing(r), []);
    assert.ok([...r.audienceRules, ...r.fitChecks, ...r.safetyChecks].every((c) => c.outcome === "pass"));
    for (const label of ["Age range", "Subscription tier", "Premium exclusion", "Minor exclusion", "Market"]) {
      assert.ok(r.audienceRules.some((c) => c.label === label), label);
    }
    assert.ok(r.fitChecks.some((c) => c.label === "Placement length" && /5 seconds/.test(c.evidence)));
    assert.ok(r.whyItFits.some((w) => /stationary coffee cup/.test(w)));
    assert.ok(r.limitations.some((l) => /stationary on the desk with no hand interaction/.test(l)));
    assert.ok(r.limitations.some((l) => /not yet applied to subscriber records/.test(l)));
    assert.equal(r.productFormat, "Branded takeaway coffee cup");
    assert.match(r.surface, /Lab desk/);
  });

  it("reports unknown scenes and campaigns instead of guessing", async () => {
    assert.equal((await run("nativeframe_get_selected_scene", { sceneId: "hh-scene-9" })).found, false);
    assert.equal((await run("nativeframe_get_campaign", { campaignId: "unknown-brand" })).found, false);
    assert.equal((await run("nativeframe_evaluate_campaign_match", { sceneId: "hh-scene-1", campaignId: "nope" })).found, false);
  });
});

describe("Campaign matching rejections (rules applied to modified copies)", () => {
  const cases: [string, Campaign, string][] = [
    ["non-US market", variant({ market: "Canada" }), "Market"],
    ["audience including minors", variant({ audience: { ...daybreak.audience, minAge: 16 } }), "Age range"],
    ["premium ad-free tier eligible", variant({ audience: { ...daybreak.audience, eligibleTiers: ["ad-supported", "premium-ad-free"] } }), "Subscription tier"],
    ["premium exclusion missing", variant({ audience: { ...daybreak.audience, exclusions: ["under-18"] } }), "Premium exclusion"],
    ["minor exclusion missing", variant({ audience: { ...daybreak.audience, exclusions: ["premium-ad-free"] } }), "Minor exclusion"],
    ["alcohol advertiser", variant({ category: "alcohol" }), "Advertiser category"],
    ["medium brand-safety risk", variant({ brandSafetyRisk: "medium" }), "Campaign risk level"],
    ["placement length outside the scene", variant({ placementSeconds: { min: 3, max: 4 } }), "Placement length"],
    ["product the scene cannot hold", variant({ placementObject: "Food bag" }), "Object belongs in scene"],
  ];
  for (const [name, campaign, failedCheck] of cases) {
    it(`does not recommend with ${name}`, () => {
      const match = matchCampaignToScene(campaign, scene("hh-scene-1"), title);
      assert.equal(match.decision, "not-recommended");
      assert.ok(failing(match).includes(failedCheck), `${failedCheck} should fail; failed: ${failing(match).join(", ")}`);
      assert.deepEqual(match.whyItFits, []);
    });
  }

  it("does not recommend Daybreak for the café scene (no coffee cup) or the rejected hallway scene", () => {
    assert.equal(matchCampaignToScene(daybreak, scene("hh-scene-2"), title).decision, "not-recommended");
    const hallway = matchCampaignToScene(daybreak, scene("hh-scene-3"), title);
    assert.equal(hallway.decision, "not-recommended");
    assert.ok(failing(hallway).includes("Tone match"));
  });

  it("does not recommend for a sensitive title", () => {
    const squid = catalogue.find((t) => t.id === "squid-gamed")!;
    assert.ok(failing(matchCampaignToScene(daybreak, scene("hh-scene-1"), squid)).includes("Title sensitivity"));
  });

  it("leaves the approved Daybreak fixture unchanged", () => {
    assert.equal(daybreak.market, "United States");
    assert.deepEqual(daybreak.placementSeconds, { min: 3, max: 5 });
    assert.equal(daybreak.brandSafetyRisk, "low");
  });
});

describe("Scene Scout re-delivery for Campaign Matcher", () => {
  const scoutSelect = curatorApproval({
    senderRole: "scene-scout",
    recipientRole: "campaign-matcher",
    decision: "select",
    artifactId: "scene:hh-scene-1",
    timestamp: "2026-10-15T01:28:44.652Z",
  });
  const original = `@ipchoudhury Selected hh-scene-1.\n\n${formatHandoffBlock(scoutSelect)}`;
  const expect = { senderRole: "scene-scout", recipientRole: "campaign-matcher", decision: "select" } as const;
  const build = (content = original) =>
    buildRedelivery({ originalContent: content, originalMessageId: "479ee01a", expect, recipientMention: "@ipchoudhury/nf-campaign-matcher" });

  it("prepares an unstamped draft that keeps every field except the timestamp", () => {
    const r = build();
    assert.ok(r.ok);
    const { timestamp: _stale, ...expected } = scoutSelect;
    void _stale;
    assert.deepEqual(r.envelope, expected);
    assert.match(r.draftContent, /^@ipchoudhury\/nf-campaign-matcher Re-delivery of the scene-scout handoff from message 479ee01a/);
    assert.ok(!r.draftContent.includes(scoutSelect.timestamp), "the original (stale) timestamp is not carried into the draft");
    const [block] = extractHandoffs(r.draftContent);
    assert.ok(block.ok && !("timestamp" in (block.value as object)), "draft has no timestamp until POST time");
  });

  it("refuses to re-deliver anything other than the expected valid handoff", () => {
    const wrong = { ...expect, decision: "reject" } as const;
    assert.equal(buildRedelivery({ originalContent: original, originalMessageId: "x", expect: wrong, recipientMention: "@m" }).ok, false);
    assert.equal(build("No handoff here.").ok, false);
    assert.equal(build(`${original}\n${original}`).ok, false);
    assert.equal(build(formatHandoffBlock({ ...scoutSelect, recipientRole: "placement-director" })).ok, false);
  });

  it("is accepted by Campaign Matcher only from the authenticated Scene Scout identity", async () => {
    const r = build();
    assert.ok(r.ok);
    const T = new Date("2026-10-15T12:00:00.000Z");
    let posted = "";
    const result = await postWithTrustedTimestamp({
      draftContent: r.draftContent,
      post: async (content) => ((posted = content), { id: "m1" }),
      readPostedAt: async () => T,
      clock: () => T,
    });
    assert.ok(result.ok);
    const clock = { now: T, postedAt: T };
    assert.equal(screenIncomingMessage("campaign-matcher", posted, { role: "scene-scout", type: "Agent" }, clock).consume, true);
    assert.equal(screenIncomingMessage("campaign-matcher", posted, { role: "content-curator", type: "Agent" }, clock).consume, false);
    assert.equal(screenIncomingMessage("campaign-matcher", posted, { role: null, type: "User" }, clock).consume, false);
  });
});

describe("Exact send-boundary timestamp", () => {
  const T0 = new Date("2026-10-15T12:00:00.000Z");
  const T_POST = new Date(T0.getTime() + 10 * 60_000); // sent 10 minutes after the result was prepared
  const prepared = formatHandoffBlock(curatorApproval({ timestamp: T0.toISOString() }));

  it("stamps at the moment of the POST, not when the draft was prepared", async () => {
    let clockNow = T0;
    let posted = "";
    const draft = prepared; // prepared at T0
    clockNow = T_POST; // ...sent later
    const result = await postWithTrustedTimestamp({
      draftContent: draft,
      post: async (content) => ((posted = content), { id: "m1" }),
      readPostedAt: async () => new Date(T_POST.getTime() + 300),
      clock: () => clockNow,
    });
    assert.ok(result.ok);
    const [block] = extractHandoffs(posted);
    assert.ok(block.ok);
    assert.equal((block.value as HandoffEnvelope).timestamp, T_POST.toISOString());
    assert.notEqual((block.value as HandoffEnvelope).timestamp, T0.toISOString());
    if (result.ok) assert.equal(result.skewMs, -300);
  });

  it("an earlier prepared timestamp that bypasses the send boundary is rejected against BAND's posting time", () => {
    const result = screenIncomingMessage("scene-scout", prepared, { role: "content-curator", type: "Agent" }, { now: T_POST, postedAt: T_POST });
    assert.equal(result.consume, false);
    if (!result.consume) assert.match(result.reasons[0], /older than BAND's posting time/);
  });

  it("reports a post whose BAND posting time does not match the stamp", async () => {
    const result = await postWithTrustedTimestamp({
      draftContent: prepared,
      post: async () => ({ id: "m2" }),
      readPostedAt: async () => new Date(T_POST.getTime() + 10 * 60_000),
      clock: () => T_POST,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, "verify");
  });
});

describe("Campaign Matcher output rules", () => {
  const matcherHandoff = (over: Partial<HandoffEnvelope> = {}) =>
    curatorApproval({
      senderRole: "campaign-matcher",
      recipientRole: "placement-director",
      decision: "recommend",
      artifactId: "match:daybreak-cold-brew:hh-scene-1",
      evidence: [
        { claim: "Coffee cup is a natural opportunity in hh-scene-1.", source: "nativeframe_get_selected_scene.scene.opportunities" },
        { claim: "Every audience, fit, and brand-safety check passes.", source: "nativeframe_evaluate_campaign_match.decision" },
        { claim: "The Scene Scout selected hh-scene-1.", source: "handoff.artifactId" },
      ],
      assumptions: ["Subscriber records are not connected; audience eligibility is rule-based."],
      ...over,
    });
  const readable = `@ipchoudhury Daybreak Cold Brew is recommended for hh-scene-1. ${PLACEMENT_DIRECTOR_DISCLOSURE}`;

  it("accepts a cited result with the exact disclosure", () => {
    assert.deepEqual(validateResult(matcherHandoff(), readable), []);
    assert.equal(stampOutgoingContent(`${readable}\n\n${formatHandoffBlock(matcherHandoff())}`).ok, true);
  });

  it("rejects a result when the disclosure is missing or reworded", () => {
    const missing = stampOutgoingContent(`@ipchoudhury Daybreak Cold Brew is recommended.\n\n${formatHandoffBlock(matcherHandoff())}`);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.ok(missing.errors.some((e) => e.includes(PLACEMENT_DIRECTOR_DISCLOSURE)));
    assert.notDeepEqual(validateResult(matcherHandoff(), "@ipchoudhury Placement Director hasn't consumed this yet."), []);
  });

  it("refuses to post a result without the disclosure through the agent send boundary", async () => {
    const posts: string[] = [];
    const tools = { executeToolCall: async (_n: string, a: Record<string, unknown>) => (posts.push(String(a.content)), { ok: true }) };
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const res = (await withHandoffStamping(tools, quiet).executeToolCall("band_send_message", {
      content: `@ipchoudhury Recommended.\n\n${formatHandoffBlock(matcherHandoff())}`,
    })) as { ok: boolean };
    assert.equal(res.ok, false);
    assert.deepEqual(posts, []);
  });

  it("rejects evidence that does not cite the handoff or an approved tool", () => {
    const uncited = matcherHandoff({ evidence: [{ claim: "Rights are cleared.", source: "catalogue.rightsStatus" }] });
    assert.ok(validateResult(uncited, readable).some((e) => e.startsWith("evidence[0].source")));
  });

  it("rejects claims that rely on room history or another agent's message", () => {
    const history = matcherHandoff({
      evidence: [{ claim: "Actor restrictions were confirmed by the Content Curator handoff.", source: "nativeframe_evaluate_campaign_match.safetyChecks" }],
    });
    assert.ok(validateResult(history, readable).some((e) => /room history/.test(e)));
    const assumption = matcherHandoff({ assumptions: ["Rights confirmed in an earlier message from the Content Curator."] });
    assert.ok(validateResult(assumption, readable).some((e) => /assumptions\[0\]/.test(e)));
    assert.ok(validateResult(matcherHandoff(), `${readable} As the Content Curator confirmed in room history, rights are cleared.`).some((e) => /readable/.test(e)));
  });

  it("checks citations in drafts too, so the validation tool gives early feedback", () => {
    const r = validateDraft(matcherHandoff({ evidence: [{ claim: "x", source: "room history" }] }));
    assert.equal(r.ok, false);
  });
});
