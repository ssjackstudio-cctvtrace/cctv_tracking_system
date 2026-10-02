-- =====================================================================
-- CCTV Tracking System — setup for the edge box
-- How to run: Supabase → SQL Editor → paste PART 1 → Run.
--             Then fill in PART 2 with your own values → Run.
-- The edge box uses the secret key, so it works whether or not
-- enable_rls.sql has been run. (Only run enable_rls.sql after the website
-- has its sign-in page, or the dashboard will show no data.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- PART 1 (run once)
-- ---------------------------------------------------------------------

-- 1a. Private storage bucket for the live snapshots uploaded by the edge
--     box. Private = not readable by the public. The edge box stores a
--     signed link in camera.last_snapshot_url that the dashboard shows.
insert into storage.buckets (id, name, public)
values ('camera-snapshots', 'camera-snapshots', false)
on conflict (id) do nothing;

-- 1b. Face match (used in phase 2, face recognition). Returns the best
--     matching active, consenting member for one 512-number embedding.
--     Only the edge box (secret key) may call it.
create or replace function public.match_member_face(
  query_embedding vector(512),
  min_similarity  double precision default 0.60
)
returns table (face_template_id uuid, member_id uuid, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  select ft.face_template_id,
         ft.member_id,
         1 - (ft.embedding <=> query_embedding) as similarity
  from   public.member_face_template ft
  join   public.member m on m.member_id = ft.member_id
  where  ft.revoked_at is null
    and  ft.consent_biometric
    and  m.consent_pdpa
    and  m.status = 'Active'
    and  1 - (ft.embedding <=> query_embedding) >= min_similarity
  order  by ft.embedding <=> query_embedding
  limit  1;
$$;

revoke execute on function public.match_member_face(vector, double precision)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- PART 2 (fill in, then run) — register the edge box and its cameras.
-- Values come from the Tapo app: camera → Settings → Device Info.
-- Do NOT put the camera username / password here; they stay on the box.
-- Copy the "insert into public.camera" block once per camera.
-- ---------------------------------------------------------------------

-- 2a. The edge box (one per branch)
insert into public.edge_device (branch_id, device_name)
select branch_id, 'JS-PJ-EDGE-01'                  -- ← box name (your choice)
from   public.branch
where  branch_name = 'JackStudio PJ'               -- ← your branch_name exactly
returning edge_device_id;                          -- ← copy this id into edge/.env

-- 2b. A camera
insert into public.camera
  (camera_name, active_status, branch_id, edge_device_id,
   tapo_model, mac_address, ip_address, stream_path)
select 'PJ-Entrance',                              -- ← Device name in Tapo
       'Active',
       e.branch_id,
       e.edge_device_id,
       'C200',                                     -- ← Model in Tapo
       'AA-BB-CC-DD-EE-FF',                        -- ← MAC address in Tapo
       '192.168.1.50',                             -- ← camera IP (fixed in router)
       'stream2'
from   public.edge_device e
where  e.device_name = 'JS-PJ-EDGE-01'
returning camera_id;
