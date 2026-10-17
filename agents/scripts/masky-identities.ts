/**
 * Bounded Masky identity run for the five NativeFrame agents.
 *
 * Preflight (default): validates the five identity specs, renders the five
 * portraits locally (nothing stored), checks that a Masky key is configured
 * (never printed) and that no identity is already recorded, and prints the
 * planned calls, expected outputs, and estimated cost. It makes no network
 * request at all.
 *
 * Generate (only with --generate=nativeframe-agent-identities-v1): one pass,
 * stopping at the first failure: list Masky voices; per agent, store the
 * portrait privately; reuse the avatar recorded in the append-only avatar
 * ledger, or create one (not publicly renderable) from a 5-minute portrait
 * handoff URL and record its id in the ledger before any later request;
 * request the one spoken line verbatim, download the result server-side,
 * validate it, and store it privately. Writes the safe-metadata manifest
 * (identifiers only) only when all five identities complete and validate;
 * otherwise every agent keeps its local fallback.
 *
 * Adopt (only with --adopt=<role> --voice-id=<id> --voice-name=<name>): one
 * read-only GET /avatars; records the single avatar whose display name is
 * exactly the role's in the ledger, so a batch reuses it. Zero or several
 * matches: nothing is recorded. Creates, changes, or deletes nothing.
 *
 * Starts no agent and touches no case, plan, media, review, or approval record.
 *
 * Run (preflight): npm run agents:masky-identities
 * Run (generate):  npm run agents:masky-identities -- --generate=nativeframe-agent-identities-v1 [--voices=<role>=<voiceId>,...]
 * Run (adopt):     npm run agents:masky-identities -- --adopt=<role> --voice-id=<voiceId> --voice-name="<name>"
 * Run (voices):    npm run agents:masky-identities -- --list-voices   (one read-only GET /voices)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { createMaskyClientFromEnv, MASKY_API_KEY_ENV, MASKY_KEY_FORMAT, safeVoiceLines } from "@/agents/masky/client";
import { avatarDisplayName, downloadProviderMedia, EMPTY_MANIFEST, estimateCredits, ffprobeMedia, generateIdentities, validateManifest, type IdentityManifest, type ReusedAvatar } from "@/agents/masky/generate";
import { AGENT_IDENTITIES, estimateSpeechSeconds, identitySpecSha256, portraitSvg, validateIdentities } from "@/agents/masky/identities";
import { avatarsByRole, FileAvatarLedger, findAvatarByDisplayName } from "@/agents/masky/ledger";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const GENERATE_TOKEN = "nativeframe-agent-identities-v1";
const MANIFEST_PATH = resolve(process.cwd(), "agents/masky/generated-identities.json");
/** Append-only record of every avatar created or adopted (agents/masky/ledger.ts). */
const LEDGER_PATH = resolve(process.cwd(), "agents/masky/avatar-ledger.jsonl");
const MAX_POLLS = 48;
const POLL_MS = 5_000;

const renderPng = async (svg: string) => new Uint8Array(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function readManifest(): IdentityManifest {
  if (!existsSync(MANIFEST_PATH)) return EMPTY_MANIFEST;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as IdentityManifest;
}

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);
  const out = (s: string) => console.log(redactSecrets(s, secrets));
  // List voices (read-only): exactly one GET /voices, nothing else read, written, or called.
  if (process.argv.includes("--list-voices")) {
    if (process.argv.slice(2).some((a) => a !== "--list-voices")) return (out("--list-voices takes no other arguments. Nothing was done."), 1);
    const masky = createMaskyClientFromEnv(process.env);
    if (!masky) return (out("Masky is not configured. Nothing was done."), 1);
    const lines = safeVoiceLines(await masky.listVoices());
    out(`Masky voices (${lines.length}): name | id | source`);
    for (const l of lines) out(`  ${l}`);
    out("Read-only: one GET /voices; no avatar, speech, manifest, ledger, or storage change.");
    return 0;
  }
  const generate = process.argv.find((a) => a.startsWith("--generate="))?.slice("--generate=".length);
  if (generate !== undefined && generate !== GENERATE_TOKEN) return (out(`--generate must be exactly ${GENERATE_TOKEN}. Nothing was done.`), 1);
  const voiceArg = process.argv.find((a) => a.startsWith("--voices="))?.slice("--voices=".length);
  const voiceOverrides: Partial<Record<AgentRole, string>> = {};
  for (const pair of voiceArg ? voiceArg.split(",") : []) {
    const [role, id] = pair.split("=");
    if (!(AGENT_ROLES as readonly string[]).includes(role) || !id) return (out(`Invalid --voices entry "${pair}". Nothing was done.`), 1);
    voiceOverrides[role as AgentRole] = id;
  }

  // 1. Specs, portraits, configuration, and existing records (no network).
  const specErrors = validateIdentities();
  if (specErrors.length > 0) return (out(`Identity specs are invalid: ${specErrors.join(" ")}`), 1);
  const existing = readManifest();
  const manifestErrors = validateManifest(existing);
  if (manifestErrors.length > 0) return (out(`The recorded manifest is invalid: ${manifestErrors.join(" ")}`), 1);
  const recorded = Object.keys(existing.entries);
  const ledger = new FileAvatarLedger(LEDGER_PATH);
  const avatars = avatarsByRole(ledger.read());
  if (!avatars.ok) return (out(`The avatar ledger cannot be used: ${avatars.errors.join(" ")}`), 1);
  for (const [role, e] of Object.entries(avatars.value)) {
    if (e!.specSha256 !== identitySpecSha256(AGENT_IDENTITIES[role as AgentRole])) return (out(`${role}: the recorded avatar was made for a different identity spec. Nothing was done.`), 1);
  }
  const reuse: Partial<Record<AgentRole, ReusedAvatar>> = Object.fromEntries(Object.entries(avatars.value).map(([r, e]) => [r, { maskyAvatarId: e!.maskyAvatarId, voiceId: e!.voice.id }]));
  const key = process.env[MASKY_API_KEY_ENV]?.trim() ?? "";
  out(`Masky key (${MASKY_API_KEY_ENV}): ${key ? (MASKY_KEY_FORMAT.test(key) ? "configured, format ok" : "configured, UNEXPECTED FORMAT") : "MISSING"}; Supabase private storage: ${createPrivateStorageFromEnv(process.env) ? "configured" : "MISSING"}.`);
  out(`Recorded identities (live manifest): ${recorded.length === 0 ? "none" : recorded.join(", ")}`);
  out(`Recorded avatars (ledger): ${Object.keys(avatars.value).length === 0 ? "none" : Object.entries(avatars.value).map(([r, e]) => `${r}=${e!.maskyAvatarId} (${e!.event}, voice ${e!.voice.name})`).join("; ")}\n`);

  const adopt = process.argv.find((a) => a.startsWith("--adopt="))?.slice("--adopt=".length);
  if (adopt !== undefined) {
    const voiceId = process.argv.find((a) => a.startsWith("--voice-id="))?.slice("--voice-id=".length) ?? "";
    const voiceName = process.argv.find((a) => a.startsWith("--voice-name="))?.slice("--voice-name=".length) ?? "";
    if (!(AGENT_ROLES as readonly string[]).includes(adopt) || !voiceId || !voiceName) return (out("Adopt needs --adopt=<role> --voice-id=<id> --voice-name=<name>. Nothing was done."), 1);
    const role = adopt as AgentRole;
    if (avatars.value[role]) return (out(`${role} already has a recorded avatar. Nothing was done.`), 1);
    const masky = createMaskyClientFromEnv(process.env);
    if (!masky) return (out("Masky is not configured. Nothing was done."), 1);
    const displayName = avatarDisplayName(AGENT_IDENTITIES[role]);
    const found = findAvatarByDisplayName(await masky.listAvatars(), displayName);
    if (!found.ok) return (out(`${found.error} Nothing was recorded.`), 1);
    await ledger.append({ event: "avatar-adopted", role, maskyAvatarId: found.avatarId, displayName, voice: { id: voiceId, name: voiceName }, specSha256: identitySpecSha256(AGENT_IDENTITIES[role]), source: "GET /avatars, exact display-name match; voice as selected by the creating run", at: new Date().toISOString() });
    out(`Adopted ${role} avatar ${found.avatarId} ("${displayName}", voice ${voiceName}) into agents/masky/avatar-ledger.jsonl. The next batch reuses it.`);
    return 0;
  }

  let total = 0;
  for (const role of AGENT_ROLES) {
    const i = AGENT_IDENTITIES[role];
    const png = await renderPng(portraitSvg(i));
    const meta = await sharp(Buffer.from(png)).metadata();
    const credits = estimateCredits(i);
    total += credits;
    out(`${i.prominence === "primary" ? "★ " : "  "}${i.title} — ${i.characterName}${i.prominence === "primary" ? " (primary identity: gold frame, talking-head video)" : ""}`);
    out(`    personality: ${i.personality}`);
    out(`    voice preference: ${i.voiceHints.join(", ")} (resolved from Masky's preset list at generation)`);
    out(`    portrait: local ${meta.width}×${meta.height} PNG, sha256 ${sha256(png)}`);
    out(`    spoken ${i.spokenOutput}: "${i.spokenLine}" (~${estimateSpeechSeconds(i.spokenLine)} s, est. ${credits} credits)`);
  }
  out(
    [
      "",
      "Planned calls for one generation run (stops at the first failure):",
      `  Masky: GET /voices ×1; POST /avatars for each of the ${AGENT_ROLES.length - Object.keys(reuse).length} agent(s) without a recorded avatar (each recorded in the ledger before its next request); per agent POST /avatars/{id}/speak ×1 and GET /avatars/speak/{id} ≤48 polls (5 s apart); one server-side download of each result.`,
      "  Supabase Storage: per agent one private portrait upload (an identical existing portrait is reused), one 5-minute portrait handoff URL only for a new avatar, one private spoken-media upload.",
      "  No Claude, BAND, Gemini, Reactor, or LangSmith call; no case, plan, media, review, or approval record is touched.",
      "Expected outputs: 5 Masky avatars (not publicly renderable), 5 private portraits (storage://nf-media/agents/portraits/<role>-v1.png),",
      "  4 private audio results and 1 private talking-head video (storage://nf-media/agents/spoken/<role>-v1.<ext>), and agents/masky/generated-identities.json (identifiers and checksums only).",
      `Estimated cost: ${Math.round(total * 10_000) / 10_000} credits (≈ $${total.toFixed(2)}) for speech at Masky's published rates; avatar creation is not priced in Masky's docs.`,
      "Masky keeps its own copies (avatar images, speech results with unguessable share links); its docs offer no private option or deletion for these.",
    ].join("\n"),
  );

  if (generate === undefined) {
    out(`\nPreflight only: no network request was made. To generate: --generate=${GENERATE_TOKEN}`);
    return 0;
  }
  if (recorded.length > 0) return (out("All identities are already recorded; this run never creates a second batch. Nothing was done."), 1);
  const masky = createMaskyClientFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!masky || !storage) return (out("Masky or Supabase is not configured. Nothing was done."), 1);

  const result = await generateIdentities(
    { masky, ledger, storage, renderPng, download: (url) => downloadProviderMedia(url), probe: ffprobeMedia, pollIntervalMs: POLL_MS, maxPolls: MAX_POLLS, log: (l) => out(`  ${l}`) },
    { existing, voiceOverrides, reuse },
  );
  if (result.voices) out(`\nVoices: ${AGENT_ROLES.map((r) => `${r}=${result.voices![r].name} (${result.voices![r].id})`).join("; ")}`);
  const complete = !result.failed && result.completed.length === AGENT_ROLES.length && validateManifest(result.manifest).length === 0;
  if (!complete) {
    out(`STOPPED${result.failed ? ` at ${result.failed.role} (${result.failed.stage}): ${result.failed.error}` : ": the batch did not validate."}`);
    out("The batch is incomplete: no live manifest was written, and all five agents keep the local fallback portrait and caption. Every avatar created is recorded in agents/masky/avatar-ledger.jsonl.");
    return 1;
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(result.manifest, null, 2)}\n`);
  out("All five identities were created, validated, and stored privately; wrote agents/masky/generated-identities.json.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`masky-identities failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
