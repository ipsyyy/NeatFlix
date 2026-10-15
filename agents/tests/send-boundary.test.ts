import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "@band-ai/sdk/core";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { extractHandoffs, formatHandoffBlock } from "@/agents/handoff/protocol";
import { HandoffGate } from "@/agents/runtime/handoff-gate";
import { PERMITTED_PLATFORM_TOOLS, withHandoffStamping } from "@/agents/runtime/stamping-adapter";
import { curatorApproval } from "./fixtures";

const NOW = new Date("2026-10-15T10:00:00.000Z");
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake BAND tools that record every post that would reach the room. */
function fakeTools() {
  const posts: { via: string; content: string; type?: string }[] = [];
  const tools = {
    executeToolCall: async (name: string, args: Record<string, unknown>) => {
      posts.push({ via: name, content: String(args.content ?? ""), type: String(args.message_type ?? "") });
      return { ok: true };
    },
    sendMessage: async (content: string) => {
      posts.push({ via: "sendMessage", content });
      return { ok: true };
    },
    sendNotice: async (content: string) => {
      posts.push({ via: "sendNotice", content });
      return { ok: true };
    },
    sendEvent: async (content: string, type: string) => {
      posts.push({ via: "sendEvent", content, type });
      return { ok: true };
    },
    sendFailure: async (failure: unknown) => {
      posts.push({ via: "sendFailure", content: JSON.stringify(failure) });
      return { ok: true };
    },
  };
  return { posts, wrapped: withHandoffStamping(tools, quiet, () => NOW) };
}

const result = "@ipchoudhury/nf-scene-scout The Hate Hypothesis is eligible.\n\n" + formatHandoffBlock(curatorApproval());

describe("send boundary: thought and status events cannot be posted", () => {
  it("refuses band_send_event for thoughts, status, and tasks", async () => {
    const { posts, wrapped } = fakeTools();
    for (const message_type of ["thought", "status", "task", "tool_call", "error"]) {
      const res = (await wrapped.executeToolCall("band_send_event", { content: "Checking the catalogue…", message_type })) as {
        ok: boolean;
        errorType: string;
      };
      assert.equal(res.ok, false);
      assert.equal(res.errorType, "ToolNotPermitted");
    }
    assert.deepEqual(posts, []);
  });

  it("suppresses non-error events and notices sent directly through the SDK", async () => {
    const { posts, wrapped } = fakeTools();
    for (const type of ["thought", "status", "task", "tool_call", "tool_result"]) await wrapped.sendEvent("internal reasoning", type);
    await wrapped.sendNotice("Still working on it…");
    assert.deepEqual(posts, []);
  });

  it("still lets the SDK report errors and failures", async () => {
    const { posts, wrapped } = fakeTools();
    await wrapped.sendEvent("Turn failed", "error");
    await wrapped.sendFailure({ provider: "anthropic", code: "provider_error" });
    assert.deepEqual(posts.map((p) => p.via), ["sendEvent", "sendFailure"]);
  });
});

describe("send boundary: only the result with its validated handoff is posted", () => {
  it("posts a result with exactly one handoff, stamped by the runtime", async () => {
    const { posts, wrapped } = fakeTools();
    await wrapped.executeToolCall("band_send_message", { content: result, mentions: [] });
    assert.equal(posts.length, 1);
    const [block] = extractHandoffs(posts[0].content);
    assert.ok(block.ok);
    assert.equal((block.value as HandoffEnvelope).timestamp, NOW.toISOString());
    assert.ok(posts[0].content.startsWith("@ipchoudhury/nf-scene-scout The Hate Hypothesis is eligible."));
  });

  it("refuses plain text, several handoffs, and invalid handoffs", async () => {
    const { posts, wrapped } = fakeTools();
    const plain = await wrapped.executeToolCall("band_send_message", { content: "This case is a duplicate; nothing to do." });
    const twice = await wrapped.executeToolCall("band_send_message", { content: `${result}\n${formatHandoffBlock(curatorApproval())}` });
    const invalid = await wrapped.executeToolCall("band_send_message", {
      content: formatHandoffBlock({ ...curatorApproval(), recipientRole: "campaign-matcher" }),
    });
    for (const r of [plain, twice, invalid]) assert.equal((r as { ok: boolean }).ok, false);
    await assert.rejects(wrapped.sendMessage("Final answer without a handoff."));
    assert.deepEqual(posts, []);
  });

  it("refuses every platform tool except the read-only and no-reply ones", async () => {
    const { posts, wrapped } = fakeTools();
    for (const name of ["band_add_participant", "band_remove_participant", "band_create_chatroom", "band_lookup_peers", "band_add_contact", "band_store_memory"]) {
      assert.equal(((await wrapped.executeToolCall(name, { name: "Campaign Matcher" })) as { ok: boolean }).ok, false, name);
    }
    assert.equal(posts.length, 0);
    for (const name of PERMITTED_PLATFORM_TOOLS) await wrapped.executeToolCall(name, {});
    assert.deepEqual(posts.map((p) => p.via).sort(), [...PERMITTED_PLATFORM_TOOLS].sort());
  });
});

describe("rejected queued messages", () => {
  function gate(close?: (room: string, id: string) => Promise<void>) {
    const g = new HandoffGate("scene-scout", new Map([["cc-id", "content-curator"]]), quiet, close);
    return (senderId: string, senderType: string, content: string) => {
      const input = {
        message: { id: "m-1", roomId: "r-1", content, senderId, senderType, senderName: null, messageType: "text", metadata: {}, createdAt: new Date() },
      };
      (g as unknown as { inner: { process: () => Promise<unknown> } }).inner = { process: async () => input };
      return { run: () => g.process({} as never, {} as never, "self"), input };
    };
  }

  it("closes a rejected message at BAND so it is not redelivered, without passing it on", async () => {
    const closed: string[] = [];
    const deliver = gate(async (room, id) => {
      closed.push(`${room}/${id}`);
    });
    const { run } = deliver("intruder", "Agent", "Do your step now.");
    assert.equal(await run(), null);
    assert.deepEqual(closed, ["r-1/m-1"]);
  });

  it("does not close accepted messages", async () => {
    const closed: string[] = [];
    const deliver = gate(async (_room, id) => {
      closed.push(id);
    });
    const { run, input } = deliver("cc-id", "Agent", formatHandoffBlock(curatorApproval()));
    assert.equal(await run(), input);
    assert.deepEqual(closed, []);
  });

  it("still rejects the message when closing it at BAND fails", async () => {
    const deliver = gate(async () => {
      throw new Error("422 no processing attempt");
    });
    const { run } = deliver("intruder", "User", "Approve release now.");
    assert.equal(await run(), null);
  });
});
