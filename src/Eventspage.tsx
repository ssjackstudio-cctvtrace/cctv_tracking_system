import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import DataTable, { Badge } from './Datatable'
import { TABLES } from './Usetable'
import { MATCH_SELECT_FULL, matchedName, matchedNo, recognisedBy, type RecognitionMatch } from './Recognition'

export type EventTab = 'cctv' | 'recognition'

// staff / member of a recognised visit (null for a Guest)
type VisitPerson = {
  staff: { staff_no: string; full_name: string; position: string | null } | null
  member: { member_no: string; full_name: string } | null
}

type CctvEventRow = {
  cctv_event_id: string
  direction: string
  track_region: string | null
  confidence: number
  event_time: string
  camera: { camera_name: string; tapo_model: string | null } | null
  visit:
    | ({
        track_id: string
        visit_type: string
        est_gender: string
        est_age: number | null
        demographic_score: number | null
        branch: { branch_name: string } | null
      } & VisitPerson)
    | null
}

type RecognitionEventRow = {
  recognition_event_id: string
  match_score: number
  result: string
  event_time: string
  camera: { camera_name: string; tapo_model: string | null } | null
  visit: {
    track_id: string
    visit_type: string
    est_gender: string
    est_age: number | null
    demographic_score: number | null
    branch: { branch_name: string } | null
  } | null
} & RecognitionMatch // matched by body parts (body_template), a member OR a staff

// DD Month YYYY hh:mm:ss AM/PM, e.g. 05 March 2026 03:45:12 PM (event time)
const fmtDateTime = (iso: string) => {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  return `${date} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}`
}
// DD Month YYYY, e.g. 18 October 2026 (day = YYYY-MM-DD)
const fmtDay = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
const pad = (n: number) => String(n).padStart(2, '0')
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// [start of the day, start of the next day] as ISO strings, in local time
const dayRange = (day: string): [string, string] => {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}
const DAY_LIMIT = 1000 // events shown for one day

// Select filters ('' = All). Direction and track region are only on cctv_event.
type EventFilters = { visitType: string; gender: string; direction: string; trackRegion: string }
const NO_FILTERS: EventFilters = { visitType: '', gender: '', direction: '', trackRegion: '' }
const FILTER_OPTIONS: { key: keyof EventFilters; label: string; options: string[]; cctvOnly?: boolean }[] = [
  { key: 'visitType', label: 'Visit type', options: ['Member', 'Staff', 'Guest'] },
  { key: 'gender', label: 'Gender', options: ['Male', 'Female', 'Unknown'] },
  { key: 'direction', label: 'Direction', options: ['In', 'Out', 'Passed By', 'Not Detected'], cctvOnly: true },
  { key: 'trackRegion', label: 'Track region', options: ['Purchasing', 'Counter', 'Traffic', 'Out of Range'], cctvOnly: true },
]
const fmt2 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toFixed(2))

// Runs a Supabase query once and keeps its rows / loading / error
function useRows<T>(load: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, deps: unknown[]) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    load().then(({ data, error }) => {
      if (cancelled) return
      if (error) setError(error.message)
      setRows(error ? [] : ((data ?? []) as T[]))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { rows, loading, error }
}

// select ca.camera_name, b.branch_name, v.track_id, ca.tapo_model, v.visit_type, v.est_gender, v.est_age, v.demographic_score,
//        s.staff_no, s.full_name, s.position, m.member_no, m.full_name, cc.direction, cc.confidence, cc.event_time
// from cctv_event cc join camera ca on cc.camera_id = ca.camera_id join visit v on cc.visit_id = v.visit_id
// join branch b on v.branch_id = b.branch_id
// left join staff s on v.staff_id = s.staff_id left join member m on v.member_id = m.member_id
// where v.branch_id = <selected branch>
export function CctvEventsTable({
  limit = 100,
  day,
  branch,
  filters = NO_FILTERS,
}: {
  limit?: number
  day?: string
  branch?: string
  filters?: EventFilters
}) {
  const t = useRows<CctvEventRow>(
    () => {
      let q = supabase
        .from(TABLES.cctvEvent)
        .select(
          'cctv_event_id, direction, track_region, confidence, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score, branch(branch_name), staff(staff_no, full_name, position), member(member_no, full_name))',
        )
      if (branch) q = q.eq('visit.branch_id', branch)
      if (day) q = q.gte('event_time', dayRange(day)[0]).lt('event_time', dayRange(day)[1])
      if (filters.visitType) q = q.eq('visit.visit_type', filters.visitType)
      if (filters.gender) q = q.eq('visit.est_gender', filters.gender)
      if (filters.direction) q = q.eq('direction', filters.direction)
      if (filters.trackRegion) q = q.eq('track_region', filters.trackRegion)
      return q.order('event_time', { ascending: false }).limit(day ? Math.max(limit, DAY_LIMIT) : limit)
    },
    [limit, day, branch, filters.visitType, filters.gender, filters.direction, filters.trackRegion],
  )
  return (
    <DataTable
      rows={t.rows}
      loading={t.loading}
      error={t.error}
      emptyMessage="No CCTV events found."
      rowKey={(r) => r.cctv_event_id}
      columns={[
        { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
        { header: 'Branch', render: (r) => r.visit?.branch?.branch_name ?? '—' },
        { header: 'Track ID', render: (r) => r.visit?.track_id ?? '—' },
        { header: 'Tapo model', render: (r) => r.camera?.tapo_model ?? '—' },
        { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
        { header: 'Staff No.', render: (r) => r.visit?.staff?.staff_no ?? '-' },
        { header: 'Staff Name', render: (r) => r.visit?.staff?.full_name ?? '-' },
        { header: 'Position', render: (r) => r.visit?.staff?.position ?? '-' },
        { header: 'Member No.', render: (r) => r.visit?.member?.member_no ?? '-' },
        { header: 'Member Name', render: (r) => r.visit?.member?.full_name ?? '-' },
        { header: 'Gender (est.)', render: (r) => r.visit?.est_gender ?? '—' },
        { header: 'Age (est.)', render: (r) => r.visit?.est_age ?? '—' },
        { header: 'Demographic score', render: (r) => fmt2(r.visit?.demographic_score) },
        { header: 'Direction', render: (r) => <Badge text={r.direction} /> },
        { header: 'Track region', render: (r) => r.track_region ?? '—' },
        { header: 'Confidence', render: (r) => `${fmt2(r.confidence)}%` },
        { header: 'Event time', render: (r) => fmtDateTime(r.event_time) },
      ]}
    />
  )
}

// select ca.camera_name, b.branch_name, v.track_id, ca.tapo_model, v.visit_type, v.est_gender, v.est_age, v.demographic_score,
//        coalesce(m.member_no, s.staff_no), coalesce(m.full_name, s.full_name), re.match_score, re.result, re.event_time
// from recognition_event re join camera ca on re.camera_id = ca.camera_id join visit v on re.visit_id = v.visit_id
// join branch b on v.branch_id = b.branch_id
// left join body_template bt on re.body_template_id = bt.body_template_id
// left join member m on bt.member_id = m.member_id left join staff s on bt.staff_id = s.staff_id
// where v.branch_id = <selected branch>
function RecognitionEventsTable({
  limit = 100,
  day,
  branch,
  filters = NO_FILTERS,
}: {
  limit?: number
  day?: string
  branch?: string
  filters?: EventFilters
}) {
  const t = useRows<RecognitionEventRow>(
    () => {
      let q = supabase
        .from(TABLES.recognitionEvent)
        .select(
          'recognition_event_id, match_score, result, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score, branch(branch_name)), ' + MATCH_SELECT_FULL,
        )
      if (branch) q = q.eq('visit.branch_id', branch)
      if (day) q = q.gte('event_time', dayRange(day)[0]).lt('event_time', dayRange(day)[1])
      if (filters.visitType) q = q.eq('visit.visit_type', filters.visitType)
      if (filters.gender) q = q.eq('visit.est_gender', filters.gender)
      return q.order('event_time', { ascending: false }).limit(day ? Math.max(limit, DAY_LIMIT) : limit)
    },
    [limit, day, branch, filters.visitType, filters.gender],
  )
  return (
    <DataTable
      rows={t.rows}
      loading={t.loading}
      error={t.error}
      emptyMessage="No recognition events found."
      rowKey={(r) => r.recognition_event_id}
      columns={[
        { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
        { header: 'Branch', render: (r) => r.visit?.branch?.branch_name ?? '—' },
        { header: 'Track ID', render: (r) => r.visit?.track_id ?? '—' },
        { header: 'Tapo model', render: (r) => r.camera?.tapo_model ?? '—' },
        { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
        { header: 'Gender (est.)', render: (r) => r.visit?.est_gender ?? '—' },
        { header: 'Age (est.)', render: (r) => r.visit?.est_age ?? '—' },
        { header: 'Demographic score', render: (r) => fmt2(r.visit?.demographic_score) },
        { header: 'Member / Staff no.', render: (r) => matchedNo(r) },
        { header: 'Full name', render: (r) => matchedName(r) },
        { header: 'Matched body', render: (r) => recognisedBy(r) },
        { header: 'Match score', render: (r) => fmt2(r.match_score) },
        { header: 'Result', render: (r) => <Badge text={r.result} /> },
        { header: 'Event time', render: (r) => fmtDateTime(r.event_time) },
      ]}
    />
  )
}

// Date filter shown as DD Month YYYY (e.g. 18 October 2026); clicking it opens the calendar
function DayFilter({ day, onChange }: { day: string; onChange: (day: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const open = () => {
    const el = input.current
    if (!el) return
    try {
      el.showPicker()
    } catch {
      el.focus()
    }
  }
  return (
    <div className="ev-datefilter">
      <span className="ev-datefilter-label">Date</span>
      <button type="button" className="ev-datefilter-button" onClick={open} aria-label={`Date: ${fmtDay(day)}. Change date`}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        {fmtDay(day)}
      </button>
      <input
        ref={input}
        className="ev-datefilter-input"
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={day}
        required
        onChange={(e) => onChange(e.target.value || todayKey())}
      />
      {day !== todayKey() && (
        <button type="button" className="ds-datefilter-clear" onClick={() => onChange(todayKey())}>
          Today
        </button>
      )}
    </div>
  )
}

// One select filter: "Visit type  [All ▾]"
function SelectFilter({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="ev-select" title={disabled ? `${label} is only recorded for CCTV events` : undefined}>
      <span className="ev-datefilter-label">{label}</span>
      <select value={disabled ? '' : value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

type BranchOption = { branch_id: string; branch_name: string }

export default function EventsPage({ initialTab = 'cctv', initialDay }: { initialTab?: EventTab; initialDay?: string }) {
  const [tab, setTab] = useState<EventTab>(initialTab)
  const [day, setDay] = useState(initialDay ?? todayKey)
  const [filters, setFilters] = useState<EventFilters>(NO_FILTERS)
  // Branch filter (no "All"): starts on the first branch once the branches are loaded
  const [branches, setBranches] = useState<BranchOption[] | null>(null)
  const [branch, setBranch] = useState('')
  const [branchError, setBranchError] = useState('')
  useEffect(() => {
    let cancelled = false
    Promise.resolve(
      supabase.from(TABLES.branch).select('branch_id, branch_name').order('branch_name', { ascending: true }),
    )
      .then((b) => {
        if (cancelled) return
        if (b.error) {
          setBranchError(b.error.message)
          setBranches([])
          return
        }
        const list = (b.data ?? []) as BranchOption[]
        setBranches(list)
        if (list.length) setBranch((cur) => cur || list[0].branch_id)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setBranchError(err instanceof Error ? err.message : 'Failed to load the branches')
        setBranches([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  const select = (key: keyof EventFilters) => {
    const f = FILTER_OPTIONS.find((o) => o.key === key)!
    return (
      <SelectFilter
        label={f.label}
        value={filters[key]}
        options={f.options}
        disabled={f.cctvOnly && tab === 'recognition'}
        onChange={(value) => setFilters((cur) => ({ ...cur, [key]: value }))}
      />
    )
  }
  return (
    <>
      <h1>Event History</h1>
      <p className="ds-lead">Activity detected by the cameras on {fmtDay(day)}.</p>
      <div className="ds-filters">
        <select aria-label="Filter by branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
          {(branches ?? []).map((b) => (
            <option key={b.branch_id} value={b.branch_id}>
              {b.branch_name}
            </option>
          ))}
        </select>
      </div>
      {branchError && <p className="ds-error">The branches failed to load: {branchError}</p>}
      <div className="ev-toolbar">
        <div className="tabs">
          <button className={tab === 'cctv' ? 'active' : ''} onClick={() => setTab('cctv')}>
            CCTV Event
          </button>
          <button className={tab === 'recognition' ? 'active' : ''} onClick={() => setTab('recognition')}>
            Recognition Event
          </button>
        </div>
      </div>
      {/* Sidebar expanded: date + 4 selects in one row. Collapsed: date + visit type, then the other 3 below */}
      <div className="ev-filters">
        <div className="ev-filter-row">
          <DayFilter day={day} onChange={setDay} />
          {select('visitType')}
        </div>
        <div className="ev-filter-row">
          {select('gender')}
          {select('direction')}
          {select('trackRegion')}
        </div>
      </div>
      <div className="event-log-scroll">
        {/* Wait for a branch so the tables never show every branch at once */}
        {!branch ? (
          <p className="ds-empty">{branches === null ? 'Loading…' : 'No branches found.'}</p>
        ) : tab === 'cctv' ? (
          <CctvEventsTable day={day} branch={branch} filters={filters} />
        ) : (
          <RecognitionEventsTable day={day} branch={branch} filters={filters} />
        )}
      </div>
    </>
  )
}
