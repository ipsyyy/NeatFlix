/**
 * Safely closes one message queued for a NativeFrame agent, without starting the
 * agent or passing the message to Claude. Closes it only if that agent's handoff
 * gate would reject it; a message the agent would legitimately accept is left alone.
 *
 * Run: npm run agents:close-queued -- --role=campaign-matcher --room-id=<id> --message-id=<id>
 */
import { bandClientFor } from "@/agents/band/case-room";
import { closeIfRejected } from "@/agents/band/queue";
import { collectSecrets, loadLocalEnv, readAllCredentials, readBandUrls } from "@/agents/config/env";
import { isAgentRole } from "@/agents/config/roles";
import { safeErrorMessage } from "@/agents/security/redact";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]?.trim() ?? "";
const UUID = /^[0-9a-f-]{36}$/;

async function main(): Promise<number> {
  loadLocalEnv();
  const role = arg("role");
  const roomId = arg("room-id");
  const messageId = arg("message-id");
  if (!isAgentRole(role) || !UUID.test(roomId) || !UUID.test(messageId)) {
    console.error("Usage: --role=<agent role> --room-id=<uuid> --message-id=<uuid>");
    return 1;
  }
  const credentials = readAllCredentials(process.env);
  const urls = readBandUrls(process.env);
  const creds = credentials.find((c) => c.role === role)!;
  const client = bandClientFor(creds, urls);
  const status = async () => {
    const out: string[] = [];
    for (const s of ["pending", "processing", "processed", "failed"]) {
      const r = await client.agentApiMessages.listAgentMessages(roomId, { status: s as never, page: 1, page_size: 50 });
      out.push(`${s}=${r.data.some((m) => m.id === messageId) ? "yes" : "no"}`);
    }
    return out.join(" ");
  };
  console.log(`${role} status of ${messageId} before: ${await status()}`);
  const result = await closeIfRejected({
    client,
    roomId,
    messageId,
    role,
    roleByAgentId: new Map(credentials.map((c) => [c.agentId, c.role] as const)),
  });
  console.log(result.closed ? `closed (gate would reject: ${result.reasons.join("; ")})` : `not closed: ${result.reason}`);
  console.log(`${role} status of ${messageId} after:  ${await status()}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`close-queued failed: ${safeErrorMessage(error, collectSecrets(process.env))}`);
    process.exit(1);
  },
);
