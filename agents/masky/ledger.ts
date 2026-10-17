import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";

/**
 * Append-only record of every Masky avatar NativeFrame has created or
 * adopted. Masky documents no avatar deletion, so an avatar ID is written here
 * immediately after creation, before any later request: a later failure can
 * never leave an avatar unrecorded. A batch reuses recorded avatars instead
 * of creating new ones. Each speech job id is recorded the same way, right
 * after the request and before any status check, so a later failure never
 * forces a second (charged) request: the recorded job is polled instead. An
 * unrecognized status response is recorded only as redacted structure.
 * Lines are never rewritten. Identifiers only.
 */

export type AvatarLedgerEvent = {
  event: "avatar-created" | "avatar-adopted";
  role: AgentRole;
  maskyAvatarId: string;
  displayName: string;
  voice: { id: string; name: string };
  specSha256: string;
  /** How the avatar became known: the creating request, or the read-only lookup that adopted it. */
  source: string;
  at: string;
};

export type SpeechLedgerEvent = {
  event: "speech-requested";
  role: AgentRole;
  maskyAvatarId: string;
  maskyGenerationId: string;
  output: "audio" | "video";
  /** sha256 hex of the exact spoken text. */
  textSha256: string;
  /** Masky reported the request as a duplicate of an earlier identical one (no second charge). */
  reused: boolean;
  source: string;
  at: string;
};

export type DiagnosticLedgerEvent = {
  event: "speech-status-unrecognized";
  role: AgentRole;
  maskyGenerationId: string;
  /** Field names and value types only (client.describeShape): never values, URLs, media, or tokens. */
  shape: unknown;
  at: string;
};

export type LedgerEvent = AvatarLedgerEvent | SpeechLedgerEvent | DiagnosticLedgerEvent;

export interface AvatarLedger {
  append(event: LedgerEvent): Promise<void>;
}

const MASKY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const UNSAFE = /https?:|www\.|mky_|sb_secret_|sk-ant-|token=|key=/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Leaves of a redacted shape may only be type names. */
function isRedactedShape(v: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (typeof v === "string") return ["string", "number", "boolean", "null", "undefined", "object", "bigint", "symbol", "function", "…"].includes(v);
  if (Array.isArray(v)) return v.length <= 1 && v.every((x) => isRedactedShape(x, depth + 1));
  return isObj(v) && Object.keys(v).length <= 30 && Object.values(v).every((x) => isRedactedShape(x, depth + 1));
}

export function ledgerEventErrors(e: unknown): string[] {
  if (!isObj(e)) return ["Ledger event is malformed."];
  if (e.event === "speech-requested" || e.event === "speech-status-unrecognized") {
    const errors: string[] = [];
    if (!(AGENT_ROLES as readonly unknown[]).includes(e.role)) errors.push("Ledger event names no agent role.");
    if (typeof e.maskyGenerationId !== "string" || !MASKY_ID.test(e.maskyGenerationId)) errors.push("Ledger event has no valid speech job id.");
    if (Number.isNaN(Date.parse(String(e.at)))) errors.push("Ledger event needs a time.");
    if (e.event === "speech-requested") {
      if (typeof e.maskyAvatarId !== "string" || !MASKY_ID.test(e.maskyAvatarId)) errors.push("Ledger event has no valid avatar id.");
      if (e.output !== "audio" && e.output !== "video") errors.push("Ledger event has no valid output.");
      if (typeof e.textSha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.textSha256) || typeof e.reused !== "boolean" || typeof e.source !== "string" || !e.source.trim()) errors.push("Ledger event needs a text hash, reuse flag, and source.");
    } else if (!isRedactedShape(e.shape)) {
      errors.push("A status diagnostic may hold only field names and value types.");
    }
    if (UNSAFE.test(JSON.stringify(e))) errors.push("Ledger events hold identifiers only (no URLs, keys, or tokens).");
    return errors;
  }
  const errors: string[] = [];
  const voice = isObj(e.voice) ? e.voice : {};
  if (e.event !== "avatar-created" && e.event !== "avatar-adopted") errors.push("Unknown ledger event.");
  if (!(AGENT_ROLES as readonly unknown[]).includes(e.role)) errors.push("Ledger event names no agent role.");
  if (typeof e.maskyAvatarId !== "string" || !MASKY_ID.test(e.maskyAvatarId)) errors.push("Ledger event has no valid avatar id.");
  if (typeof voice.id !== "string" || !MASKY_ID.test(voice.id) || typeof voice.name !== "string" || !voice.name.trim()) errors.push("Ledger event has no valid voice.");
  if (typeof e.displayName !== "string" || !e.displayName.trim() || typeof e.source !== "string" || !e.source.trim()) errors.push("Ledger event needs a display name and source.");
  if (typeof e.specSha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.specSha256) || Number.isNaN(Date.parse(String(e.at)))) errors.push("Ledger event needs a spec hash and time.");
  if (UNSAFE.test(JSON.stringify(e))) errors.push("Ledger events hold identifiers only (no URLs, keys, or tokens).");
  return errors;
}

/** One avatar per role: the recorded avatars to reuse, or why the ledger cannot be used. */
export function avatarsByRole(all: readonly LedgerEvent[]): { ok: true; value: Partial<Record<AgentRole, AvatarLedgerEvent>> } | { ok: false; errors: string[] } {
  const events = all.filter((e): e is AvatarLedgerEvent => e.event === "avatar-created" || e.event === "avatar-adopted");
  const byRole: Partial<Record<AgentRole, AvatarLedgerEvent>> = {};
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of events) {
    if (byRole[e.role] && byRole[e.role]!.maskyAvatarId !== e.maskyAvatarId) errors.push(`${e.role}: more than one avatar is recorded.`);
    if (ids.has(e.maskyAvatarId) && byRole[e.role]?.maskyAvatarId !== e.maskyAvatarId) errors.push(`Avatar ${e.maskyAvatarId} is recorded for two roles.`);
    byRole[e.role] ??= e;
    ids.add(e.maskyAvatarId);
  }
  const voices = Object.values(byRole).map((e) => e!.voice.id);
  if (new Set(voices).size !== voices.length) errors.push("Recorded avatars share a voice.");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: byRole };
}

/** The latest recorded speech job per role, to poll instead of requesting speech again. */
export function speechByRole(all: readonly LedgerEvent[]): Partial<Record<AgentRole, SpeechLedgerEvent>> {
  const byRole: Partial<Record<AgentRole, SpeechLedgerEvent>> = {};
  for (const e of all) if (e.event === "speech-requested") byRole[e.role] = e;
  return byRole;
}

/** The single avatar with exactly this display name, or why none can be chosen (never guesses). */
export function findAvatarByDisplayName(avatars: readonly { avatarId: string; displayName?: string | null }[], displayName: string): { ok: true; avatarId: string } | { ok: false; error: string } {
  const matches = avatars.filter((a) => a.displayName === displayName);
  if (matches.length === 1 && MASKY_ID.test(matches[0].avatarId)) return { ok: true, avatarId: matches[0].avatarId };
  return { ok: false, error: `${matches.length} avatars are named "${displayName}"; exactly one is required.` };
}

/** The ledger as a local JSON-lines file, appended with fsync and never rewritten. */
export class FileAvatarLedger implements AvatarLedger {
  constructor(private readonly path: string) {}

  read(): LedgerEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((line, i) => {
        const e = JSON.parse(line) as unknown;
        const errors = ledgerEventErrors(e);
        if (errors.length > 0) throw new Error(`Avatar ledger line ${i + 1} is invalid: ${errors.join(" ")}`);
        return e as LedgerEvent;
      });
  }

  async append(event: LedgerEvent): Promise<void> {
    const errors = ledgerEventErrors(event);
    if (errors.length > 0) throw new Error(errors.join(" "));
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
