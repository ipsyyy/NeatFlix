/**
 * Prepares the local demo: builds the verified, read-only demo snapshot of
 * case NF-DEMO-0001 (agents/demo/build-snapshot.ts) into the git-ignored
 * .demo/ directory. Reads Supabase and private storage only; creates or
 * changes no record and calls no provider. If Supabase is unavailable, a
 * still-valid earlier snapshot is kept, or the demo shows placeholders.
 *
 * Run: npm run demo:snapshot
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectSecrets, loadLocalEnv } from "@/agents/config/env";
import { buildDemoSnapshot, type RecordedChecks } from "@/agents/demo/build-snapshot";
import { avatarsByRole, FileAvatarLedger, speechByRole } from "@/agents/masky/ledger";
import { createPrivateStorageFromEnv } from "@/agents/persistence/private-storage";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { redactSecrets, safeErrorMessage } from "@/agents/security/redact";
import { validateDemoSnapshot } from "@/lib/demo/snapshot";

const DIR = resolve(process.cwd(), ".demo");
const MEDIA = join(DIR, "media");

function existingSnapshotIsValid(): boolean {
  try {
    return validateDemoSnapshot(JSON.parse(readFileSync(join(DIR, "snapshot.json"), "utf8"))).length === 0;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  loadLocalEnv();
  const out = (s: string) => console.log(redactSecrets(s, collectSecrets(process.env)));
  const store = createWorkflowStoreFromEnv(process.env);
  const storage = createPrivateStorageFromEnv(process.env);
  const fallback = (why: string) => {
    out(`Demo snapshot not refreshed: ${why}`);
    out(existingSnapshotIsValid() ? "Using the existing verified snapshot in .demo/." : "No snapshot is available: the demo page will show placeholders.");
    return 0;
  };
  if (!store || !storage) return fallback("Supabase is not configured.");

  const events = new FileAvatarLedger(resolve(process.cwd(), "agents/masky/avatar-ledger.jsonl")).read();
  const avatars = avatarsByRole(events);
  const curator = avatars.ok ? avatars.value["content-curator"] : undefined;
  const job = speechByRole(events)["content-curator"];
  let recordedChecks: RecordedChecks = null;
  try {
    recordedChecks = JSON.parse(readFileSync(join(DIR, "checks.json"), "utf8")) as RecordedChecks;
  } catch {
    recordedChecks = null;
  }
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();

  let built: Awaited<ReturnType<typeof buildDemoSnapshot>>;
  try {
    built = await buildDemoSnapshot({
      store,
      storage,
      commit,
      now: () => new Date(),
      ledger: curator && job ? { avatarId: curator.maskyAvatarId, voiceName: curator.voice.name, speechJobId: job.maskyGenerationId } : null,
      recordedChecks,
    });
  } catch (error) {
    return fallback(safeErrorMessage(error, collectSecrets(process.env)));
  }
  if (!built.ok) return fallback(built.errors.join(" "));

  mkdirSync(MEDIA, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of built.files) {
    writeFileSync(join(MEDIA, `${file}.tmp`), bytes, { mode: 0o600 });
    renameSync(join(MEDIA, `${file}.tmp`), join(MEDIA, file));
  }
  for (const f of readdirSync(MEDIA)) if (!built.files.has(f)) rmSync(join(MEDIA, f), { force: true });
  writeFileSync(join(DIR, "snapshot.json.tmp"), `${JSON.stringify(built.snapshot, null, 2)}\n`, { mode: 0o600 });
  renameSync(join(DIR, "snapshot.json.tmp"), join(DIR, "snapshot.json"));

  const s = built.snapshot;
  out(`Demo snapshot ready (.demo/): case ${s.case.caseId} ${s.case.status}; ${s.media.filter((m) => m.verified).length}/${s.media.length} media verified by sha256; commit ${s.commit}.`);
  for (const r of s.reliability) out(`  [${r.kind}] ${r.outcome.padEnd(13)} ${r.label}`);
  if (!existsSync(join(DIR, "checks.json"))) out("Tip: run npm run demo:verify once to record test, lint, typecheck, audit, and secret-scan results for the demo.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`demo-snapshot failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(0);
  },
);
