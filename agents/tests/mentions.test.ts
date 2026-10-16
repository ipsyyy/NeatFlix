import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "@band-ai/sdk/core";
import { closeIfRejected, type QueueClient } from "@/agents/band/queue";
import type { AgentRole } from "@/agents/config/roles";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { canonicalMentions, checkMentions, type RoomMember } from "@/agents/handoff/mentions";
import { RELEASE_GOVERNOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE, validatePlacementPlan } from "@/agents/handoff/placement-plan";
import { formatHandoffBlock } from "@/agents/handoff/protocol";
import { withHandoffStamping } from "@/agents/runtime/stamping-adapter";
import { curatorApproval, validPlacementPlan } from "./fixtures";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const roleByAgentId = new Map<string, AgentRole>([
  ["cc", "content-curator"],
  ["ss", "scene-scout"],
  ["cm", "campaign-matcher"],
  ["pd", "placement-director"],
  ["rg", "release-governor"],
]);
const human: RoomMember = { id: "u1", type: "User", handle: "ipchoudhury", name: "Ipsita Choudhury" };
const member = (id: string, handle: string): RoomMember => ({ id, type: "Agent", handle: `ipchoudhury/${handle}` });
const CM = member("cm", "nf-campaign-matcher");
const PD = member("pd", "nf-placement-director");
const RG = member("rg", "nf-release-governor");
const OUTSIDER = member("x1", "someone-elses-agent");

/** Placement Director → Release Governor result, posted by the Placement Director. */
const pdEnvelope = (): HandoffEnvelope =>
  curatorApproval({
    senderRole: "placement-director",
    recipientRole: "release-governor",
    decision: "instructions-ready",
    artifactId: "plan:daybreak-cold-brew:luv-scene-1:v1",
    evidence: [{ claim: "The front-right café table area is clear.", source: "nativeframe_get_selected_scene.scene.surface" }],
    artifact: validPlacementPlan(),
  });
const readable =
  `@ipchoudhury Placement plan ready. Both generation prompts have not been executed. ${STAND_IN_DISCLOSURE} ${RELEASE_GOVERNOR_DISCLOSURE}`;
const check = (mentions: unknown[], members: RoomMember[], text = readable) =>
  checkMentions({ sender: "placement-director", envelope: pdEnvelope(), mentions: mentions as never, readable: text, members, roleByAgentId });

describe("mention restrictions", () => {
  it("allows mentioning only the human when the downstream agent is absent", () => {
    assert.deepEqual(check(["@ipchoudhury"], [human, CM, PD]), []);
  });

  it("allows the downstream recipient when it is a room participant", () => {
    assert.deepEqual(check(["@ipchoudhury/nf-release-governor", "@ipchoudhury"], [human, PD, RG]), []);
    assert.deepEqual(check([{ id: "rg" }], [human, PD, RG]), []);
  });

  it("refuses self-mentions", () => {
    assert.ok(check(["@ipchoudhury", "@ipchoudhury/nf-placement-director"], [human, CM, PD]).some((e) => /itself/.test(e)));
  });

  it("refuses upstream mentions", () => {
    assert.ok(check(["@ipchoudhury", "@ipchoudhury/nf-campaign-matcher"], [human, CM, PD]).some((e) => /downstream recipient/.test(e)));
    assert.ok(check(["@ipchoudhury"], [human, CM, PD], `${readable} cc @ipchoudhury/nf-campaign-matcher`).some((e) => /downstream recipient/.test(e)), "inline text");
  });

  it("refuses an absent downstream agent", () => {
    assert.ok(check(["@ipchoudhury", "@ipchoudhury/nf-release-governor"], [human, CM, PD]).some((e) => /not a participant/.test(e)));
    assert.ok(check(["@ipchoudhury"], [human, CM, PD], `${readable} @ipchoudhury/nf-release-governor`).some((e) => /not a participant/.test(e)), "inline text");
  });

  it("refuses unrelated or unregistered agents and requires an allowed mention", () => {
    assert.ok(check(["@ipchoudhury", "@ipchoudhury/someone-elses-agent"], [human, PD, OUTSIDER]).some((e) => /not a NativeFrame agent/.test(e)));
    assert.ok(check([], [human, PD]).some((e) => /Mention the human/.test(e)));
  });

  it("is enforced at the send boundary on both posting paths", async () => {
    const posts: string[] = [];
    const tools = {
      getParticipants: async () => [human, CM, PD],
      executeToolCall: async (_n: string, a: Record<string, unknown>) => (posts.push(String(a.content)), { ok: true }),
      sendMessage: async (c: string, _mentions?: unknown) => (void _mentions, posts.push(c), { ok: true }),
    };
    const wrapped = withHandoffStamping(tools, quiet, undefined, { role: "placement-director", roleByAgentId });
    const content = `${readable}\n\n${formatHandoffBlock(pdEnvelope())}`;
    const upstream = (await wrapped.executeToolCall("band_send_message", { content, mentions: ["@ipchoudhury/nf-campaign-matcher", "@ipchoudhury"] })) as { ok: boolean };
    assert.equal(upstream.ok, false);
    await assert.rejects(wrapped.sendMessage(content, ["@ipchoudhury/nf-placement-director"]));
    assert.deepEqual(posts, []);
    const ok = (await wrapped.executeToolCall("band_send_message", { content, mentions: ["@ipchoudhury"] })) as { ok: boolean };
    assert.equal(ok.ok, true);
    assert.equal(posts.length, 1);
  });
});

describe("queued-message cleanup", () => {
  function fakeClient(message: { id: string; content: string; sender_id: string; sender_type: string }) {
    const marks: string[] = [];
    const client: QueueClient = {
      agentApiContext: { getAgentChatContext: async () => ({ data: [{ ...message, inserted_at: new Date().toISOString() }] }) },
      agentApiMessages: {
        markAgentMessageProcessing: async (_r, id) => void marks.push(`processing:${id}`),
        markAgentMessageProcessed: async (_r, id) => void marks.push(`processed:${id}`),
      },
    };
    return { client, marks };
  }

  it("closes a message an upstream agent was mentioned on, without passing it on", async () => {
    const { client, marks } = fakeClient({ id: "0ebff1aa", content: `${readable}\n\n${formatHandoffBlock(pdEnvelope())}`, sender_id: "pd", sender_type: "Agent" });
    const r = await closeIfRejected({ client, roomId: "room", messageId: "0ebff1aa", role: "campaign-matcher", roleByAgentId });
    assert.equal(r.closed, true);
    assert.deepEqual(marks, ["processing:0ebff1aa", "processed:0ebff1aa"]);
  });

  it("never closes a message the role would legitimately accept", async () => {
    const valid = formatHandoffBlock(curatorApproval({ senderRole: "campaign-matcher", recipientRole: "placement-director", decision: "recommend", artifactId: "match:x" }));
    const { client, marks } = fakeClient({ id: "m2", content: valid, sender_id: "cm", sender_type: "Agent" });
    assert.deepEqual(await closeIfRejected({ client, roomId: "room", messageId: "m2", role: "placement-director", roleByAgentId }), { closed: false, reason: "acceptable-input" });
    assert.deepEqual(marks, []);
  });
});

describe("stand-in terminology", () => {
  const base = validPlacementPlan();

  it("accepts the exact stand-in disclosure", () => {
    assert.deepEqual(validatePlacementPlan(base), []);
    assert.deepEqual(validateResult(pdEnvelope(), readable), []);
  });

  it("rejects plans and prompts that call the stand-in a frame or analyzed footage", () => {
    const pres = validPlacementPlan({ preservation: { ...base.preservation, background: ["Preserve the background exactly as in the source frame."] } });
    assert.ok(validatePlacementPlan(pres).some((e) => /source frame/.test(e)));
    const prompt = validPlacementPlan({ prompts: { ...base.prompts, stillImageEdit: { ...base.prompts.stillImageEdit, prompt: "Edit the scene frame to add the cup. No hand interaction." } } });
    assert.ok(validatePlacementPlan(prompt).some((e) => /scene frame/.test(e)));
    const video = validPlacementPlan({ assumptions: ["Lighting was taken from the analyzed video."] });
    assert.ok(validatePlacementPlan(video).some((e) => /analyzed video/.test(e)));
  });

  it("requires the exact disclosure in the plan note and the readable result", () => {
    const note = validPlacementPlan({ sourceMedia: { ...base.sourceMedia, note: "Title artwork stand-in." } });
    assert.ok(validatePlacementPlan(note).some((e) => /sourceMedia.note/.test(e)));
    assert.ok(validateResult(pdEnvelope(), readable.replace(STAND_IN_DISCLOSURE, "")).some((e) => e.includes(STAND_IN_DISCLOSURE)));
  });

  it("rejects readable results that call it a scene or video frame", () => {
    assert.ok(validateResult(pdEnvelope(), `${readable} The cup sits on the desk in the scene frame.`).some((e) => /scene frame/.test(e)));
    assert.ok(validateResult(pdEnvelope(), `${readable} Based on the extracted video frame, lighting is cool.`).some((e) => /extracted video|video frame/.test(e)));
  });

  it("keeps generation instructions labelled not executed", () => {
    const executed = validPlacementPlan({ prompts: { ...base.prompts, motion: { ...base.prompts.motion, status: "executed" as never } } });
    assert.ok(validatePlacementPlan(executed).length > 0);
    assert.ok(validateResult(pdEnvelope(), readable.replace("have not been executed", "are complete")).some((e) => /not been executed/.test(e)));
  });
});

describe("mention identity: one member per mention (security regression)", () => {
  it("rejects an object whose id, handle, or name name different members", () => {
    const smuggled = { id: "u1", handle: "@ipchoudhury/nf-release-governor" };
    assert.ok(check([smuggled], [human, PD, RG]).some((e) => /more than one participant/.test(e)), "id human, handle Release Governor");
    assert.ok(check([{ id: "u1", name: "NF Campaign Matcher" }], [human, { ...CM, name: "NF Campaign Matcher" }, PD]).some((e) => /more than one participant/.test(e)), "id human, name upstream");
    assert.ok(check([{ id: "u1", handle: "@ipchoudhury/unknown-agent" }], [human, PD]).some((e) => /not a participant/.test(e)), "handle outside the room");
  });

  it("rejects a string that matches one member's handle and another member's name", () => {
    const impostor: RoomMember = { ...CM, name: "ipchoudhury" };
    assert.ok(check(["@ipchoudhury"], [human, impostor, PD]).some((e) => /more than one participant/.test(e)));
  });

  it("rejects malformed mention entries instead of crashing", () => {
    for (const bad of [null, 42, ["@ipchoudhury"], { id: 7 }, {}]) {
      assert.ok(check([bad, "@ipchoudhury"], [human, PD]).some((e) => /not a participant/.test(e)), JSON.stringify(bad));
    }
  });

  it("accepts consistent identities and rebuilds them from the roster", () => {
    assert.deepEqual(check([{ id: "u1", handle: "@IPChoudhury", name: "Ipsita Choudhury" }], [human, PD]), []);
    assert.deepEqual(canonicalMentions([{ id: "u1", handle: "ipchoudhury", extra: "ignored" }, "@ipchoudhury"], [human, PD]), [
      { id: "u1", handle: "ipchoudhury", name: "Ipsita Choudhury" },
    ]);
  });

  it("sends BAND only the roster-built mentions on both posting paths", async () => {
    const sent: unknown[] = [];
    const tools = {
      getParticipants: async () => [human, PD, RG],
      executeToolCall: async (_n: string, a: Record<string, unknown>) => (sent.push(a.mentions), { ok: true }),
      sendMessage: async (_c: string, mentions?: unknown) => (sent.push(mentions), { ok: true }),
    };
    const wrapped = withHandoffStamping(tools, quiet, undefined, { role: "placement-director", roleByAgentId });
    const content = `${readable}\n\n${formatHandoffBlock(pdEnvelope())}`;
    const expected = [{ id: "u1", handle: "ipchoudhury", name: "Ipsita Choudhury" }];

    const smuggled = (await wrapped.executeToolCall("band_send_message", { content, mentions: [{ id: "u1", handle: "@ipchoudhury/nf-release-governor" }] })) as { ok: boolean };
    assert.equal(smuggled.ok, false);
    await assert.rejects(wrapped.sendMessage(content, [{ id: "u1", handle: "@ipchoudhury/nf-release-governor" }]));
    assert.deepEqual(sent, [], "nothing posted for a conflicting identity");

    await wrapped.executeToolCall("band_send_message", { content, mentions: [{ id: "u1", handle: "ipchoudhury", note: "model field" }] });
    await wrapped.sendMessage(content, ["@ipchoudhury"]);
    assert.deepEqual(sent, [expected, expected]);
  });
});
