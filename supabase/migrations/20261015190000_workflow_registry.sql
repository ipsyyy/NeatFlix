-- NativeFrame workflow registry: cases, placement plans, media assets,
-- Release Governor reviews, and human approvals (PRODUCT_SOURCE_OF_TRUTH.md §10).
--
-- Security model:
-- * Only the server reads or writes, with a Supabase secret key (which acts as
--   the service_role Postgres role). Row-level security is
--   enabled with no policies, and anon/authenticated have no privileges, so
--   browser clients can neither read nor fabricate any record.
-- * Plans, reviews, and approvals are append-only. A media asset becomes
--   immutable once a Governor review references it. Only a case's status and
--   updated_at may change.
-- * Media binaries are never stored here: only storage references and metadata.
-- * JSON documents are validated by NativeFrame's runtime validators before
--   insert and revalidated after every read; the checks below are a second line.
-- * Case isolation: composite foreign keys bind every plan to its case's title,
--   every media asset to its plan's case, every review to its plan's case and
--   preview, and every approval to its review's case and preview, so PostgreSQL
--   itself rejects a reference into another case.

create table public.cases (
  case_id     text primary key check (case_id ~ '^[A-Za-z0-9-]{1,100}$'),
  title_id    text not null check (title_id ~ '^[a-z0-9-]{1,120}$'),
  status      text not null default 'open'
              check (status in ('open', 'revise-requested', 'awaiting-human-review', 'approved', 'stopped')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (case_id, title_id)
);

create table public.placement_plans (
  plan_id            text primary key check (plan_id ~ '^plan:[a-z0-9-]+:[a-z0-9-]+:v[0-9]+$'),
  case_id            text not null,
  title_id           text not null,
  scene_id           text not null,
  campaign_id        text not null,
  version            integer not null check (version > 0),
  plan               jsonb not null check (jsonb_typeof(plan) = 'object'),
  validation_status  text not null check (validation_status = 'valid'),
  created_at         timestamptz not null default now(),
  check (plan ->> 'kind' = 'placement-plan'),
  check (plan ->> 'planId' = plan_id),
  check (plan ->> 'caseId' = case_id),
  check (plan -> 'scene' ->> 'sceneId' = scene_id),
  check (plan -> 'product' ->> 'campaignId' = campaign_id),
  check (plan -> 'sourceArtifacts' ->> 'titleId' = title_id),
  -- A plan belongs to its case and to that case's title.
  foreign key (case_id, title_id) references public.cases (case_id, title_id),
  unique (plan_id, case_id)
);
create index placement_plans_case_id_idx on public.placement_plans (case_id);

create table public.media_assets (
  asset_id          text primary key check (asset_id ~ '^asset:[A-Za-z0-9:._-]{1,190}$'),
  case_id           text not null references public.cases (case_id),
  plan_id           text,
  kind              text not null check (kind in ('source-video', 'source-frame', 'edited-still', 'generated-preview')),
  storage_ref       text not null unique check (storage_ref ~ '^(https://[^[:space:]]+|storage://[^[:space:]]+)$' and length(storage_ref) <= 500),
  mime_type         text not null check (mime_type ~ '^(video|image)/[a-z0-9.+-]+$'),
  duration_seconds  numeric check (duration_seconds is null or duration_seconds > 0),
  generator         text,
  model             text,
  generated_at      timestamptz,
  latency_ms        integer check (latency_ms is null or latency_ms >= 0),
  cost_usd          numeric check (cost_usd is null or cost_usd >= 0),
  checksum          text not null check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  provenance        jsonb not null check (jsonb_typeof(provenance) = 'object'),
  created_at        timestamptz not null default now(),
  -- A generated preview must name its plan and carry complete generation metadata.
  check (
    kind <> 'generated-preview' or (
      plan_id is not null and generator is not null and model is not null and generated_at is not null
      and latency_ms is not null and cost_usd is not null and provenance ->> 'inputPlanId' = plan_id
    )
  ),
  -- Media tied to a plan must belong to that plan's case (checked when plan_id is set).
  foreign key (plan_id, case_id) references public.placement_plans (plan_id, case_id),
  unique (asset_id, case_id),
  unique (asset_id, plan_id, case_id)
);
create index media_assets_plan_kind_idx on public.media_assets (plan_id, kind);
create index media_assets_case_id_idx on public.media_assets (case_id);

create table public.governor_reviews (
  review_id         text primary key check (review_id ~ '^review:plan:[a-z0-9-]+:[a-z0-9-]+:v[0-9]+:r[0-9]+$'),
  case_id           text not null,
  plan_id           text not null,
  preview_asset_id  text,
  decision          text not null check (decision in ('revise', 'approve-for-human-review', 'stop')),
  review            jsonb not null check (jsonb_typeof(review) = 'object'),
  created_at        timestamptz not null default now(),
  check (review ->> 'kind' = 'governor-review'),
  check (review ->> 'reviewId' = review_id),
  check (review ->> 'decision' = decision),
  check (review -> 'subject' ->> 'planId' = plan_id),
  check (decision <> 'approve-for-human-review' or preview_asset_id is not null),
  check (review -> 'humanApproval' ->> 'status' in ('not-requested', 'pending')),
  check (review ->> 'caseId' = case_id),
  -- The reviewed plan, and the preview when present, belong to the review's case.
  foreign key (plan_id, case_id) references public.placement_plans (plan_id, case_id),
  foreign key (preview_asset_id, plan_id, case_id) references public.media_assets (asset_id, plan_id, case_id),
  unique (review_id, case_id)
);
create index governor_reviews_plan_id_idx on public.governor_reviews (plan_id);

create table public.human_approvals (
  approval_id       uuid primary key default gen_random_uuid(),
  case_id           text not null,
  -- One approval per review: a replayed approval violates this constraint.
  review_id         text not null unique,
  preview_asset_id  text not null,
  reviewer_user_id  text not null check (length(reviewer_user_id) between 1 and 200),
  reviewer_name     text not null check (length(btrim(reviewer_name)) between 1 and 200),
  decision          text not null check (decision = 'approve'),
  created_at        timestamptz not null default now(),
  -- The approved review and preview belong to the approval's case.
  foreign key (review_id, case_id) references public.governor_reviews (review_id, case_id),
  foreign key (preview_asset_id, case_id) references public.media_assets (asset_id, case_id)
);

-- An approval must match an approve-for-human-review of the same case and preview.
create function public.nf_check_approval() returns trigger
language plpgsql set search_path = '' as $$
declare r public.governor_reviews%rowtype;
begin
  select * into r from public.governor_reviews where review_id = new.review_id;
  if r.decision is distinct from 'approve-for-human-review' then
    raise exception 'human approval requires an approve-for-human-review decision';
  end if;
  if r.case_id <> new.case_id or r.preview_asset_id is distinct from new.preview_asset_id then
    raise exception 'human approval must match the review case and preview';
  end if;
  return new;
end $$;
create trigger human_approvals_check before insert on public.human_approvals
  for each row execute function public.nf_check_approval();

-- A review that names a preview must name a generated preview of the same plan.
create function public.nf_check_review_preview() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.preview_asset_id is not null and not exists (
    select 1 from public.media_assets a
    where a.asset_id = new.preview_asset_id and a.kind = 'generated-preview' and a.plan_id = new.plan_id
  ) then
    raise exception 'review preview must be a generated preview of the reviewed plan';
  end if;
  return new;
end $$;
create trigger governor_reviews_preview_check before insert on public.governor_reviews
  for each row execute function public.nf_check_review_preview();

-- Append-only records.
create function public.nf_reject_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger placement_plans_append_only before update or delete on public.placement_plans
  for each row execute function public.nf_reject_change();
create trigger governor_reviews_append_only before update or delete on public.governor_reviews
  for each row execute function public.nf_reject_change();
create trigger human_approvals_append_only before update or delete on public.human_approvals
  for each row execute function public.nf_reject_change();

-- Media referenced by a Governor review is immutable; its key never changes.
create function public.nf_protect_media() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.governor_reviews r where r.preview_asset_id = old.asset_id) then
    raise exception 'media asset % is referenced by a Governor review and is immutable', old.asset_id;
  end if;
  if tg_op = 'UPDATE' and new.asset_id <> old.asset_id then
    raise exception 'media asset id cannot change';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger media_assets_protect before update or delete on public.media_assets
  for each row execute function public.nf_protect_media();

-- Cases: only status (and updated_at) may change; cases are never deleted.
create function public.nf_protect_case() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cases cannot be deleted';
  end if;
  if new.case_id <> old.case_id or new.title_id <> old.title_id or new.created_at <> old.created_at then
    raise exception 'only a case status can change';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger cases_protect before update or delete on public.cases
  for each row execute function public.nf_protect_case();

-- Deny every browser role. The server's secret key acts as service_role, which bypasses RLS.
alter table public.cases            enable row level security;
alter table public.placement_plans  enable row level security;
alter table public.media_assets     enable row level security;
alter table public.governor_reviews enable row level security;
alter table public.human_approvals  enable row level security;

revoke all on public.cases, public.placement_plans, public.media_assets, public.governor_reviews, public.human_approvals
  from anon, authenticated;
revoke execute on function public.nf_check_approval(), public.nf_check_review_preview(), public.nf_reject_change(),
  public.nf_protect_media(), public.nf_protect_case() from public, anon, authenticated;
