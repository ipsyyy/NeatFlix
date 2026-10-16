import type { ValidationRegistries } from "@/agents/handoff/envelope";
import { stampOutgoingContent } from "@/agents/handoff/stamp";
import { checkHandoffTimestamp } from "@/agents/handoff/timestamps";

export type TrustedPost =
  | { ok: true; messageId: string; timestamp: string; postedAt: string; skewMs: number }
  | { ok: false; stage: "validate" | "verify"; errors: string[]; messageId?: string };

/**
 * Posts a prepared (unstamped) handoff with the trusted timestamp attached at
 * the last possible moment: `clock()` is read immediately before `post` runs,
 * never when the draft was prepared. After posting, the stamp is checked
 * against BAND's own recorded posting time.
 */
export async function postWithTrustedTimestamp(options: {
  draftContent: string;
  post: (stampedContent: string) => Promise<{ id: string }>;
  readPostedAt: (messageId: string) => Promise<Date | null>;
  clock?: () => Date;
  registries?: ValidationRegistries;
}): Promise<TrustedPost> {
  const clock = options.clock ?? (() => new Date());
  const stamped = stampOutgoingContent(options.draftContent, clock(), options.registries);
  if (!stamped.ok) return { ok: false, stage: "validate", errors: stamped.errors };
  if (!stamped.timestamp) return { ok: false, stage: "validate", errors: ["No handoff to stamp."] };

  const { id } = await options.post(stamped.content);
  const postedAt = await options.readPostedAt(id);
  if (!postedAt) return { ok: false, stage: "verify", errors: ["BAND posting time not found."], messageId: id };
  const check = checkHandoffTimestamp(stamped.timestamp, { now: clock(), postedAt });
  if (!check.ok) return { ok: false, stage: "verify", errors: [check.reason], messageId: id };
  return { ok: true, messageId: id, timestamp: stamped.timestamp, postedAt: postedAt.toISOString(), skewMs: check.skewMs };
}
