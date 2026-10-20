-- A full-scene edited video (agents/media/runway-full-scene.ts) and human
-- visual reviews that approve with a disclosed limitation.
--
-- 1. media_assets gains the kind 'full-scene-video': a paid, provider-edited
--    copy of the whole source video. It is a separate kind so it never becomes
--    a plan's generated preview (the Governor, preview evidence, and visual
--    disclosure each require exactly one generated preview per plan). It must
--    name its plan and carry the same complete generation metadata.
-- 2. media_visual_reviews gains the decision 'approved-with-limitation' and a
--    limitations array: that decision must state at least one limitation, and
--    no other decision may carry any. Existing reviews keep an empty array.
--    Reviews stay append-only (the existing trigger is unchanged).
--
-- Additive only: no row is updated or deleted.

begin;

alter table public.media_assets drop constraint media_assets_kind_check;
alter table public.media_assets add constraint media_assets_kind_check
  check (kind in ('source-video', 'source-frame', 'edited-still', 'generated-preview', 'full-scene-video'));
alter table public.media_assets add constraint media_assets_full_scene_video_check
  check (
    kind <> 'full-scene-video' or (
      plan_id is not null and generator is not null and model is not null and generated_at is not null
      and latency_ms is not null and cost_usd is not null and duration_seconds is not null
      and mime_type = 'video/mp4' and provenance ->> 'inputPlanId' = plan_id
    )
  );

alter table public.media_visual_reviews drop constraint media_visual_reviews_decision_check;
alter table public.media_visual_reviews add constraint media_visual_reviews_decision_check
  check (decision in ('approved', 'approved-with-limitation', 'rejected'));
alter table public.media_visual_reviews add column limitations jsonb not null default '[]'::jsonb;
alter table public.media_visual_reviews add constraint media_visual_reviews_limitations_check
  check (
    jsonb_typeof(limitations) = 'array'
    and jsonb_array_length(limitations) <= 10
    and (decision = 'approved-with-limitation') = (jsonb_array_length(limitations) > 0)
  );

commit;
