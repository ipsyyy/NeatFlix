import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPROVED_CUP_REGIONS, fullSceneFilterGraph, validateFullSceneProbe } from "@/agents/media/full-scene-overlay";

describe("full-scene Daybreak overlay", () => {
  it("binds both approved cup regions to fixed positions", () => {
    assert.equal(APPROVED_CUP_REGIONS.length, 2);
    assert.match(fullSceneFilterGraph(), /overlay=543:422/);
    assert.match(fullSceneFilterGraph(), /overlay=858:422/);
    assert.match(fullSceneFilterGraph(), /between\(t,4\.46,14\.79\)/);
  });
  it("accepts the registered full duration and rejects a short preview", () => {
    assert.deepEqual(validateFullSceneProbe({ durationSeconds: 20.064, width: 1280, height: 720, videoCodec: "h264", hasAudio: true }), []);
    assert.match(validateFullSceneProbe({ durationSeconds: 3.5, width: 1280, height: 720, videoCodec: "h264", hasAudio: false })[0], /does not match source duration/);
  });
  it("rejects the wrong output shape or codec", () => {
    assert.equal(validateFullSceneProbe({ durationSeconds: 20.064, width: 1920, height: 1080, videoCodec: "hevc", hasAudio: true }).length, 2);
  });
});
