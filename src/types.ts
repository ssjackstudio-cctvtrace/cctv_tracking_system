// Types that match the Supabase tables (public schema).
// uuid, timestamptz and inet columns come back from Supabase as strings.

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
  created_at: string
}

export type EdgeDeviceEditable = Pick<EdgeDevice, 'branch_id' | 'device_name'>

// ---------- CAMERA ----------
// Points use 0–1 coordinates (fraction of the image width/height), so they
// still fit if the stream resolution changes. Keep this shape the same as
// what the edge box reads.
export type Point = { x: number; y: number }
export type CountLine = { start: Point; end: Point }
export type CounterZone = { points: Point[] }

export type Camera = {
  camera_id: string
  camera_name: string
  active_status: 'Active' | 'Inactive'
  branch_id: string
  edge_device_id: string | null
  tapo_model: string | null
  mac_address: string | null
  ip_address: string | null // inet
  stream_path: 'stream1' | 'stream2' | null
  count_line: CountLine | null // jsonb
  counter_zone: CounterZone | null // jsonb
  last_snapshot_url: string | null
  last_seen_at: string | null
  created_at: string
}

// The fields the admin enters from the Tapo app (Device Settings → Device Info)
export type CameraEditable = Pick<
  Camera,
  | 'camera_name'
  | 'active_status'
  | 'branch_id'
  | 'edge_device_id'
  | 'tapo_model'
  | 'mac_address'
  | 'ip_address'
  | 'stream_path'
  | 'count_line'
  | 'counter_zone'
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
  direction: 'In' | 'Out' | 'Counter' | 'Not Detected'
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