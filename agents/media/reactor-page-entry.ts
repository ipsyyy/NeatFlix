/**
 * Browser entry bundled for the headless page that runs the one Orbis session.
 * It receives only a session-scoped JWT (never the API key), runs the session
 * once, and returns the outcome to the controlling Node process. A second call
 * is refused, so the page can never start another session.
 */
import { Reactor } from "@reactor-team/js-sdk";
import { ORBIS_MODEL, runOrbisSession, type ReactorLike, type SessionParams } from "./reactor-session";

type PageParams = Omit<SessionParams, "image"> & { imageBase64: string };

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

let used = false;

async function run(params: PageParams) {
  if (used) return { ok: false, stage: "page", error: "This page already ran its one session." };
  used = true;
  const { imageBase64, ...rest } = params;
  const image = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
  const reactor = new Reactor({ modelName: ORBIS_MODEL }) as unknown as ReactorLike;
  const outcome = await runOrbisSession(reactor, { ...rest, image }, () => performance.now());
  if (!outcome.ok) return outcome;
  const { video, ...report } = outcome;
  return { ...report, videoBase64: toBase64(video) };
}

(globalThis as unknown as { __nfRunOrbis: typeof run }).__nfRunOrbis = run;
