import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Member } from './types'
import { DetailList, GENDERS, StatusBadge, fmtDob, fmtLongDate, orDash } from './Peoplecards'
import './Members.css'

// select member_id, member_no, full_name, phone_number, gender, dob, email, status, joined_at from member
const COLUMNS = 'member_id, member_no, full_name, phone_number, gender, dob, email, consent_pdpa, status, joined_at'
const STATUSES: Member['status'][] = ['Active', 'Inactive', 'Terminated']

// Reads every member (pages of 1,000, up to 10,000 rows)
async function loadMembers(): Promise<Member[]> {
  const out: Member[] = []
  for (let from = 0; from < 10000; from += 1000) {
    const { data, error } = await supabase
      .from(TABLES.member)
      .select(COLUMNS)
      .order('member_no', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Member[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

function MemberCard({ member, onView }: { member: Member; onView: () => void }) {
  return (
    <div className="mc">
      <h2 className="mc-title">{member.member_no}</h2>
      <DetailList
        rows={[
          { label: 'Member Name', value: member.full_name },
          { label: 'Gender', value: orDash(member.gender) },
          { label: 'Date of birth', value: fmtDob(member.dob) },
          { label: 'Email', value: orDash(member.email) },
          { label: 'Joined at', value: fmtLongDate(member.joined_at) },
          { label: 'Status', value: <StatusBadge status={member.status} /> },
        ]}
      />
      <div className="mc-actions">
        <button type="button" className="mc-btn" onClick={onView}>
          View Member Details
        </button>
      </div>
    </div>
  )
}

export default function MemberPage({ onView }: { onView: (memberId: string) => void }) {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [search, setSearch] = useState('')
  const [gender, setGender] = useState('') // '' = all genders
  const [status, setStatus] = useState('') // '' = all statuses

  useEffect(() => {
    let cancelled = false
    loadMembers()
      .then((rows) => {
        if (!cancelled) setMembers(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load members')
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
    return members.filter((m) => {
      if (gender && m.gender !== gender) return false
      if (status && m.status !== status) return false
      if (!q) return true
      return [m.member_no, m.full_name, m.email].some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [members, search, gender, status])

  return (
    <>
      <h1>Member</h1>
      <p className="ds-lead">Search and view your members.</p>

      <div className="mp-toolbar mp-toolbar--member">
        <input
          type="search"
          className="mp-search"
          placeholder="Search member no, name or email"
          aria-label="Search member"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
      {loadError && <p className="ds-error">Failed to load members: {loadError}</p>}
      {!loading && !loadError && members.length === 0 && <p className="ds-empty">No members found.</p>}
      {!loading && members.length > 0 && filtered.length === 0 && (
        <p className="ds-empty">No members match your search.</p>
      )}

      <div className="mp-grid">
        {filtered.map((m) => (
          <MemberCard key={m.member_id} member={m} onView={() => onView(m.member_id)} />
        ))}
      </div>
    </>
  )
}
