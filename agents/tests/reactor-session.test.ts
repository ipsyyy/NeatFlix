import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIP_MAX_SECONDS, CLIP_MIN_SECONDS, runOrbisSession, type ReactorLike, type SdkClip, type SdkMessage, type SessionParams } from "@/agents/media/reactor-session";

const PROMPT = "Keep the scene as it is; both rebranded cups stay stationary. No camera movement.";
const CHUNK_MS = 1833;

type Scenario = {
  /** Frames per chunk index; the fake keeps generating until paused (or forever when ignorePause). */
  frames?: number[];
  ignorePause?: boolean;
  resolutions?: string[];
  echo?: string;
  refuse?: string;
  commandError?: string;
  dropAfterReady?: boolean;
  moderation?: boolean;
  chunkMs?: number;
  /** Broadcast the documented state snapshot on connect (the live deployment did not). */
  initialState?: boolean;
  /** Never reach ready after connect. */
  neverReady?: boolean;
  /** Never reply to this command. */
  hang?: string;
  /** Acknowledge set_resolution with a different resolution. */
  ackResolution?: string;
};

/** A fake Reactor client that follows the documented Visko Orbis Stable protocol. */
class FakeReactor implements ReactorLike {
  readonly calls: string[] = [];
  readonly commands: { name: string; data: Record<string, unknown> }[] = [];
  connects = 0;
  disconnects: (boolean | undefined)[] = [];
  clipSeconds: number | null = null;
  private handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  private paused = false;
  private chunk = 0;
  private generating = false;
  t = 0;
  constructor(private readonly s: Scenario = {}) {}
  now = () => this.t;
  on(event: string, handler: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as (...a: unknown[]) => void]);
  }
  private emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  private message(type: string, data: unknown) {
    this.emit("message", { type, data } satisfies SdkMessage);
  }
  async connect(jwt: string) {
    this.connects++;
    assert.equal(jwt, "header.payload.signature");
    if (this.s.neverReady) return;
    setImmediate(() => {
      this.emit("statusChanged", "ready");
      if (this.s.initialState ?? true) this.message("state", { available_resolutions: this.s.resolutions ?? ["1080p", "2k", "4k"], seed: 42, has_image: false, has_prompt: false });
      if (this.s.dropAfterReady) setImmediate(() => this.emit("statusChanged", "disconnected"));
      if (this.s.moderation) setImmediate(() => this.emit("runtimeMessage", { type: "moderation", data: { action: "warn" } }));
    });
  }
  async disconnect(recoverable?: boolean) {
    this.disconnects.push(recoverable);
    this.generating = false;
  }
  getSessionId() {
    return this.connects > 0 ? "sess_test_1" : undefined;
  }
  getLastError() {
    return { code: "REFUSED", message: "refused" };
  }
  async uploadFile(file: Blob) {
    this.calls.push("uploadFile");
    return { uploadId: "up_1", name: "edited-still.png", mimeType: file.type, size: file.size };
  }
  private nextChunk() {
    if (!this.generating) return;
    setTimeout(() => {
      if (!this.generating) return;
      const index = this.chunk++;
      this.t += this.s.chunkMs ?? CHUNK_MS;
      const frames = this.s.frames?.[index] ?? (index === 0 ? 0 : 33);
      this.message("chunk_complete", { chunk_index: index, frames_emitted: frames, audio_samples: 88000 });
      if (this.paused && !this.s.ignorePause) {
        this.generating = false;
        this.message("state", { available_resolutions: ["1080p"], seed: 42, paused: true, running: false, current_chunk: index });
        this.pauseResolve?.({ type: "generation_paused", data: { chunk_index: index } });
        return;
      }
      if (this.chunk < 6) this.nextChunk();
    }, 2);
  }
  private pauseResolve: ((m: SdkMessage) => void) | null = null;
  async sendCommand(name: string, data: Record<string, unknown> = {}): Promise<SdkMessage | undefined> {
    this.calls.push(name);
    this.commands.push({ name, data });
    if (this.s.refuse === name) return undefined;
    if (this.s.hang === name) return new Promise(() => {});
    if (this.s.commandError === name) {
      setImmediate(() => this.message("command_error", { command: name, reason: "rejected by test" }));
      return new Promise(() => {});
    }
    switch (name) {
      case "set_resolution": {
        const offered = this.s.resolutions ?? ["1080p", "2k", "4k"];
        if (!offered.includes(String(data.resolution))) {
          // Documented: rejected with command_error naming the offered list; sendCommand resolves undefined.
          setImmediate(() => this.message("command_error", { command: "set_resolution", reason: `resolution '${String(data.resolution)}' is not available; choose one of: ${offered.join(", ")}` }));
          return new Promise((r) => setTimeout(() => r(undefined), 5));
        }
        return { type: "resolution_accepted", data: { width: 832, height: 480, resolution: this.s.ackResolution ?? data.resolution } };
      }
      case "set_seed":
        return undefined;
      case "set_image":
        setImmediate(() => this.message("conditions_ready", { has_image: true, has_prompt: false }));
        return { type: "image_accepted", data: { width: 832, height: 480 } };
      case "set_prompt":
        setImmediate(() => {
          this.message("conditions_ready", { has_image: true, has_prompt: true });
          this.message("state", { available_resolutions: ["1080p"], seed: 42, has_image: true, has_prompt: true });
        });
        return { type: "prompt_accepted", data: { prompt: this.s.echo ?? data.prompt } };
      case "start":
        this.generating = true;
        this.nextChunk();
        return { type: "generation_started", data: { fps: 18, width: 832, height: 480, max_chunks: 2000, resolution: "1080p", audio_enabled: true, frames_per_chunk: 33, image_conditioned: true } };
      case "pause":
        this.paused = true;
        if (this.s.ignorePause) return { type: "generation_paused", data: { chunk_index: this.chunk } };
        return new Promise((resolve) => (this.pauseResolve = resolve));
    }
    return undefined;
  }
  async requestClip(seconds: number): Promise<SdkClip> {
    this.calls.push("requestClip");
    this.clipSeconds = seconds;
    return { sessionId: "sess_test_1", kind: "snap", startMarker: 10 - seconds, endMarker: 10, nowMarker: 10, predictedReadyAtMs: 0, playlistUrl: "https://example.invalid/playlist.m3u8" };
  }
  async downloadClipAsFile(_clip: SdkClip, filename: null, options: { jwt: string }) {
    this.calls.push("downloadClipAsFile");
    assert.equal(filename, null);
    assert.equal(options.jwt, "header.payload.signature");
    return new Blob([new Uint8Array(20_000)], { type: "video/mp4" });
  }
}

const params = (over: Partial<SessionParams> = {}): SessionParams => ({
  jwt: "header.payload.signature",
  image: new Uint8Array([1, 2, 3, 4]),
  imageMimeType: "image/png",
  imageName: "edited-still.png",
  prompt: PROMPT,
  seed: 42,
  resolution: "1080p",
  maxVideoBytes: 64 * 1024 * 1024,
  timeouts: { connectMs: 2000, commandMs: 2000, generationMs: 2000, clipMs: 2000, downloadMs: 2000 },
  ...over,
});

const run = async (s: Scenario = {}, over: Partial<SessionParams> = {}) => {
  const fake = new FakeReactor(s);
  const outcome = await runOrbisSession(fake, params(over), fake.now);
  return { fake, outcome };
};

describe("Orbis session: one bounded run", () => {
  it("runs the documented I2V order once and stops after exactly two frame-bearing chunks", async () => {
    const { fake, outcome } = await run();
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.deepEqual(fake.calls, ["set_resolution", "set_seed", "uploadFile", "set_image", "set_prompt", "start", "pause", "requestClip", "downloadClipAsFile"]);
    assert.equal(fake.connects, 1);
    assert.deepEqual(fake.disconnects, [false], "always one non-recoverable disconnect");
    assert.deepEqual(fake.commands.find((c) => c.name === "set_prompt")?.data, { prompt: PROMPT, passthrough: true });
    assert.equal(fake.commands.filter((c) => c.name === "start").length, 1);
    assert.equal(fake.commands.filter((c) => c.name === "set_prompt").length, 1, "the prompt is never retargeted");
    assert.deepEqual(outcome.chunks.map((c) => c.framesEmitted), [0, 33, 33]);
    assert.ok(fake.clipSeconds! >= CLIP_MIN_SECONDS && fake.clipSeconds! <= CLIP_MAX_SECONDS, `clip ${fake.clipSeconds}`);
    assert.equal(outcome.requestedClipSeconds, 3.916, "two 1.833 s chunks plus the margin");
    assert.equal(outcome.sessionId, "sess_test_1");
    assert.equal(outcome.video.byteLength, 20_000);
    assert.equal(JSON.stringify(outcome).includes("header.payload.signature"), false, "the token is never reported");
  });

  it("fails closed when generation continues after the pause is acknowledged", async () => {
    const { fake, outcome } = await run({ ignorePause: true });
    assert.equal(outcome.ok, false);
    assert.equal(fake.calls.includes("downloadClipAsFile"), false, "nothing is downloaded");
    assert.deepEqual(fake.disconnects, [false]);
  });

  it("fails closed on a zero-frame chunk after the warm-up", async () => {
    const { fake, outcome } = await run({ frames: [0, 0, 33] });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { error: string }).error, /no frames after the warm-up/);
    assert.equal(fake.calls.includes("pause"), false);
  });

  it("fails closed on command_error, a refused command, or a different prompt echo — before start", async () => {
    for (const s of [{ commandError: "set_image" }, { refuse: "set_resolution" }, { echo: "a different prompt" }] satisfies Scenario[]) {
      const { fake, outcome } = await run(s);
      assert.equal(outcome.ok, false, JSON.stringify(s));
      assert.equal(fake.calls.includes("start"), false, `${JSON.stringify(s)} never starts`);
      assert.deepEqual(fake.disconnects, [false]);
    }
  });

  it("starts without waiting for an initial state event, confirming 1080p from the set_resolution acknowledgement", async () => {
    const { fake, outcome } = await run({ initialState: false });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(fake.calls[0], "set_resolution", "resolution is confirmed first, by command");
    assert.deepEqual(fake.commands[0].data, { resolution: "1080p" });
    assert.deepEqual(outcome.resolution, { confirmedBy: "set_resolution reply" });
    assert.equal(outcome.generatedSeconds, 3.667, "66 frames at 18 fps");
  });

  it("fails on a documented resolution rejection, recording the offered alternatives, and sends no generation command", async () => {
    const { fake, outcome } = await run({ initialState: false, resolutions: ["2k", "4k"] });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { stage: string }).stage, "resolution");
    assert.deepEqual(outcome.resolution, { rejected: "resolution '1080p' is not available; choose one of: 2k, 4k", offered: ["2k", "4k"] });
    assert.deepEqual(fake.calls, ["set_resolution"], "no upload, image, prompt, or start");
    assert.deepEqual(fake.disconnects, [false]);
  });

  it("sends no generation command when the resolution cannot be confirmed", async () => {
    for (const s of [{ refuse: "set_resolution" }, { ackResolution: "2k" }, { hang: "set_resolution" }] satisfies Scenario[]) {
      const { fake, outcome } = await run({ initialState: false, ...s }, { timeouts: { connectMs: 2000, commandMs: 60, generationMs: 2000, clipMs: 2000, downloadMs: 2000 } });
      assert.equal(outcome.ok, false, JSON.stringify(s));
      assert.equal((outcome as { stage: string }).stage, "resolution", JSON.stringify(s));
      assert.deepEqual(fake.calls, ["set_resolution"], JSON.stringify(s));
      assert.equal(Boolean(outcome.resolution && "confirmedBy" in outcome.resolution), false, "never recorded as confirmed");
    }
  });

  it("reports a timeout before readiness: never ready, nothing sent, nothing billed", async () => {
    const { fake, outcome } = await run({ neverReady: true }, { timeouts: { connectMs: 40, commandMs: 2000, generationMs: 2000, clipMs: 2000, downloadMs: 2000 } });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { stage: string }).stage, "connect");
    assert.equal(outcome.timings.readyMs, null);
    assert.deepEqual(outcome.commandsSent, []);
    assert.equal(outcome.generatedSeconds, 0);
    assert.deepEqual(fake.disconnects, [false]);
  });

  it("reports a timeout after readiness with the session ID, commands, and close time", async () => {
    const { outcome } = await run({ initialState: false, hang: "set_seed" }, { timeouts: { connectMs: 2000, commandMs: 40, generationMs: 2000, clipMs: 2000, downloadMs: 2000 } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.sessionId, "sess_test_1");
    assert.deepEqual(outcome.commandsSent, ["set_resolution", "set_seed"]);
    assert.equal(typeof outcome.timings.readyMs, "number");
    assert.equal(typeof outcome.timings.disconnectedMs, "number");
    assert.equal(JSON.stringify(outcome).includes("header.payload.signature"), false);
  });

  it("still requires the state checks after configuration: seed and conditions", async () => {
    const fake = new FakeReactor({ initialState: false });
    const original = fake.sendCommand.bind(fake);
    // A deployment that never broadcasts state at all cannot confirm the seed: fail closed before start.
    fake.sendCommand = async (name, data) => (name === "set_prompt" ? { type: "prompt_accepted", data: { prompt: (data as { prompt: string }).prompt } } : original(name, data));
    const outcome = await runOrbisSession(fake, params({ timeouts: { connectMs: 2000, commandMs: 60, generationMs: 2000, clipMs: 2000, downloadMs: 2000 } }), fake.now);
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { stage: string }).stage, "conditions");
    assert.equal(fake.calls.includes("start"), false);
  });

  it("never reconnects when the connection drops", async () => {
    const { fake, outcome } = await run({ dropAfterReady: true });
    assert.equal(outcome.ok, false);
    assert.equal(fake.connects, 1);
    assert.equal(fake.calls.includes("start"), false);
  });

  it("stops on a content-moderation event", async () => {
    const { outcome } = await run({ moderation: true });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { stage: string }).stage, "moderation");
  });

  it("does not capture when the measured frame window would fall outside 3–5 s", async () => {
    const { fake, outcome } = await run({ chunkMs: 3000 });
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { stage: string }).stage, "capture");
    assert.equal(fake.calls.includes("requestClip"), false);
  });

  it("times out instead of waiting forever, and still disconnects", async () => {
    const stalled = new FakeReactor();
    (stalled as unknown as { nextChunk: () => void }).nextChunk = () => {};
    const r = await runOrbisSession(stalled, params({ timeouts: { connectMs: 2000, commandMs: 2000, generationMs: 50, clipMs: 2000, downloadMs: 2000 } }), stalled.now);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Timed out/);
    assert.deepEqual(stalled.disconnects, [false]);
  });
});
