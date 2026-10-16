import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HistoryProvider } from "@band-ai/sdk/runtime";
import { z } from "zod";
import { formatHandoffBlock } from "@/agents/handoff/protocol";
import { StampingAnthropicAdapter } from "@/agents/runtime/stamping-adapter";
import { currentTurnScope } from "@/agents/runtime/turn-scope";
import { curatorApproval } from "./fixtures";

/**
 * The authenticated turn scope must reach custom tool handlers when the real
 * BAND Anthropic adapter runs the tool loop. A fake Claude client asks for one
 * tool call, then ends the turn; nothing contacts Anthropic or BAND.
 */
async function runTurn(content: string) {
  const seen: unknown[] = [];
  let calls = 0;
  const adapter = new StampingAnthropicAdapter({
    anthropicModel: "fake-model",
    apiKey: "fake-key-not-real",
    maxTokens: 100,
    maxToolRounds: 3,
    systemPrompt: "test",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    customTools: [{ name: "probe_scope", description: "Report the turn scope.", schema: z.object({}), handler: () => (seen.push(currentTurnScope()), { ok: true }) }],
    clientFactory: async () => ({
      messages: {
        create: async () =>
          (calls++ === 0
            ? { id: "m1", type: "message", role: "assistant", model: "fake-model", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "probe_scope", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } }
            : { id: "m2", type: "message", role: "assistant", model: "fake-model", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } }) as never,
      },
    }),
  });
  // The adapter's own tool surface: no platform schemas, nothing posted, no reply yet.
  const tools = {
    getToolSchemas: () => [],
    executeToolCall: async () => ({ ok: true }),
    sendMessage: async () => ({ ok: true }),
    sendEvent: async () => ({ ok: true }),
    getParticipants: async () => [],
    turn: { posted: [] as string[], replied: true, detached: false, unanswered: false },
  } as never;
  const message = { id: "m", roomId: "r", content, senderId: "cm", senderType: "Agent", senderName: null, messageType: "text", metadata: {}, createdAt: new Date() };
  await adapter.onMessage(message as never, tools, new HistoryProvider([]), null, null, {} as never).catch((e) => assert.fail(`adapter failed: ${String(e).slice(0, 200)}`));
  return { seen, calls };
}

describe("authenticated turn scope reaches tools through the real adapter", () => {
  it("scopes a turn to the accepted handoff's case and scene", async () => {
    const content = formatHandoffBlock(curatorApproval({ senderRole: "campaign-matcher", recipientRole: "placement-director", decision: "recommend", artifactId: "match:daybreak-cold-brew:luv-scene-1" }));
    const { seen, calls } = await runTurn(content);
    assert.ok(calls >= 1, "the fake model was called");
    assert.deepEqual(seen, [{ caseId: "NF-DEMO-0001", sceneId: "luv-scene-1" }]);
    assert.equal(currentTurnScope(), null, "the scope does not leak outside the turn");
  });

  it("gives a turn with no handoff no scope", async () => {
    const { seen } = await runTurn("plain text with no handoff");
    assert.deepEqual(seen, [null]);
  });
});
