import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "@band-ai/sdk/core";
import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { extractHandoffs, formatHandoffBlock } from "@/agents/handoff/protocol";
import { stampOutgoingContent, validateDraft } from "@/agents/handoff/stamp";
import { CLOCK_SKEW_MS, MAX_HANDOFF_AGE_MS, checkHandoffTimestamp } from "@/agents/handoff/timestamps";
import { screenIncomingMessage } from "@/agents/runtime/handoff-gate";
import { withHandoffStamping } from "@/agents/runtime/stamping-adapter";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { curatorApproval } from "./fixtures";

const NOW = new Date("2026-10-15T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const CURATOR = { role: "content-curator", type: "Agent" } as const;

/** Envelope as it arrives over BAND, posted by BAND at `postedAt`. */
function received(timestamp: unknown, postedAt: Date = NOW) {
  const content = formatHandoffBlock({ ...curatorApproval(), timestamp } as HandoffEnvelope);
  return screenIncomingMessage("scene-scout", content, CURATOR, { now: NOW, postedAt });
}

const quietLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("received handoff timestamps", () => {
  it("accepts a valid current runtime timestamp", () => {
    const result = received(at(0));
    assert.equal(result.consume, true);
    if (result.consume) assert.equal(result.timestampSkewMs, 0);
  });

  it("accepts timestamps within the permitted clock skew of BAND's posting time", () => {
    assert.equal(received(at(-(CLOCK_SKEW_MS - 5_000))).consume, true, "slightly behind");
    assert.equal(received(at(CLOCK_SKEW_MS - 5_000)).consume, true, "slightly ahead");
  });

  it("accepts a queued handoff delivered later, if it was stamped when posted", () => {
    const postedAt = new Date(NOW.getTime() - 3 * 60 * 60_000);
    assert.equal(received(postedAt.toISOString(), postedAt).consume, true);
  });

  it("rejects stale timestamps", () => {
    assert.equal(received(at(-(CLOCK_SKEW_MS + 1_000))).consume, false, "older than posting time");
    assert.equal(received("2025-07-14T09:00:00Z").consume, false, "model-invented date from the first live run");
    const oldPost = new Date(NOW.getTime() - MAX_HANDOFF_AGE_MS - 60_000);
    assert.equal(received(oldPost.toISOString(), oldPost).consume, false, "beyond the maximum handoff age");
  });

  it("rejects future timestamps outside the tolerance", () => {
    assert.equal(received(at(CLOCK_SKEW_MS + 1_000)).consume, false);
    assert.equal(received("2027-01-01T00:00:00Z").consume, false);
  });

  it("rejects missing timestamps", () => {
    const { timestamp: _omit, ...withoutTimestamp } = curatorApproval();
    void _omit;
    const content = formatHandoffBlock(withoutTimestamp as HandoffEnvelope);
    const result = screenIncomingMessage("scene-scout", content, CURATOR, { now: NOW, postedAt: NOW });
    assert.deepEqual(result, { consume: false, reasons: ["Handoff has no timestamp."] });
    assert.equal(received("").consume, false);
    assert.equal(received(null).consume, false);
  });

  it("rejects malformed timestamps, including non-UTC offsets", () => {
    for (const bad of ["yesterday", "2026-10-15 10:00:00", "2026-10-15T10:00:00+02:00", "2026-13-40T99:99:99Z", 1_760_000_000]) {
      assert.equal(received(bad).consume, false, String(bad));
    }
  });

  it("explains problems without echoing the raw timestamp", () => {
    const check = checkHandoffTimestamp("2025-07-14T09:00:00Z<script>", { now: NOW, postedAt: NOW });
    assert.equal(check.ok, false);
    if (!check.ok) assert.ok(!check.reason.includes("<script>"));
  });

  it("checks the timestamp before authorization, so stale handoffs never reach Claude", () => {
    const stale = received("2025-07-14T09:00:00Z");
    assert.equal(stale.consume, false);
    if (!stale.consume) assert.match(stale.reasons[0], /older than BAND's posting time/);
  });
});

describe("runtime-owned timestamps at the send boundary", () => {
  const modelDraft = (timestamp?: string) =>
    "@ipchoudhury/nf-scene-scout The Hate Hypothesis is approved.\n\n" +
    formatHandoffBlock({ ...curatorApproval(), ...(timestamp ? { timestamp } : {}) } as HandoffEnvelope);

  it("replaces a model-written timestamp with the runtime time", () => {
    const result = stampOutgoingContent(modelDraft("2025-07-14T09:00:00Z"), NOW);
    assert.equal(result.ok, true);
    if (result.ok) {
      const [block] = extractHandoffs(result.content);
      assert.ok(block.ok);
      assert.equal((block.value as HandoffEnvelope).timestamp, NOW.toISOString());
      assert.ok(result.content.startsWith("@ipchoudhury/nf-scene-scout The Hate Hypothesis is approved."), "summary text unchanged");
    }
  });

  it("adds the runtime time when the model omits it", () => {
    const { timestamp: _omit, ...noTime } = curatorApproval();
    void _omit;
    const result = stampOutgoingContent(formatHandoffBlock(noTime as HandoffEnvelope), NOW);
    assert.ok(result.ok && result.timestamp === NOW.toISOString());
  });

  it("blocks an invalid handoff instead of sending it", () => {
    const result = stampOutgoingContent(formatHandoffBlock({ ...curatorApproval(), recipientRole: "campaign-matcher" }), NOW);
    assert.equal(result.ok, false);
  });

  it("stamps band_send_message calls and never forwards the model's timestamp", async () => {
    const posted: string[] = [];
    const tools = {
      executeToolCall: async (_name: string, args: Record<string, unknown>) => {
        posted.push(String(args.content));
        return { ok: true };
      },
      sendMessage: async (content: string) => {
        posted.push(content);
        return { ok: true };
      },
    };
    const wrapped = withHandoffStamping(tools, quietLogger, () => NOW);
    await wrapped.executeToolCall("band_send_message", { content: modelDraft("2025-07-14T09:00:00Z"), mentions: [] });
    await wrapped.sendMessage(modelDraft("2030-01-01T00:00:00Z"));
    assert.equal(posted.length, 2);
    for (const content of posted) {
      const [block] = extractHandoffs(content);
      assert.ok(block.ok);
      assert.equal((block.value as HandoffEnvelope).timestamp, NOW.toISOString());
    }
  });

  it("does not post an invalid handoff and returns the problem to the model", async () => {
    const posted: string[] = [];
    const tools = { executeToolCall: async (_n: string, a: Record<string, unknown>) => posted.push(String(a.content)) };
    const wrapped = withHandoffStamping(tools, quietLogger, () => NOW);
    const bad = formatHandoffBlock({ ...curatorApproval(), recipientRole: "campaign-matcher" });
    const result = (await wrapped.executeToolCall("band_send_message", { content: bad })) as unknown as { ok: boolean; errorType: string };
    assert.equal(posted.length, 0);
    assert.equal(result.errorType, "HandoffValidationError");
  });

  it("refuses messages without a handoff instead of posting them", async () => {
    const posted: string[] = [];
    const tools = { sendMessage: async (c: string) => posted.push(c) };
    await assert.rejects(withHandoffStamping(tools, quietLogger, () => NOW).sendMessage("@ipchoudhury Title is not eligible."));
    assert.deepEqual(posted, []);
  });

  it("validates drafts without requiring or trusting a model timestamp", async () => {
    const { timestamp: _omit, ...noTime } = curatorApproval();
    void _omit;
    assert.equal(validateDraft(noTime).ok, true);
    assert.equal(validateDraft({ ...noTime, timestamp: "not a time" }).ok, true, "model value ignored");
    const validate = toolsForRole("content-curator").find((t) => t.name === "nativeframe_validate_handoff")!;
    assert.equal(((await validate.handler({ handoffJson: JSON.stringify(noTime) })) as { ok: boolean }).ok, true);
  });
});
