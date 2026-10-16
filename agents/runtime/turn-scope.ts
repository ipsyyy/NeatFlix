import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The case and scene of the authenticated handoff a turn is acting on. The
 * adapter sets it from the message the handoff gate accepted (authenticated
 * sender, fresh timestamp, valid envelope), and it follows every await in that
 * turn, including tool handlers. Tool arguments can never set or change it.
 */
export type TurnScope = Readonly<{ caseId: string; sceneId: string }>;

const storage = new AsyncLocalStorage<TurnScope | null>();

export function runInTurnScope<T>(scope: TurnScope | null, fn: () => T): T {
  return storage.run(scope ? Object.freeze({ ...scope }) : null, fn);
}

/** The current turn's authenticated scope, or null outside a scoped turn. */
export function currentTurnScope(): TurnScope | null {
  return storage.getStore() ?? null;
}

/** The case and scene a handoff concerns: a placement plan's scene, a review's subject, or a match's scene. */
export function handoffScope(value: unknown): TurnScope | null {
  if (typeof value !== "object" || value === null) return null;
  const h = value as Record<string, unknown>;
  if (typeof h.caseId !== "string") return null;
  const artifact = h.artifact as Record<string, unknown> | undefined;
  const fromArtifact = (artifact?.scene as Record<string, unknown> | undefined)?.sceneId ?? (artifact?.subject as Record<string, unknown> | undefined)?.sceneId;
  if (typeof fromArtifact === "string") return { caseId: h.caseId, sceneId: fromArtifact };
  const match = typeof h.artifactId === "string" ? /^match:[a-z0-9-]+:([a-z0-9-]+)$/.exec(h.artifactId) : null;
  return match ? { caseId: h.caseId, sceneId: match[1] } : null;
}
