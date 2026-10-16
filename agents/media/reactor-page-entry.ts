/**
 * Browser entry bundled for the headless page that runs the one Orbis session.
 * It receives only a session-scoped JWT (never the API key), runs the session
 * once, and returns the outcome to the controlling Node process. A second call
 * is refused, so the page can never start another session. If the controller
 * must give up, __nfAbort ends the session (non-recoverable) and returns the
 * live report; reports never carry the token or media.
 */
import { downloadClipAsFile, Reactor, type Clip } from "@reactor-team/js-sdk";
import { ORBIS_MODEL, runOrbisSession, type ReactorLike, type SessionParams, type SessionReport } from "./reactor-session";

type PageParams = Omit<SessionParams, "image"> & { imageBase64: string };

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

let used = false;
let reactor: ReactorLike | null = null;
let live: SessionReport | null = null;

async function run(params: PageParams) {
  if (used) return { ok: false, stage: "page", error: "This page already ran its one session." };
  used = true;
  const { imageBase64, ...rest } = params;
  const image = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
  reactor = new Reactor({ modelName: ORBIS_MODEL }) as unknown as ReactorLike;
  // After the session closes, the clip is fetched with the SDK's standalone download (no live session needed).
  const download = (clip: Parameters<typeof downloadClipAsFile>[0] | object, o: { jwt: string; signal: AbortSignal }) => downloadClipAsFile(clip as Clip, null, o);
  const outcome = await runOrbisSession(reactor, { ...rest, image }, () => performance.now(), (r) => (live = r), () => Date.now(), download);
  if (!outcome.ok) return outcome;
  const { video, ...report } = outcome;
  return { ...report, videoBase64: toBase64(video) };
}

/** Ends the session now (non-recoverable) and returns what the session recorded so far. */
async function abort() {
  if (reactor) await Promise.race([reactor.disconnect(false).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  if (live && live.timings.disconnectedMs === null) {
    live.timings.disconnectedMs = performance.now();
    live.timings.disconnectedEpochMs = Date.now();
  }
  return live ? JSON.parse(JSON.stringify(live)) : null;
}

const g = globalThis as unknown as { __nfRunOrbis: typeof run; __nfAbort: typeof abort };
g.__nfRunOrbis = run;
g.__nfAbort = abort;
