/**
 * BAND identity diagnostic. For every configured role, calls BAND's
 * authenticated Agent API `/me` through the official SDK and confirms the
 * returned agent ID matches the configured one.
 *
 * Prints only role, agent name/handle, and connected/failed. Never prints
 * keys, agent IDs, headers, or raw responses.
 *
 * Run: npm run agents:check
 */
import { BandLink } from "@band-ai/sdk";
import {
  collectSecrets,
  ConfigError,
  loadLocalEnv,
  readBandUrls,
  readRoleCredentials,
} from "@/agents/config/env";
import { AGENT_REGISTRY, AGENT_ROLES, type AgentRole } from "@/agents/config/roles";
import { createRedactingLogger, safeErrorMessage } from "@/agents/security/redact";

type Outcome =
  | { role: AgentRole; status: "connected"; name: string; handle: string | null }
  | { role: AgentRole; status: "failed"; reason: string };

const REQUEST_OPTIONS = { timeoutInSeconds: 15, maxRetries: 1 };

async function checkRole(role: AgentRole, env: NodeJS.ProcessEnv, secrets: string[]): Promise<Outcome> {
  let credentials;
  let urls;
  try {
    credentials = readRoleCredentials(env, role);
    urls = readBandUrls(env);
  } catch (error) {
    if (error instanceof ConfigError) return { role, status: "failed", reason: error.message };
    throw error;
  }

  try {
    const link = new BandLink({
      agentId: credentials.agentId,
      apiKey: credentials.apiKey,
      ...urls,
      logger: createRedactingLogger(role, secrets),
    });
    const identity = await link.rest.getAgentMe(REQUEST_OPTIONS);
    if (identity.id !== credentials.agentId) {
      return { role, status: "failed", reason: "BAND returned a different agent than the configured agent ID" };
    }
    return { role, status: "connected", name: identity.name, handle: identity.handle ?? null };
  } catch (error) {
    return { role, status: "failed", reason: safeErrorMessage(error, secrets) };
  }
}

async function main(): Promise<number> {
  loadLocalEnv();
  const secrets = collectSecrets(process.env);

  const outcomes = await Promise.all(AGENT_ROLES.map((role) => checkRole(role, process.env, secrets)));

  console.log("BAND identity check (GET /me per agent)\n");
  for (const o of outcomes) {
    const label = AGENT_REGISTRY[o.role].displayName.padEnd(20);
    if (o.status === "connected") {
      const handle = o.handle ? ` (${o.handle})` : "";
      console.log(`  ${label} connected  ${o.name}${handle}`);
    } else {
      console.log(`  ${label} failed     ${o.reason}`);
    }
  }
  const connected = outcomes.filter((o) => o.status === "connected").length;
  console.log(`\n${connected} of ${outcomes.length} identities connected.`);
  return connected === outcomes.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Identity check failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
