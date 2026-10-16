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
 * portrait privately, create one avatar (not publicly renderable) from a
 * 5-minute portrait handoff URL, request the one spoken line verbatim, download
 * the result server-side, validate it, and store it privately. Writes the
 * safe-metadata manifest (identifiers only) only when all five identities
 * complete and validate; a partial batch is recorded separately and every
 * agent keeps its local fallback.
 * Starts no agent and touches no case, plan, media, review, or approval record.
 *
 * Run (preflight): npm run agents:masky-identities
 * Run (generate):  npm run agents:masky-identities -- --generate=nativeframe-agent-identities-v1 [--voices=<role>=<voiceId>,...]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { createMaskyClientFromEnv, MASKY_API_KEY_ENV, MASKY_KEY_FORMAT } from "@/agents/masky/client";
import { downloadProviderMedia, EMPTY_MANIFEST, estimateCredits, ffprobeMedia, generateIdentities, validateManifest, type IdentityManifest } from "@/agents/masky/generate";
import { AGENT_IDENTITIES, estimateSpeechSeconds, portraitSvg, validateIdentities } from "@/agents/masky/identities";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";

const GENERATE_TOKEN = "nativeframe-agent-identities-v1";
const MANIFEST_PATH = resolve(process.cwd(), "agents/masky/generated-identities.json");
/** A partial batch is recorded here (its avatars exist at Masky), never in the live manifest: every agent keeps its fallback. */
const INCOMPLETE_PATH = resolve(process.cwd(), "agents/masky/incomplete-identities.json");
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
  const key = process.env[MASKY_API_KEY_ENV]?.trim() ?? "";
  out(`Masky key (${MASKY_API_KEY_ENV}): ${key ? (MASKY_KEY_FORMAT.test(key) ? "configured, format ok" : "configured, UNEXPECTED FORMAT") : "MISSING"}; Supabase private storage: ${createPrivateStorageFromEnv(process.env) ? "configured" : "MISSING"}.`);
  const incomplete = existsSync(INCOMPLETE_PATH);
  out(`Recorded identities: ${recorded.length === 0 ? "none" : recorded.join(", ")}${incomplete ? "; an INCOMPLETE batch is recorded" : ""}\n`);

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
      "  Masky: GET /voices ×1; per agent POST /avatars ×1, GET /avatars/{id}/images ×1, POST /avatars/{id}/speak ×1, GET /avatars/speak/{id} ≤48 polls (5 s apart); one server-side download of each result.",
      "  Supabase Storage: per agent one private portrait upload, one 5-minute portrait handoff URL (given only to Masky), one private spoken-media upload.",
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
  if (recorded.length > 0 || incomplete) return (out("Identities (or an incomplete batch) are already recorded; this run never creates a second batch. Nothing was done."), 1);
  const masky = createMaskyClientFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  if (!masky || !storage) return (out("Masky or Supabase is not configured. Nothing was done."), 1);

  const result = await generateIdentities(
    { masky, storage, renderPng, download: (url) => downloadProviderMedia(url), probe: ffprobeMedia, pollIntervalMs: POLL_MS, maxPolls: MAX_POLLS, log: (l) => out(`  ${l}`) },
    { existing, voiceOverrides },
  );
  if (result.voices) out(`\nVoices: ${AGENT_ROLES.map((r) => `${r}=${result.voices![r].name} (${result.voices![r].id})`).join("; ")}`);
  const complete = !result.failed && result.completed.length === AGENT_ROLES.length && validateManifest(result.manifest).length === 0;
  if (!complete) {
    if (result.completed.length > 0) {
      writeFileSync(INCOMPLETE_PATH, `${JSON.stringify(result.manifest, null, 2)}\n`);
      out(`Recorded the ${result.completed.length} avatar(s) created before the stop in agents/masky/incomplete-identities.json (not used by the demo).`);
    }
    out(`STOPPED${result.failed ? ` at ${result.failed.role} (${result.failed.stage}): ${result.failed.error}` : ": the batch did not validate."}`);
    out("The batch is incomplete: no live manifest was written, and all five agents keep the local fallback portrait and caption.");
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
