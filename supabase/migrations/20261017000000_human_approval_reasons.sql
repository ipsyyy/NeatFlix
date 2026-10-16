-- Human approval reasons (PRODUCT_SOURCE_OF_TRUTH.md §7.3: human review owns the
-- final release decision). Every approval states its reasons: 1–10 distinct,
-- non-empty strings of at most 500 characters. Approving moves the case from
-- awaiting-human-review to approved in the same transaction as the insert.
--
-- Unchanged: deny-all RLS, append-only approvals, one approval per review, and
-- every foreign key and trigger binding an approval to its review's case and
-- preview. No existing approval row is modified: the migration refuses to run
-- unless the table is empty.

do $$
begin
  if exists (select 1 from public.human_approvals) then
    raise exception 'human_approvals must be empty before required reasons are added';
  end if;
end $$;

-- 1–10 distinct strings, each non-empty after trimming and at most 500 characters.
create function public.nf_valid_approval_reasons(reasons jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(reasons) = 'array'
    and jsonb_array_length(reasons) between 1 and 10
    and not exists (
      select 1 from jsonb_array_elements(reasons) as e(value)
      where jsonb_typeof(e.value) <> 'string'
         or length(btrim(e.value #>> '{}')) = 0
         or length(e.value #>> '{}') > 500
    )
    and (select count(distinct e.value) from jsonb_array_elements(reasons) as e(value)) = jsonb_array_length(reasons)
$$;

alter table public.human_approvals
  add column reasons jsonb not null
  constraint human_approvals_reasons_check check (public.nf_valid_approval_reasons(reasons));

-- An approval must match an approve-for-human-review of the same case and
-- preview, and its case must be awaiting human review (row locked until commit).
create or replace function public.nf_check_approval() returns trigger
language plpgsql set search_path = '' as $$
declare
  r public.governor_reviews%rowtype;
  case_status text;
begin
  select * into r from public.governor_reviews where review_id = new.review_id;
  if r.decision is distinct from 'approve-for-human-review' then
    raise exception 'human approval requires an approve-for-human-review decision';
  end if;
  if r.case_id <> new.case_id or r.preview_asset_id is distinct from new.preview_asset_id then
    raise exception 'human approval must match the review case and preview';
  end if;
  select c.status into case_status from public.cases c where c.case_id = new.case_id for update;
  if case_status is distinct from 'awaiting-human-review' then
    raise exception 'human approval requires the case to be awaiting human review';
  end if;
  return new;
end $$;

-- The approved case moves to approved atomically with the approval insert.
create function public.nf_approve_case() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.cases set status = 'approved' where case_id = new.case_id and status = 'awaiting-human-review';
  if not found then
    raise exception 'human approval could not move the case to approved';
  end if;
  return null;
end $$;
create trigger human_approvals_approve_case after insert on public.human_approvals
  for each row execute function public.nf_approve_case();

revoke execute on function public.nf_valid_approval_reasons(jsonb), public.nf_check_approval(), public.nf_approve_case()
  from public, anon, authenticated;
-- The reasons check runs as the inserting role: only the server's role may call it.
grant execute on function public.nf_valid_approval_reasons(jsonb) to service_role;
