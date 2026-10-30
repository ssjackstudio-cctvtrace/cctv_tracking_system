// Who a recognition_event matched, and how (supabase/body_view_angle_staff_track.sql):
// by BODY parts from any angle (body_template, 360°). The person comes from the
// template's photo: body_template → biometric_photo → member OR staff.

import { sideOf } from './Bodycheck'

type Person = { member_no?: string; staff_no?: string; full_name?: string }
type Template = { biometric_photo: { member: Person | null; staff: Person | null } | null } | null

export type RecognitionMatch = {
  body_view_angle?: number | null
  matched_parts?: string[] | null
  body_template: Template
}

// PostgREST embed for the matched member / staff
export const MATCH_SELECT_FULL =
  'body_view_angle, matched_parts, body_template(biometric_photo(member(member_no, full_name), staff(staff_no, full_name)))'
export const MATCH_SELECT_NO = 'body_template(biometric_photo(member(member_no), staff(staff_no)))'

const personOf = (r: RecognitionMatch): Person | null => {
  const p = r.body_template?.biometric_photo
  return p?.member ?? p?.staff ?? null
}

export const matchedNo = (r: RecognitionMatch) => {
  const p = personOf(r)
  return p?.member_no ?? p?.staff_no ?? '—'
}

export const matchedName = (r: RecognitionMatch) => personOf(r)?.full_name ?? '—'

// "Left side 95° (Head, Upper body)"
export function recognisedBy(r: RecognitionMatch): string {
  const hasAngle = r.body_view_angle !== null && r.body_view_angle !== undefined
  if (!hasAngle && !r.matched_parts?.length) return '—'
  const view = hasAngle ? `${sideOf(r.body_view_angle!)} ${r.body_view_angle}°` : 'Body'
  const parts = r.matched_parts?.length ? ` (${r.matched_parts.join(', ')})` : ''
  return `${view}${parts}`
}
