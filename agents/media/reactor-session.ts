/**
 * One bounded Visko Orbis Stable session, written against the documented
 * @reactor-team/js-sdk 3.x surface (docs.reactor.inc: visko-orbis-stable
 * schema, prompt guide, recordings, reactor-class). It runs inside the
 * headless browser page and is environment-agnostic so it can be tested with a
 * fake client. It never reconnects, never restarts, never changes the prompt
 * after start, and always ends the session (non-recoverable disconnect).
 *
 * Sequence (I2V ordering from the schema): connect → state snapshot →
 * set_resolution → set_seed → uploadFile → set_image → set_prompt
 * (passthrough) → start → pause after the first frame-bearing chunk, so the
 * run stops after exactly two frame-bearing chunks (the first chunk is a
 * zero-frame warm-up per the prompt guide's runtime caveats) → requestClip
 * covering only the frame-bearing chunks → downloadClipAsFile → disconnect.
 */

export const ORBIS_MODEL = "reactor/visko-orbis-stable";
/** Warm-up chunk plus two frame-bearing chunks. */
export const MAX_CHUNKS = 3;
export const FRAME_CHUNKS = 2;
/** Slack added to the measured frame window when requesting the clip. */
export const CLIP_MARGIN_SECONDS = 0.25;
export const CLIP_MIN_SECONDS = 3;
export const CLIP_MAX_SECONDS = 5;

export type SdkMessage = { type: string; data: unknown };
export type SdkClip = { sessionId: string; kind: string; startMarker: number; endMarker: number; nowMarker: number; predictedReadyAtMs: number; playlistUrl: string };
export type SdkFileRef = { uploadId: string; name: string; mimeType: string; size: number };

/** The subset of the SDK's Reactor class this session uses. */
export interface ReactorLike {
  on(event: string, handler: (...args: never[]) => void): void;
  connect(jwt: string, options?: { autoResumeTracks?: boolean }): Promise<void>;
  disconnect(recoverable?: boolean): Promise<void>;
  sendCommand(command: string, data?: object): Promise<SdkMessage | undefined>;
  uploadFile(file: Blob, options?: { name?: string }): Promise<SdkFileRef>;
  requestClip(durationSeconds: number): Promise<SdkClip>;
  downloadClipAsFile(clip: SdkClip, filename: null, options: { jwt: string }): Promise<Blob>;
  getSessionId(): string | undefined;
  getLastError(): { code?: string; message?: string } | undefined;
}

export type SessionParams = {
  jwt: string;
  image: Uint8Array;
  imageMimeType: "image/png";
  imageName: string;
  prompt: string;
  seed: number;
  resolution: string;
  maxVideoBytes: number;
  timeouts: { connectMs: number; commandMs: number; generationMs: number; clipMs: number; downloadMs: number };
};

export type ChunkRecord = { index: number; framesEmitted: number; audioSamples: number | null; atMs: number };

export type SessionReport = {
  sessionId: string | null;
  commandsSent: string[];
  chunks: ChunkRecord[];
  availableResolutions: string[];
  imageAccepted: { width: number; height: number } | null;
  generation: Record<string, unknown> | null;
  moderation: unknown[];
  timings: { connectStartMs: number; readyMs: number | null; startMs: number | null; pausedMs: number | null; disconnectedMs: number | null };
};

export type SessionOutcome =
  | (SessionReport & {
      ok: true;
      video: Uint8Array;
      videoMimeType: string;
      requestedClipSeconds: number;
      clip: { kind: string; startMarker: number; endMarker: number; nowMarker: number };
    })
  | (SessionReport & { ok: false; stage: string; error: string });

class SessionFailure extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => Number.isInteger(v);

/** Runs the session once. Every failure ends the session and is reported, never retried. */
export async function runOrbisSession(reactor: ReactorLike, p: SessionParams, now: () => number): Promise<SessionOutcome> {
  const report: SessionReport = {
    sessionId: null,
    commandsSent: [],
    chunks: [],
    availableResolutions: [],
    imageAccepted: null,
    generation: null,
    moderation: [],
    timings: { connectStartMs: now(), readyMs: null, startMs: null, pausedMs: null, disconnectedMs: null },
  };
  let failure: SessionFailure | null = null;
  let wake: () => void = () => {};
  const changed = () => wake();
  const fail = (stage: string, message: string) => {
    if (!failure) failure = new SessionFailure(stage, message);
    changed();
  };
  let latestState: Record<string, unknown> | null = null as Record<string, unknown> | null;
  let conditions: Record<string, unknown> | null = null;
  let finished = false;

  /** Resolves when `done()` holds, rejects on any recorded failure or the timeout. */
  const until = (done: () => boolean, ms: number, stage: string, what: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (failure) return (clearTimeout(timer), reject(failure));
        if (done()) return (clearTimeout(timer), resolve());
      };
      const timer = setTimeout(() => reject(failure ?? new SessionFailure(stage, `Timed out waiting for ${what}.`)), ms);
      const prev = wake;
      wake = () => (prev(), check());
      check();
    });
  const bounded = <T>(work: Promise<T>, ms: number, stage: string, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SessionFailure(stage, `Timed out waiting for ${what}.`)), ms);
      // A recorded failure (command_error, dropped connection, moderation) ends the wait at once.
      const prev = wake;
      wake = () => (prev(), failure && (clearTimeout(timer), reject(failure)));
      work.then((v) => (clearTimeout(timer), resolve(v)), (e) => (clearTimeout(timer), reject(new SessionFailure(stage, `${what} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`))));
    });
  const command = async (name: string, data: object, expect: string | null, stage: string): Promise<Record<string, unknown>> => {
    report.commandsSent.push(name);
    const reply = await bounded(reactor.sendCommand(name, data), p.timeouts.commandMs, stage, `the ${name} reply`);
    if (failure) throw failure;
    if (expect === null) return {};
    if (!reply) {
      const last = reactor.getLastError();
      throw new SessionFailure(stage, `${name} was refused${last?.code ? ` (${String(last.code).slice(0, 40)})` : ""}.`);
    }
    if (reply.type !== expect || !isObj(reply.data)) throw new SessionFailure(stage, `${name} replied ${String(reply.type).slice(0, 40)}, expected ${expect}.`);
    return reply.data;
  };

  reactor.on("statusChanged", ((status: string) => {
    if (status === "ready" && report.timings.readyMs === null) report.timings.readyMs = now();
    else if (report.timings.readyMs !== null && status !== "ready" && !finished) fail("connection", `The connection left ready (${String(status).slice(0, 20)}); not reconnecting.`);
    changed();
  }) as never);
  reactor.on("message", ((msg: SdkMessage) => {
    const data = isObj(msg?.data) ? msg.data : {};
    switch (msg?.type) {
      case "state":
        latestState = data;
        break;
      case "conditions_ready":
        conditions = data;
        break;
      case "chunk_complete": {
        const index = data.chunk_index;
        const frames = data.frames_emitted;
        if (!int(index) || !int(frames) || frames < 0) return fail("generation", "Malformed chunk_complete.");
        if (index !== report.chunks.length) return fail("generation", `Chunk ${index} arrived out of order.`);
        if (frames === 0 && index > 0) return fail("generation", `Chunk ${index} emitted no frames after the warm-up.`);
        report.chunks.push({ index, framesEmitted: frames, audioSamples: int(data.audio_samples) ? data.audio_samples : null, atMs: now() });
        if (report.chunks.length > MAX_CHUNKS) return fail("generation", `More than ${MAX_CHUNKS} chunks were generated.`);
        break;
      }
      case "command_error":
        return fail("command", `${String(data.command ?? "command").slice(0, 40)} rejected: ${String(data.reason ?? "").slice(0, 200)}`);
      case "generation_complete":
      case "generation_reset":
        if (!finished) return fail("generation", `Unexpected ${msg.type}.`);
        break;
    }
    changed();
  }) as never);
  reactor.on("runtimeMessage", ((msg: SdkMessage) => {
    if (msg?.type === "moderation") {
      report.moderation.push(msg.data);
      fail("moderation", "The platform raised a content-moderation event.");
    }
  }) as never);

  const frameChunks = () => report.chunks.filter((c) => c.framesEmitted > 0).length;
  try {
    // Connect once; the token can create exactly one session.
    await bounded(reactor.connect(p.jwt, { autoResumeTracks: true }), p.timeouts.connectMs, "connect", "connect");
    await until(() => report.timings.readyMs !== null, p.timeouts.connectMs, "connect", "the session to be ready");
    report.sessionId = reactor.getSessionId() ?? null;
    if (!report.sessionId) throw new SessionFailure("connect", "The SDK reported no session ID.");
    await until(() => latestState !== null, p.timeouts.commandMs, "state", "the state snapshot");
    const offered = (latestState as Record<string, unknown> | null)?.available_resolutions;
    report.availableResolutions = Array.isArray(offered) ? offered.filter((r): r is string => typeof r === "string") : [];
    if (!report.availableResolutions.includes(p.resolution)) throw new SessionFailure("state", `Resolution ${p.resolution} is not offered by this deployment.`);

    const res = await command("set_resolution", { resolution: p.resolution }, "resolution_accepted", "configure");
    if (res.resolution !== p.resolution) throw new SessionFailure("configure", "set_resolution did not accept the requested resolution.");
    await command("set_seed", { seed: p.seed }, null, "configure");

    const ref = await bounded(reactor.uploadFile(new Blob([new Uint8Array(p.image)], { type: p.imageMimeType }), { name: p.imageName }), p.timeouts.commandMs, "upload", "the image upload");
    if (!ref || typeof ref.uploadId !== "string" || ref.size !== p.image.byteLength) throw new SessionFailure("upload", "The upload reference does not match the image.");
    const img = await command("set_image", { image: ref }, "image_accepted", "image");
    if (!int(img.width) || !int(img.height)) throw new SessionFailure("image", "image_accepted carried no dimensions.");
    report.imageAccepted = { width: img.width, height: img.height };
    const echo = await command("set_prompt", { prompt: p.prompt, passthrough: true }, "prompt_accepted", "prompt");
    if (echo.prompt !== p.prompt) throw new SessionFailure("prompt", "The accepted prompt differs from the approved prompt.");
    await until(
      () => conditions?.has_image === true && conditions?.has_prompt === true && (latestState as Record<string, unknown> | null)?.seed === p.seed,
      p.timeouts.commandMs,
      "conditions",
      "image, prompt, and seed to be set",
    );

    // Exactly one start; the prompt is never changed afterwards.
    report.timings.startMs = now();
    const started = await command("start", {}, "generation_started", "start");
    report.generation = started;
    if (started.image_conditioned !== true) throw new SessionFailure("start", "Generation did not start from the approved image.");
    if (started.resolution !== p.resolution) throw new SessionFailure("start", "Generation started at a different resolution.");
    if (!int(started.frames_per_chunk) || started.frames_per_chunk <= 0 || !(typeof started.fps === "number" && started.fps > 0)) throw new SessionFailure("start", "generation_started is malformed.");

    // Pause after the first frame-bearing chunk: the run stops after the next one.
    await until(() => frameChunks() >= 1, p.timeouts.generationMs, "generation", "the first frame-bearing chunk");
    await command("pause", {}, "generation_paused", "pause");
    await until(() => frameChunks() >= FRAME_CHUNKS, p.timeouts.commandMs, "pause", "the final chunk");
    report.timings.pausedMs = now();
    if (frameChunks() !== FRAME_CHUNKS || report.chunks.length > MAX_CHUNKS) throw new SessionFailure("pause", "The run did not stop after exactly two frame-bearing chunks.");
    // The pause reply alone is not trusted: the authoritative state must show generation stopped.
    await until(() => latestState?.paused === true && latestState?.running === false, p.timeouts.commandMs, "pause", "the paused state");

    // Capture only the frame-bearing chunks: from the end of the warm-up (or the start) to now.
    const warmups = report.chunks.filter((c) => c.framesEmitted === 0);
    const windowStart = warmups.length > 0 ? warmups[warmups.length - 1].atMs : report.timings.startMs;
    const seconds = Math.round(((now() - windowStart) / 1000 + CLIP_MARGIN_SECONDS) * 1000) / 1000;
    if (!(seconds >= CLIP_MIN_SECONDS && seconds <= CLIP_MAX_SECONDS)) throw new SessionFailure("capture", `The measured frame window (${seconds} s) is outside ${CLIP_MIN_SECONDS}–${CLIP_MAX_SECONDS} s; not capturing.`);
    const clip = await bounded(reactor.requestClip(seconds), p.timeouts.clipMs, "capture", "the clip request");
    if (!clip || clip.sessionId !== report.sessionId || ![clip.startMarker, clip.endMarker, clip.nowMarker].every(Number.isFinite)) throw new SessionFailure("capture", "The clip does not belong to this session or is malformed.");
    // Confirm generation really stopped: no chunk may arrive for one more chunk's duration.
    const chunksAtCapture = report.chunks.length;
    const quietMs = Math.ceil(((started.frames_per_chunk as number) / (started.fps as number)) * 1000) + 300;
    await new Promise((r) => setTimeout(r, quietMs));
    if (failure) throw failure;
    if (report.chunks.length !== chunksAtCapture) throw new SessionFailure("pause", "Generation continued after the pause; not downloading.");
    const blob = await bounded(reactor.downloadClipAsFile(clip, null, { jwt: p.jwt }), p.timeouts.downloadMs, "download", "the clip download");
    if (!blob || blob.size === 0) throw new SessionFailure("download", "The downloaded clip is empty.");
    if (blob.size > p.maxVideoBytes) throw new SessionFailure("download", "The downloaded clip exceeds the size limit.");
    const video = new Uint8Array(await blob.arrayBuffer());
    if (failure) throw failure;
    finished = true;
    return {
      ...report,
      ok: true,
      video,
      videoMimeType: blob.type || "video/mp4",
      requestedClipSeconds: seconds,
      clip: { kind: clip.kind, startMarker: clip.startMarker, endMarker: clip.endMarker, nowMarker: clip.nowMarker },
    };
  } catch (error) {
    const f = error instanceof SessionFailure ? error : (failure ?? new SessionFailure("session", String((error as Error)?.message ?? error).slice(0, 200)));
    return { ...report, ok: false, stage: f.stage, error: f.message };
  } finally {
    finished = true;
    // Always terminate (non-recoverable): billing stops and nothing can resume it.
    await reactor.disconnect(false).catch(() => {});
    report.timings.disconnectedMs = now();
  }
}
