-- =====================================================================
-- Jackstudio @ Aeon Bukit Tinggi — register the edge box and its 4 Tapo cameras
-- (PART 2 of edge_setup.sql, filled in for this branch)
--
-- How to run: Supabase → SQL Editor → paste → Run.
-- Before running:
--   1. Run PART 1 of edge_setup.sql once (if not done yet).
--   2. The branch "Jackstudio @ Aeon Bukit Tinggi" must exist (website → Branch page).
--      It is found by "Aeon … Tinggi" in its name (capital letters ignored), so
--      small differences in wording or spelling (e.g. "Bujkit") do not matter.
--   3. In the shop router (OLAX_LTE_8951), reserve each camera's IP below
--      so it never changes.
-- Safe to run again: existing rows are updated, not duplicated.
-- Camera usernames / passwords are NOT stored here; they stay in edge/.env
-- on the box.
-- =====================================================================

begin;

-- 0. Extra camera details from the Tapo app (Device Info)
alter table public.camera add column if not exists hardware_version text; -- e.g. 1.0
alter table public.camera add column if not exists firmware_version text; -- e.g. 1.9.1
alter table public.camera add column if not exists wifi_network     text; -- Wi-Fi the camera joins

-- Stop here with a clear message unless exactly one Aeon Bukit Tinggi branch exists
do $$
declare
  n int;
begin
  select count(*) into n from public.branch where branch_name ilike '%aeon bukit tinggi%';
  if n = 0 then
    raise exception 'No branch named like "Jackstudio @ Aeon Bukit Tinggi". Add it on the Branch page first.';
  elsif n > 1 then
    raise exception 'More than one branch is named like "Aeon ... Tinggi". Make the name in this script more exact.';
  end if;
end $$;

-- 1. The edge box at this branch
insert into public.edge_device (branch_id, device_name)
select branch_id, 'JS-ABT-EDGE-01'
from   public.branch
where  branch_name ilike '%aeon bukit tinggi%'                -- Jackstudio @ Aeon Bukit Tinggi
on conflict (device_name) do nothing;

-- 2. The 4 cameras (camera_name = Device Name in the Tapo app)
insert into public.camera
  (camera_name, active_status, branch_id, edge_device_id,
   tapo_model, hardware_version, firmware_version, wifi_network,
   mac_address, ip_address, stream_path)
select v.camera_name, 'Active', e.branch_id, e.edge_device_id,
       v.tapo_model, v.hardware_version, v.firmware_version, v.wifi_network,
       v.mac_address, v.ip_address::inet, 'stream2'
from   public.edge_device e
cross join (values
  --  Device Name  Model   HW     Firmware  Wi-Fi network      MAC address          IP address
  ('ABT-01',      'C230', '1.0', '1.9.1',  'OLAX_LTE_8951',   'C0-3A-55-CA-05-F7', '192.168.8.129'),
  ('ABT-02',      'C230', '1.0', '1.9.1',  'OLAX_LTE_8951',   '58-04-4F-49-3C-92', '192.168.8.135'),
  ('ABT-03',      'C230', '1.0', '1.9.1',  'OLAX_LTE_8951',   'C0-3A-55-CA-03-18', '192.168.8.107'),
  ('ABT-04',      'C230', '1.0', '1.9.1',  'OLAX_LTE_8951',   'C0-3A-55-C9-FE-75', '192.168.8.166')
) as v (camera_name, tapo_model, hardware_version, firmware_version, wifi_network, mac_address, ip_address)
where  e.device_name = 'JS-ABT-EDGE-01'
on conflict (camera_name) do update set
  active_status    = excluded.active_status,
  branch_id        = excluded.branch_id,
  edge_device_id   = excluded.edge_device_id,
  tapo_model       = excluded.tapo_model,
  hardware_version = excluded.hardware_version,
  firmware_version = excluded.firmware_version,
  wifi_network     = excluded.wifi_network,
  mac_address      = excluded.mac_address,
  ip_address       = excluded.ip_address,
  stream_path      = excluded.stream_path;

commit;

-- 3. Result: copy edge_device_id into edge/.env on the box (EDGE_DEVICE_ID=...)
select e.edge_device_id, e.device_name, c.camera_name, c.tapo_model, c.hardware_version,
       c.firmware_version, c.wifi_network, c.mac_address, c.ip_address, c.active_status
from   public.edge_device e
join   public.camera c on c.edge_device_id = e.edge_device_id
where  e.device_name = 'JS-ABT-EDGE-01'
order  by c.camera_name;