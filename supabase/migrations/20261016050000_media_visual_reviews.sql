-- Human visual reviews of media assets (PRODUCT_SOURCE_OF_TRUTH.md §7.3: human
-- review owns the final visual decision). Append-only: one review per asset,
-- never updated or deleted. A reviewed asset becomes immutable, like one a
-- Governor review references. The reviewed asset's own record is never changed;
-- its provenance keeps the review status it had at generation time.

create table public.media_visual_reviews (
  review_id         uuid primary key default gen_random_uuid(),
  asset_id          text not null unique,
  case_id           text not null,
  decision          text not null check (decision in ('approved', 'rejected')),
  reasons           jsonb not null check (jsonb_typeof(reasons) = 'array'),
  asset_checksum    text not null check (asset_checksum ~ '^sha256:[0-9a-f]{64}$'),
  reviewer_user_id  text not null check (length(reviewer_user_id) between 1 and 200),
  reviewer_name     text not null check (length(btrim(reviewer_name)) between 1 and 200),
  created_at        timestamptz not null default now(),
  -- A rejection must say why.
  check (decision <> 'rejected' or jsonb_array_length(reasons) > 0),
  -- The reviewed asset belongs to the review's case.
  foreign key (asset_id, case_id) references public.media_assets (asset_id, case_id)
);

-- The review must name the asset's exact bytes.
create function public.nf_check_visual_review() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.media_assets a where a.asset_id = new.asset_id and a.checksum = new.asset_checksum
  ) then
    raise exception 'visual review must name the asset''s registered checksum';
  end if;
  return new;
end $$;
create trigger media_visual_reviews_check before insert on public.media_visual_reviews
  for each row execute function public.nf_check_visual_review();

create trigger media_visual_reviews_append_only before update or delete on public.media_visual_reviews
  for each row execute function public.nf_reject_change();

-- Media referenced by a Governor review or a human visual review is immutable.
create or replace function public.nf_protect_media() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.governor_reviews r where r.preview_asset_id = old.asset_id)
     or exists (select 1 from public.media_visual_reviews v where v.asset_id = old.asset_id) then
    raise exception 'media asset % is referenced by a review and is immutable', old.asset_id;
  end if;
  if tg_op = 'UPDATE' and new.asset_id <> old.asset_id then
    raise exception 'media asset id cannot change';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Deny every browser role.
alter table public.media_visual_reviews enable row level security;
revoke all on public.media_visual_reviews from anon, authenticated;
revoke execute on function public.nf_check_visual_review(), public.nf_protect_media() from public, anon, authenticated;
