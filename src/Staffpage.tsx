import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Branch, Staff } from './types'
import { DetailList, GENDERS, StatusBadge, fmtDob, fmtLongDateTime, orDash } from './Peoplecards'
import './Members.css'

export type StaffRow = Staff & { branch: { branch_name: string } | null }

// select s.staff_no, s.full_name, s.phone_number, s.email, s.gender, s.dob, s.position, s.status,
//        s.designed_at, s.resigned_at, b.branch_name
// from staff s join branch b on s.branch_id = b.branch_id
export const STAFF_COLUMNS =
  'staff_id, staff_no, full_name, phone_number, email, consent_pdpa, gender, dob, position, status, designed_at, resigned_at, branch_id, branch!inner(branch_name)'
const STATUSES: Staff['status'][] = ['Active', 'Inactive', 'Resigned']

// Reads every staff (pages of 1,000, up to 10,000 rows)
async function loadStaff(): Promise<StaffRow[]> {
  const out: StaffRow[] = []
  for (let from = 0; from < 10000; from += 1000) {
    const { data, error } = await supabase
      .from(TABLES.staff)
      .select(STAFF_COLUMNS)
      .order('staff_no', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as StaffRow[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

function StaffCard({ staff, onView }: { staff: StaffRow; onView: () => void }) {
  return (
    <div className="mc">
      <h2 className="mc-title">{staff.staff_no}</h2>
      <DetailList
        rows={[
          { label: 'Staff Name', value: staff.full_name },
          { label: 'Gender', value: orDash(staff.gender) },
          { label: 'Date of birth', value: fmtDob(staff.dob) },
          { label: 'Position', value: orDash(staff.position) },
          { label: 'Email', value: orDash(staff.email) },
          { label: 'Designed at', value: fmtLongDateTime(staff.designed_at) },
          { label: 'Resigned at', value: fmtLongDateTime(staff.resigned_at) },
          { label: 'Status', value: <StatusBadge status={staff.status} /> },
        ]}
      />
      <div className="mc-actions">
        <button type="button" className="mc-btn" onClick={onView}>
          View Staff Details
        </button>
      </div>
    </div>
  )
}

export default function StaffPage({ onView }: { onView: (staffId: string) => void }) {
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [branches, setBranches] = useState<Pick<Branch, 'branch_id' | 'branch_name'>[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [search, setSearch] = useState('')
  const [branch, setBranch] = useState('') // branch_id; '' = all branches
  const [gender, setGender] = useState('') // '' = all genders
  const [status, setStatus] = useState('') // '' = all statuses

  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadStaff(),
      supabase.from(TABLES.branch).select('branch_id, branch_name').order('branch_name', { ascending: true }),
    ])
      .then(([rows, b]) => {
        if (cancelled) return
        setStaff(rows)
        if (b.error) setLoadError(b.error.message)
        else setBranches((b.data ?? []) as Pick<Branch, 'branch_id' | 'branch_name'>[])
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load staff')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Live filtering: runs on every keystroke / filter change
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return staff.filter((s) => {
      if (branch && s.branch_id !== branch) return false
      if (gender && s.gender !== gender) return false
      if (status && s.status !== status) return false
      if (!q) return true
      return [s.staff_no, s.full_name, s.email].some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [staff, search, branch, gender, status])

  return (
    <>
      <h1>Staff</h1>
      <p className="ds-lead">Search and view the staff of every branch.</p>

      <div className="mp-toolbar mp-toolbar--staff">
        <input
          type="search"
          className="mp-search"
          placeholder="Search staff no, name or email"
          aria-label="Search staff"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="mp-select" aria-label="Filter by branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.branch_id} value={b.branch_id}>
              {b.branch_name}
            </option>
          ))}
        </select>
        <select className="mp-select" aria-label="Filter by gender" value={gender} onChange={(e) => setGender(e.target.value)}>
          <option value="">All genders</option>
          {GENDERS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select className="mp-select" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="ds-empty">Loading…</p>}
      {loadError && <p className="ds-error">Failed to load staff: {loadError}</p>}
      {!loading && !loadError && staff.length === 0 && <p className="ds-empty">No staff found.</p>}
      {!loading && staff.length > 0 && filtered.length === 0 && <p className="ds-empty">No staff match your search.</p>}

      <div className="mp-grid">
        {filtered.map((s) => (
          <StaffCard key={s.staff_id} staff={s} onView={() => onView(s.staff_id)} />
        ))}
      </div>
    </>
  )
}
