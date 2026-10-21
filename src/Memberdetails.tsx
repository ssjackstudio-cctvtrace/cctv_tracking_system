import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Member } from './types'
import { BackButton, DetailList, StatusBadge, fmtDob, fmtLongDate, orDash } from './Peoplecards.tsx'
import './Members.css'

// select member_no, full_name, phone_number, gender, dob, email, status, joined_at from member where member_id = <id>
const COLUMNS = 'member_id, member_no, full_name, phone_number, gender, dob, email, consent_pdpa, status, joined_at'

export default function MemberDetailsPage({ memberId, onBack }: { memberId: string; onBack: () => void }) {
  const [member, setMember] = useState<Member | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    supabase
      .from(TABLES.member)
      .select(COLUMNS)
      .eq('member_id', memberId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        else setMember(data as Member | null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [memberId])

  return (
    <>
      <BackButton label="Back to Member page" onClick={onBack} />
      <h1>Member Details</h1>

      {loading && <p className="ds-empty">Loading…</p>}
      {error && <p className="ds-error">Failed to load the member: {error}</p>}
      {!loading && !error && !member && <p className="ds-empty">This member was not found.</p>}

      {member && (
        <div className="mc pd-card">
          <h2 className="mc-title">{member.member_no}</h2>
          <DetailList
            rows={[
              { label: 'Member Name', value: member.full_name },
              { label: 'Date of birth', value: fmtDob(member.dob) },
              { label: 'Phone number', value: orDash(member.phone_number) },
              { label: 'Email', value: orDash(member.email) },
              { label: 'Gender', value: orDash(member.gender) },
              { label: 'Joined at', value: fmtLongDate(member.joined_at) },
              { label: 'Status', value: <StatusBadge status={member.status} /> },
            ]}
          />
        </div>
      )}
    </>
  )
}
