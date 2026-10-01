import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Member } from './types'
import { Badge } from './Datatable'
import './Members.css'

const COLUMNS = 'member_id, member_no, full_name, phone_number, email, consent_pdpa, status, joined_at'
const STATUSES: Member['status'][] = ['Active', 'Inactive', 'Terminated']

const pad = (n: number) => String(n).padStart(2, '0')
// Local calendar day, e.g. 2026-09-30
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// DD Month YYYY, e.g. 05 March 2026
const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })

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

function MemberCard({ member }: { member: Member }) {
  const rows: { label: string; value: ReactNode }[] = [
    { label: 'Full name', value: member.full_name },
    { label: 'Phone number', value: member.phone_number || '—' },
    { label: 'Email', value: member.email || '—' },
    { label: 'Status', value: <Badge text={member.status} /> },
    { label: 'Joined at', value: member.joined_at ? fmtDate(new Date(member.joined_at)) : '—' },
  ]

  return (
    <div className="mc">
      <h2 className="mc-title">{member.member_no}</h2>
      <div className="mc-details">
        {rows.map((r) => (
          <div className="mc-row" key={r.label}>
            <span className="mc-label">{r.label}</span>
            <span className="mc-colon">:</span>
            <span className="mc-value">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function MemberPage() {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('') // '' = all statuses
  const [joined, setJoined] = useState(() => dayKey(new Date())) // starts on today; '' = all dates

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
      if (status && m.status !== status) return false
      if (joined && dayKey(new Date(m.joined_at)) !== joined) return false
      if (!q) return true
      return [m.member_no, m.full_name, m.email].some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [members, search, status, joined])

  return (
    <>
      <h1>Member</h1>
      <p className="ds-lead">Search and view your members.</p>

      <div className="mp-toolbar">
        <input
          type="search"
          className="mp-search"
          placeholder="Search member no, name or email"
          aria-label="Search member"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="mp-select"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="mp-date">
          <input
            type="date"
            aria-label="Filter by joined date"
            value={joined}
            onChange={(e) => setJoined(e.target.value)}
          />
          <span className="mp-date-label">{joined ? fmtDate(new Date(`${joined}T00:00:00`)) : 'All dates'}</span>
          {joined && (
            <button type="button" className="mp-date-clear" onClick={() => setJoined('')}>
              Clear
            </button>
          )}
        </div>
      </div>

      {loading && <p className="ds-empty">Loading…</p>}
      {loadError && <p className="ds-error">Failed to load members: {loadError}</p>}
      {!loading && !loadError && members.length === 0 && <p className="ds-empty">No members found.</p>}
      {!loading && members.length > 0 && filtered.length === 0 && (
        <p className="ds-empty">No members match your search.</p>
      )}

      <div className="mp-grid">
        {filtered.map((m) => (
          <MemberCard key={m.member_id} member={m} />
        ))}
      </div>
    </>
  )
}