/**
 * Handoff timestamps are owned by the trusted runtime, never by Claude.
 *
 * - Sending: the runtime overwrites the envelope timestamp with its own UTC
 *   time at the moment the message is posted (see stamp.ts). BAND assigns its
 *   server time only after posting, so runtime UTC is the best available stamp.
 * - Receiving: the envelope timestamp is checked against BAND's server time for
 *   that message (`createdAt`), which the sender cannot control.
 */

/**
 * Allowed difference between the runtime stamp and BAND's server time (or the
 * receiver's clock). Covers network latency and modest clock drift between the
 * sending host and BAND; a model-invented or replayed timestamp falls outside it.
 */
export const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Oldest handoff a receiver will act on. BAND queues messages for offline
 * agents, so a valid handoff may be delivered later than it was sent, but
 * not indefinitely: an older case must be re-sent.
 */
export const MAX_HANDOFF_AGE_MS = 24 * 60 * 60_000;

/** Strict ISO 8601 UTC: 2026-10-14T23:36:57Z or 2026-10-14T23:36:57.938Z. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type TimestampProblem = "missing" | "malformed" | "stale" | "future";

export type TimestampCheck =
  | { ok: true; timestamp: string; skewMs: number }
  | { ok: false; problem: TimestampProblem; reason: string };

/** Current runtime time as an ISO 8601 UTC string. */
export function runtimeTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * Validates a received envelope timestamp. `postedAt` is BAND's server time for
 * the message; when unavailable, the receiver's clock is the reference.
 * Reasons never echo the raw value.
 */
export function checkHandoffTimestamp(
  value: unknown,
  clock: { now: Date; postedAt?: Date | null },
): TimestampCheck {
  if (value === undefined || value === null || value === "") {
    return { ok: false, problem: "missing", reason: "Handoff has no timestamp." };
  }
  if (typeof value !== "string" || !ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    return { ok: false, problem: "malformed", reason: "Handoff timestamp is not an ISO 8601 UTC date-time." };
  }
  const stamped = Date.parse(value);
  const now = clock.now.getTime();
  const posted = clock.postedAt && !Number.isNaN(clock.postedAt.getTime()) ? clock.postedAt.getTime() : null;
  const reference = posted ?? now;
  const skewMs = stamped - reference;
  const seconds = (ms: number) => `${Math.round(Math.abs(ms) / 1000)}s`;

  if (skewMs > CLOCK_SKEW_MS || stamped - now > CLOCK_SKEW_MS) {
    return { ok: false, problem: "future", reason: `Handoff timestamp is ${seconds(Math.max(skewMs, stamped - now))} ahead of ${posted ? "BAND's posting time" : "the receiver's clock"}.` };
  }
  if (skewMs < -CLOCK_SKEW_MS) {
    return { ok: false, problem: "stale", reason: `Handoff timestamp is ${seconds(skewMs)} older than ${posted ? "BAND's posting time" : "the receiver's clock"}.` };
  }
  if (now - stamped > MAX_HANDOFF_AGE_MS) {
    return { ok: false, problem: "stale", reason: `Handoff is ${seconds(now - stamped)} old; the limit is ${seconds(MAX_HANDOFF_AGE_MS)}.` };
  }
  return { ok: true, timestamp: value, skewMs };
}
