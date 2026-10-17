-- Private media bucket types for agent identities (agents/masky): portraits
-- (PNG), spoken results (MPEG, MP4, or WAV audio), and the Release Governor's
-- talking-head video (MP4), alongside the existing video and image media.
--
-- Updates only nf-media's allowed MIME types to exactly this list. The bucket
-- stays private; its name, size limit, objects, and policies are untouched.
-- Idempotent: it writes only when the list differs, and refuses to run if the
-- bucket is missing or public.

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'nf-media') then
    raise exception 'bucket nf-media does not exist';
  end if;
  if exists (select 1 from storage.buckets where id = 'nf-media' and public) then
    raise exception 'bucket nf-media must remain private';
  end if;
end $$;

update storage.buckets
set allowed_mime_types = array['video/mp4', 'image/png', 'image/jpeg', 'audio/mpeg', 'audio/mp4', 'audio/wav']::text[]
where id = 'nf-media'
  and public = false
  and allowed_mime_types is distinct from array['video/mp4', 'image/png', 'image/jpeg', 'audio/mpeg', 'audio/mp4', 'audio/wav']::text[];
