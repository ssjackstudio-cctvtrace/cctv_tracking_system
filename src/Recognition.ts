// Who a recognition_event matched, and how (supabase/biometric_photo.sql):
// by BODY parts from any side (body_template, 360°). Each template belongs to
// a member OR a staff.

type Person = { member_no?: string; staff_no?: string; full_name?: string }
type Template = { member: Person | null; staff: Person | null } | null

export type RecognitionMatch = {
  body_view?: string | null
  matched_parts?: string[] | null
  body_template: Template
}

// PostgREST embed for the matched member / staff
export const MATCH_SELECT_FULL =
  'body_view, matched_parts, body_template(member(member_no, full_name), staff(staff_no, full_name))'
export const MATCH_SELECT_NO = 'body_template(member(member_no), staff(staff_no))'

const personOf = (r: RecognitionMatch): Person | null => r.body_template?.member ?? r.body_template?.staff ?? null

export const matchedNo = (r: RecognitionMatch) => {
  const p = personOf(r)
  return p?.member_no ?? p?.staff_no ?? '—'
}

export const matchedName = (r: RecognitionMatch) => personOf(r)?.full_name ?? '—'

// "Back view (Head, Upper body)"
export function recognisedBy(r: RecognitionMatch): string {
  if (!r.body_view && !r.matched_parts?.length) return '—'
  const view = r.body_view ? `${r.body_view} view` : 'Body'
  const parts = r.matched_parts?.length ? ` (${r.matched_parts.join(', ')})` : ''
  return `${view}${parts}`
}
