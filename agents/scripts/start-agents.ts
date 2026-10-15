/**
 * Starts all five NativeFrame agents as persistent BAND WebSocket connections
 * in one process. Ctrl+C (SIGINT) or SIGTERM stops every agent cleanly.
 *
 * Run: npm run agents:start
 * Bounded startup check: npm run agents:start -- --check  (starts, reports, stops)
 *
 * Starting the runtime does not mean agents have collaborated: they act only
 * when real messages arrive in BAND rooms they belong to.
 */
import {
  collectSecrets,
  ConfigError,
  loadLocalEnv,
  readAllCredentials,
  readAnthropicKey,
  readBandUrls,
} from "@/agents/config/env";
import { AGENT_MODEL } from "@/agents/config/model";
import { AGENT_REGISTRY } from "@/agents/config/roles";
import { createWorkflowStoreFromEnv } from "@/agents/persistence/supabase-store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { createNativeFrameAgents, type NativeFrameAgent } from "@/agents/runtime/create-agents";
import { createRedactingLogger, safeErrorMessage } from "@/agents/security/redact";

const STOP_TIMEOUT_MS = 10_000;
const CHECK_HOLD_MS = 5_000;

const checkOnly = process.argv.includes("--check");
const debug = process.argv.includes("--debug");

async function stopAll(agents: NativeFrameAgent[], secrets: string[]): Promise<boolean> {
  const results = await Promise.allSettled(agents.map(({ agent }) => agent.stop(STOP_TIMEOUT_MS)));
  let clean = true;
  results.forEach((r, i) => {
    const name = AGENT_REGISTRY[agents[i].role].displayName;
    if (r.status === "rejected") {
      clean = false;
      console.error(`  ${name.padEnd(20)} stop failed: ${safeErrorMessage(r.reason, secrets)}`);
    } else {
      console.log(`  ${name.padEnd(20)} stopped${r.value ? "" : " (timed out)"}`);
      if (!r.value) clean = false;
    }
  });
  return clean;
}

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);

  // Persistent workflow registry when Supabase is configured; otherwise nothing is persisted.
  const store = createWorkflowStoreFromEnv(process.env);
  console.log(store ? "Workflow registry: Supabase (server-only)" : "Workflow registry: not configured; nothing is persisted and no previews exist");

  let agents: NativeFrameAgent[];
  try {
    agents = createNativeFrameAgents({
      ...(store ? { workflow: new WorkflowRegistry(store) } : {}),
      credentials: readAllCredentials(process.env),
      urls: readBandUrls(process.env),
      anthropicApiKey: readAnthropicKey(process.env),
      loggerFor: (role) => createRedactingLogger(role, secrets, { debug }),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  console.log(`Starting ${agents.length} NativeFrame agents on BAND (model: ${AGENT_MODEL})\n`);
  const started = await Promise.allSettled(agents.map(({ agent }) => agent.start()));
  started.forEach((r, i) => {
    const { role, agent } = agents[i];
    const name = AGENT_REGISTRY[role].displayName.padEnd(20);
    console.log(
      r.status === "fulfilled"
        ? `  ${name} ${agent.state.status}`
        : `  ${name} failed: ${safeErrorMessage(r.reason, secrets)}`,
    );
  });
  const allRunning = started.every((r) => r.status === "fulfilled");

  if (!allRunning || checkOnly) {
    if (checkOnly && allRunning) {
      console.log(`\nAll agents connected. Holding ${CHECK_HOLD_MS / 1000}s, then stopping (--check).`);
      await new Promise((resolve) => setTimeout(resolve, CHECK_HOLD_MS));
      const stillRunning = agents.filter(({ agent }) => agent.state.status !== "running");
      if (stillRunning.length > 0) {
        console.error(`\nNot running after hold: ${stillRunning.map((a) => a.role).join(", ")}`);
      }
      console.log("\nStopping agents");
      const clean = await stopAll(agents, secrets);
      return stillRunning.length === 0 && clean ? 0 : 1;
    }
    console.error("\nNot every agent started. Stopping the rest.");
    await stopAll(agents, secrets);
    return 1;
  }

  console.log("\nAll agents connected and listening. Press Ctrl+C to stop.");
  return await new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal} received. Stopping agents`);
      const clean = await stopAll(agents, secrets);
      resolve(clean ? 0 : 1);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Agent runtime failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
