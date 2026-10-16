import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RELEASE_GOVERNOR_DISCLOSURE } from "@/agents/handoff/output-rules";
import { STAND_IN_DISCLOSURE, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { frameChecks, LUV_FRAME } from "@/agents/scripts/placement-frame-checks";
import { validPlacementPlan } from "./fixtures";

const CHECKSUM = `sha256:${"2".repeat(64)}`;
const binding = (over: Record<string, unknown> = {}) =>
  ({
    kind: "registered-source-frame",
    isSceneFrame: true,
    assetId: LUV_FRAME.assetId,
    storageRef: LUV_FRAME.storageRef,
    checksum: CHECKSUM,
    sourceAssetId: LUV_FRAME.sourceAssetId,
    timestampSeconds: LUV_FRAME.timestampSeconds,
    note: SOURCE_FRAME_DISCLOSURE,
    ...over,
  }) as PlacementPlan["sourceMedia"];
const framePlan = (over: Partial<PlacementPlan> = {}) => validPlacementPlan({ sourceMedia: binding(), ...over });
const readable = `@demo-user Plan bound to the registered frame; both generation prompts have not been executed. ${SOURCE_FRAME_DISCLOSURE} ${RELEASE_GOVERNOR_DISCLOSURE}`;
const results = (plan: PlacementPlan | undefined, text = readable, checksum: string | null = CHECKSUM) => frameChecks(plan, text, checksum).map(([, ok]) => ok);

describe("live-harness checks for a registered source-frame placement", () => {
  it("pass for a plan bound to the registered LUV frame with the required disclosures", () => {
    assert.deepEqual(results(framePlan()), [true, true, true]);
  });

  it("fail for a stand-in plan, a missing plan, or an unreadable registry checksum", () => {
    assert.deepEqual(results(validPlacementPlan(), readable.replace(SOURCE_FRAME_DISCLOSURE, STAND_IN_DISCLOSURE)), [false, true, false]);
    assert.deepEqual(results(undefined), [false, false, false]);
    assert.equal(results(framePlan(), readable, null)[0], false);
  });

  it("fail when any binding field differs from the registry record", () => {
    for (const over of [
      { checksum: `sha256:${"3".repeat(64)}` },
      { assetId: "asset:luv-hypothesis:source-frame:luv-scene-1:v2" },
      { storageRef: "storage://nf-media/frames/luv-hypothesis/other.png" },
      { timestampSeconds: 9 },
      { sourceAssetId: "asset:luv-hypothesis:source-video:v2" },
      { note: STAND_IN_DISCLOSURE },
    ]) {
      assert.equal(results(validPlacementPlan({ sourceMedia: binding(over) }))[0], false, JSON.stringify(over));
    }
  });

  it("fail when the placement is not the clear front-right region clear of actors, hands, cups, and pastry", () => {
    const base = framePlan();
    const noFrontRight = framePlan({ placement: { ...base.placement, description: "The cup rests on the café table, away from the existing cups, the pastry, and both actors." } });
    assert.equal(results(noFrontRight)[1], false);
    const noPastry = framePlan({
      placement: { ...base.placement, description: "The cup rests on the clear front-right area, away from the existing cups and both actors." },
      negativeConstraints: base.negativeConstraints.filter((c) => !/pastry/i.test(c)),
    });
    assert.equal(results(noPastry)[1], false);
    assert.equal(results(framePlan({ scene: { ...base.scene, startSeconds: 6 } }))[1], false);
  });

  it("fail when a prompt is not labelled not-executed or the readable text omits the required statements", () => {
    const base = framePlan();
    const executed = framePlan({ prompts: { ...base.prompts, motion: { ...base.prompts.motion, status: "executed" as never } } });
    assert.equal(results(executed)[2], false);
    assert.equal(results(framePlan(), readable.replace(SOURCE_FRAME_DISCLOSURE, ""))[2], false);
    assert.equal(results(framePlan(), readable.replace("have not been executed", "are ready"))[2], false);
    assert.equal(results(framePlan(), `${readable} ${STAND_IN_DISCLOSURE}`)[2], false, "never both sentences");
  });
});
