export type Branch = {
  branch_id: string // uuid
  branch_name: string
  house_unit: string | null
  street: string | null
  township: string | null
  formatted_address: string
  postal_code: string
  city: string
  state: string
  country: string | null
  google_place_id: string | null
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

export type Camera = {
  camera_id: string
  camera_name: string
  active_status: 'Active' | 'Inactive'
  branch_id: string
}

export type Visit = {
  visit_id: string
  branch_id: string
  member_id: string | null
  track_id: string
  visit_type: 'Member' | 'Non-Member' | 'Unknown'
  est_gender: 'Male' | 'Female' | 'Unknown'
  est_age: number | null
  demongraphic_score: number | null // spelled as in the data dictionary
}

export type CctvEvent = {
  cctv_event_id: string
  camera_id: string
  visit_id: string
  direction: 'In' | 'Out' | 'Counter' | 'Not Detected'
  confidence: number
  event_time: string
}

export type RecognitionEvent = {
  recognition_event_id: string
  camera_id: string
  visit_id: string
  match_score: number
  result: 'Matched' | 'Not Matched'
  event_time: string
}

export type Transaction = {
  transaction_id: string
  matched_event_id: string
  amount: number
  status: 'Dealed' | 'Not Detected'
  transaction_date: string
}

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

export type MemberFaceTemplate = {
  face_template_id: string
  member_id: string
  embedding: string | number[] // pgvector column; PostgREST returns it as text like "[0.1,0.2,...]"
  consent_biometric: boolean
  consent_at: string
  revoked_at: string | null
}