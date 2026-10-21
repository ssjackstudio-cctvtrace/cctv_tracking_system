import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import { STAFF_COLUMNS, type StaffRow } from './Staffpage'
import { BackButton, DetailList, StatusBadge, fmtDob, fmtLongDateTime, orDash } from './Peoplecards'
import './Members.css'

// select s.staff_no, s.full_name, s.phone_number, s.email, s.gender, s.dob, s.position, s.status,
//        s.designed_at, s.resigned_at, b.branch_name
// from staff s join branch b on s.branch_id = b.branch_id where s.staff_id = <id>
export default function StaffDetailsPage({ staffId, onBack }: { staffId: string; onBack: () => void }) {
  const [staff, setStaff] = useState<StaffRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    supabase
      .from(TABLES.staff)
      .select(STAFF_COLUMNS)
      .eq('staff_id', staffId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        else setStaff(data as unknown as StaffRow | null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [staffId])

  return (
    <>
      <BackButton label="Back to Staff page" onClick={onBack} />
      <h1>Staff Details</h1>

      {loading && <p className="ds-empty">Loading…</p>}
      {error && <p className="ds-error">Failed to load the staff: {error}</p>}
      {!loading && !error && !staff && <p className="ds-empty">This staff was not found.</p>}

      {staff && (
        <div className="mc pd-card">
          <h2 className="mc-title">{staff.staff_no}</h2>
          <DetailList
            rows={[
              { label: 'Staff Name', value: staff.full_name },
              { label: 'Date of birth', value: fmtDob(staff.dob) },
              { label: 'Branch', value: orDash(staff.branch?.branch_name) },
              { label: 'Position', value: orDash(staff.position) },
              { label: 'Phone number', value: orDash(staff.phone_number) },
              { label: 'Email', value: orDash(staff.email) },
              { label: 'Gender', value: orDash(staff.gender) },
              { label: 'Designed at', value: fmtLongDateTime(staff.designed_at) },
              { label: 'Resigned at', value: fmtLongDateTime(staff.resigned_at) },
              { label: 'Status', value: <StatusBadge status={staff.status} /> },
            ]}
          />
        </div>
      )}
    </>
  )
}
