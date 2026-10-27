-- =====================================================================
-- CCTV Tracking System — Suspicious same person (Camera page)
-- How to run: Supabase → SQL Editor → paste everything → Run.
-- Safe to run more than once. Run it after rls_all_tables.sql.
--
-- The edge box compares the people it remembers (clothes colours, whole
-- body, face; also when legs are hidden) and reports pairs of track_ids
-- that look like ONE person: seen by two cameras, or re-tracked with a new
-- number on the same camera. The Camera page lists them; "Merge" gives the
-- later visit the FIRST track_id (the first camera's), so the Dashboard and
-- JackStudio OS count that person once.
-- =====================================================================

begin;

create table if not exists public.suspect_match (
  suspect_match_id uuid primary key default gen_random_uuid(),
  visit_keep  uuid not null references public.visit(visit_id) on delete cascade,  -- first track_id (kept)
  visit_dup   uuid not null references public.visit(visit_id) on delete cascade,  -- later track_id (duplicate)
  track_keep  text not null,   -- track_ids as they were when reported
  track_dup   text not null,
  camera_keep uuid references public.camera(camera_id) on delete set null,
  camera_dup  uuid references public.camera(camera_id) on delete set null,
  kind        text not null check (kind in ('Another camera', 'Same camera')),
  score       numeric not null default 0 check (score >= 0 and score <= 100),  -- how alike, %
  floor_apart numeric,          -- metres between the two floor spots at the same moment (null = unknown)
  reason      text,
  seen_keep   timestamptz,      -- first seen
  seen_dup    timestamptz,
  status      text not null default 'Open' check (status in ('Open', 'Merged', 'Not same')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (visit_keep, visit_dup),
  check (visit_keep <> visit_dup)
);
create index if not exists suspect_match_created_at_idx on public.suspect_match (created_at desc);

-- Same access as every other table: signed-in admins only (the edge box uses the secret key)
alter table public.suspect_match enable row level security;
grant select, insert, update, delete on public.suspect_match to anon, authenticated;
drop policy if exists "admins full access" on public.suspect_match;
create policy "admins full access" on public.suspect_match
  for all to anon, authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Edge box: add a pair, or raise its score. A pair already Merged / Not same stays as it is.
create or replace function public.report_suspect_match(p jsonb)
returns uuid
language sql
security definer
set search_path = public
as $$
  insert into public.suspect_match as s
    (visit_keep, visit_dup, track_keep, track_dup, camera_keep, camera_dup,
     kind, score, floor_apart, reason, seen_keep, seen_dup)
  values
    ((p->>'visit_keep')::uuid, (p->>'visit_dup')::uuid, p->>'track_keep', p->>'track_dup',
     nullif(p->>'camera_keep', '')::uuid, nullif(p->>'camera_dup', '')::uuid,
     p->>'kind', (p->>'score')::numeric, nullif(p->>'floor_apart', '')::numeric, p->>'reason',
     (p->>'seen_keep')::timestamptz, (p->>'seen_dup')::timestamptz)
  on conflict (visit_keep, visit_dup) do update
    set score       = greatest(s.score, excluded.score),
        floor_apart = coalesce(excluded.floor_apart, s.floor_apart),
        reason      = case when excluded.score >= s.score then excluded.reason else s.reason end,
        updated_at  = now()
    where s.status = 'Open'
  returning suspect_match_id;
$$;
revoke all on function public.report_suspect_match(jsonb) from public, anon, authenticated;

-- Website "Merge": the duplicate visit (and any visit already merged into it)
-- takes the FIRST track_id. Its cctv_event / recognition_event rows stay on
-- their visit, so they now count for that one track_id.
create or replace function public.merge_suspect_match(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.suspect_match%rowtype;
  keep_track text;
  dup_track text;
begin
  if not public.is_admin() then
    raise exception 'Sign in as an admin first';
  end if;
  select * into m from public.suspect_match where suspect_match_id = p_id for update;
  if not found then
    raise exception 'Suspicious pair not found';
  end if;
  if m.status <> 'Open' then
    raise exception 'This pair is already %', m.status;
  end if;
  select track_id into keep_track from public.visit where visit_id = m.visit_keep;
  select track_id into dup_track  from public.visit where visit_id = m.visit_dup;
  if keep_track is distinct from dup_track then
    update public.visit set track_id = keep_track where track_id = dup_track;
  end if;
  update public.suspect_match set status = 'Merged', updated_at = now() where suspect_match_id = p_id;
  -- other open pairs whose two visits now share one track_id are done too
  update public.suspect_match s
     set status = 'Merged', updated_at = now()
    from public.visit a, public.visit b
   where s.status = 'Open'
     and a.visit_id = s.visit_keep and b.visit_id = s.visit_dup
     and a.track_id = b.track_id;
  return keep_track;
end;
$$;
revoke all on function public.merge_suspect_match(uuid) from public;
grant execute on function public.merge_suspect_match(uuid) to anon, authenticated;  -- checks is_admin() itself

commit;

-- Check
-- select status, count(*) from public.suspect_match group by status;
-- select track_keep, track_dup, kind, score, floor_apart, reason from public.suspect_match
--  where status = 'Open' order by created_at desc limit 20;
--
-- Undo
-- drop function if exists public.merge_suspect_match(uuid);
-- drop function if exists public.report_suspect_match(jsonb);
-- drop table if exists public.suspect_match;
