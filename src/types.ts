// Types that match the Supabase tables (public schema).
// uuid, timestamptz and inet columns come back from Supabase as strings.
import type { FloorAreas, RegionKind } from './space3d'

// ---------- BRANCH ----------
export type Branch = {
  branch_id: string // uuid
  branch_name: string
  house_unit: string | null
  street: string | null
  township: string | null
  formatted_address: string
  postal_code: string // 5 digits
  city: string
  state: string
  country: string // default 'Malaysia'
  google_place_id: string
  latitude: number
  longitude: number
  created_at: string
}

// The fields the admin can edit
export type BranchEditable = Pick<
  Branch,
  | 'branch_name'
  | 'house_unit'
  | 'street'
  | 'township'
  | 'formatted_address'
  | 'postal_code'
  | 'city'
  | 'state'
  | 'country'
>

// ---------- EDGE_DEVICE ----------
export type EdgeDevice = {
  edge_device_id: string
  branch_id: string
  device_name: string
  status: 'Online' | 'Offline'
  last_heartbeat: string | null
  live_url?: string | null // live video address (supabase/live_video.sql), set by the edge box
  // people the 4 cameras see inside right now, each person once (supabase/people_inside.sql), set by the edge box
  people_inside?: { all: number; male: number; female: number; unknown: number; at: string } | null
  created_at: string
}

export type EdgeDeviceEditable = Pick<EdgeDevice, 'branch_id' | 'device_name'>

// ---------- CAMERA ----------
// Points use 0–1 coordinates (fraction of the image width/height), so they
// still fit if the stream resolution changes. Keep this shape the same as
// what the edge box reads.
export type Point = { x: number; y: number }
// Count line: many dots joined into one line; in_zone is the area labelled
// "In" (the line stretched to the picture border splits the picture in two).
// { all_in: true }: whole screen is In (a camera inside the shop).
// The older two-point line { start, end } is still read.
export type CountLine =
  | { points: Point[]; in_point: Point; in_zone: Point[] }
  | { all_in: true }
  | { start: Point; end: Point }
// camera.floor_areas: the camera's 3D floor calibration + shop areas
// (Counter, Point of Purchase display, ...). See space3d.ts.
export type CameraFloorAreas = FloorAreas

export type Camera = {
  camera_id: string
  camera_name: string
  active_status: 'Active' | 'Inactive'
  edge_device_id: string | null // the camera's branch comes from its edge box (edge_device.branch_id)
  tapo_model: string | null
  mac_address: string | null
  ip_address: string | null // inet
  stream_path: 'stream1' | 'stream2' | null
  count_line: CountLine | null // jsonb
  floor_areas: CameraFloorAreas | null // jsonb
  last_snapshot_url: string | null
  last_seen_at: string | null
  created_at: string
}

// The fields the admin enters from the Tapo app (Device Settings → Device Info)
export type CameraEditable = Pick<
  Camera,
  | 'camera_name'
  | 'active_status'
  | 'edge_device_id'
  | 'tapo_model'
  | 'mac_address'
  | 'ip_address'
  | 'stream_path'
  | 'count_line'
  | 'floor_areas'
>

// ---------- VISIT ----------
// No time column: a visit's time comes from event_time of its
// CCTV_EVENT / RECOGNITION_EVENT rows.
export type Visit = {
  visit_id: string
  branch_id: string
  member_id: string | null
  track_id: string
  visit_type: 'Member' | 'Non-Member' | 'Unknown'
  est_gender: 'Male' | 'Female' | 'Unknown'
  est_age: number | null
  demographic_score: number | null // 0–100
}

// ---------- CCTV_EVENT ----------
export type CctvEvent = {
  cctv_event_id: string
  camera_id: string
  visit_id: string
  // In = came in, or walked into a shop area (Counter, POP display ...); Out = left the shop
  direction: 'In' | 'Out'
  track_region: RegionKind // where the person was: 'Outside Shop' | 'Purchasing' | 'Counter'
  confidence: number // 0–100
  event_time: string
}

// ---------- RECOGNITION_EVENT ----------
export type RecognitionEvent = {
  recognition_event_id: string
  camera_id: string
  visit_id: string
  face_template_id: string | null
  match_score: number // 0–100
  result: 'Matched' | 'Not Matched'
  event_time: string
}

// ---------- TRANSACTION ----------
export type Transaction = {
  transaction_id: string
  branch_id: string
  matched_event_id: string
  amount: number
  status: 'Dealed' | 'Not Detected'
  transaction_date: string
  created_at: string
}

// ---------- MEMBER ----------
export type Member = {
  member_id: string
  member_no: string
  full_name: string
  phone_number: string | null
  email: string | null
  consent_pdpa: boolean
  status: 'Active' | 'Inactive' | 'Terminated'
  joined_at: string
}

export type MemberEditable = Pick<
  Member,
  'member_no' | 'full_name' | 'phone_number' | 'email' | 'consent_pdpa' | 'status'
>

// ---------- MEMBER_FACE_TEMPLATE ----------
export type MemberFaceTemplate = {
  face_template_id: string
  member_id: string
  embedding: string | number[] // pgvector column; PostgREST returns it as text like "[0.1,0.2,...]"
  model_name: string | null
  consent_biometric: true // database only accepts TRUE
  consent_at: string
  revoked_at: string | null
  created_at: string
}