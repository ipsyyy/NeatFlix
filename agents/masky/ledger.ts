import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";

/**
 * Append-only record of every Masky avatar NativeFrame has created or
 * adopted. Masky documents no avatar deletion, so an avatar ID is written here
 * immediately after creation, before any later request: a later failure can
 * never leave an avatar unrecorded. A batch reuses recorded avatars instead
 * of creating new ones. Lines are never rewritten. Identifiers only.
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

export interface AvatarLedger {
  append(event: AvatarLedgerEvent): Promise<void>;
}

const MASKY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const UNSAFE = /https?:|www\.|mky_|sb_secret_|sk-ant-|token=|key=/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function ledgerEventErrors(e: unknown): string[] {
  if (!isObj(e)) return ["Ledger event is malformed."];
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
export function avatarsByRole(events: readonly AvatarLedgerEvent[]): { ok: true; value: Partial<Record<AgentRole, AvatarLedgerEvent>> } | { ok: false; errors: string[] } {
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

/** The single avatar with exactly this display name, or why none can be chosen (never guesses). */
export function findAvatarByDisplayName(avatars: readonly { avatarId: string; displayName?: string | null }[], displayName: string): { ok: true; avatarId: string } | { ok: false; error: string } {
  const matches = avatars.filter((a) => a.displayName === displayName);
  if (matches.length === 1 && MASKY_ID.test(matches[0].avatarId)) return { ok: true, avatarId: matches[0].avatarId };
  return { ok: false, error: `${matches.length} avatars are named "${displayName}"; exactly one is required.` };
}

/** The ledger as a local JSON-lines file, appended with fsync and never rewritten. */
export class FileAvatarLedger implements AvatarLedger {
  constructor(private readonly path: string) {}

  read(): AvatarLedgerEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((line, i) => {
        const e = JSON.parse(line) as unknown;
        const errors = ledgerEventErrors(e);
        if (errors.length > 0) throw new Error(`Avatar ledger line ${i + 1} is invalid: ${errors.join(" ")}`);
        return e as AvatarLedgerEvent;
      });
  }

  async append(event: AvatarLedgerEvent): Promise<void> {
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
