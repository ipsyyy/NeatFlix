import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_REGISTRY,
  AGENT_ROLES,
  ANTHROPIC_KEY_ENV,
  BAND_URL_ENV,
  type AgentRole,
} from "./roles";

export type Env = Record<string, string | undefined>;

/**
 * Configuration error that only ever names environment variables.
 * Messages are built from variable names, never from values.
 */
export class ConfigError extends Error {
  readonly variables: string[];
  constructor(message: string, variables: string[]) {
    super(message);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

export type RoleCredentials = {
  role: AgentRole;
  agentId: string;
  apiKey: string;
};

export type BandUrls = { restUrl?: string; wsUrl?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads `.env.local` into process.env when present (local development).
 * On hosted runtimes the platform supplies variables and the file is absent.
 * Contents are never read back or printed here.
 */
export function loadLocalEnv(file = ".env.local"): boolean {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

function present(env: Env, name: string): string | null {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : null;
}

/** Names of any required variables that are missing for the given roles. */
export function findMissingVariables(env: Env, roles: readonly AgentRole[] = AGENT_ROLES): string[] {
  const missing: string[] = [];
  for (const role of roles) {
    const { agentId, apiKey } = AGENT_REGISTRY[role].env;
    if (!present(env, agentId)) missing.push(agentId);
    if (!present(env, apiKey)) missing.push(apiKey);
  }
  return missing;
}

/** Reads one role's credentials, failing with only the variable name when something is wrong. */
export function readRoleCredentials(env: Env, role: AgentRole): RoleCredentials {
  const names = AGENT_REGISTRY[role].env;
  const agentId = present(env, names.agentId);
  if (!agentId) throw new ConfigError(`Missing required environment variable: ${names.agentId}`, [names.agentId]);
  const apiKey = present(env, names.apiKey);
  if (!apiKey) throw new ConfigError(`Missing required environment variable: ${names.apiKey}`, [names.apiKey]);
  if (!UUID.test(agentId)) {
    throw new ConfigError(`${names.agentId} is not a valid agent UUID`, [names.agentId]);
  }
  return { role, agentId, apiKey };
}

/** Reads all five roles, reporting every missing variable name at once. */
export function readAllCredentials(env: Env): RoleCredentials[] {
  const missing = findMissingVariables(env);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`, missing);
  }
  return AGENT_ROLES.map((role) => readRoleCredentials(env, role));
}

/** Optional BAND endpoints. Invalid URLs fail by variable name only. */
export function readBandUrls(env: Env): BandUrls {
  const urls: BandUrls = {};
  for (const [key, name] of Object.entries(BAND_URL_ENV) as [keyof BandUrls, string][]) {
    const value = present(env, name);
    if (!value) continue;
    try {
      new URL(value);
    } catch {
      throw new ConfigError(`${name} is not a valid URL`, [name]);
    }
    urls[key] = value;
  }
  return urls;
}

export function readAnthropicKey(env: Env): string {
  const key = present(env, ANTHROPIC_KEY_ENV);
  if (!key) throw new ConfigError(`Missing required environment variable: ${ANTHROPIC_KEY_ENV}`, [ANTHROPIC_KEY_ENV]);
  return key;
}

/** Every secret value currently configured, for redaction. Never logged itself. */
export function collectSecrets(env: Env): string[] {
  const names = [...AGENT_ROLES.map((r) => AGENT_REGISTRY[r].env.apiKey), ANTHROPIC_KEY_ENV, "SUPABASE_SECRET_KEY", "GEMINI_API_KEY", "REACTOR_API_KEY", "RUNWAYML_API_SECRET", "MASKY_API_KEY", "LANGSMITH_API_KEY"];
  return names.map((n) => present(env, n)).filter((v): v is string => v !== null);
}
