import type { RefreshableSourceFrameRegistry, SceneFrameState, SourceFrameRecord } from "@/agents/handoff/source-frames";
import type { WorkflowRegistry } from "./workflow";

/**
 * Placement-side source-frame registry backed by persistence. Validators are
 * synchronous, so a scene's frames are loaded and revalidated by refreshScene()
 * at the authenticated boundary (gate or tool) before any plan is checked.
 * A refresh that fails marks the scene invalid: plans for it fail closed.
 */
export class PersistentSourceFrameRegistry implements RefreshableSourceFrameRegistry {
  private readonly scenes = new Map<string, SceneFrameState>();
  private readonly frames = new Map<string, SourceFrameRecord>();

  constructor(private readonly workflow: WorkflowRegistry) {}

  async refreshScene(caseId: string, sceneId: string): Promise<SceneFrameState> {
    const key = `${caseId}\u0000${sceneId}`;
    let state: SceneFrameState;
    try {
      state = await this.workflow.loadSourceFramesForScene(caseId, sceneId);
    } catch {
      state = { valid: null, invalid: true };
    }
    for (const [id, f] of this.frames) if (f.caseId === caseId && f.sceneId === sceneId) this.frames.delete(id);
    if (state.valid) this.frames.set(state.valid.assetId, state.valid);
    this.scenes.set(key, state);
    return structuredClone(state);
  }

  find(assetId: string): SourceFrameRecord | null {
    const f = this.frames.get(assetId);
    return f ? structuredClone(f) : null;
  }

  forScene(caseId: string, sceneId: string): SceneFrameState | null {
    const s = this.scenes.get(`${caseId}\u0000${sceneId}`);
    return s ? structuredClone(s) : null;
  }
}
