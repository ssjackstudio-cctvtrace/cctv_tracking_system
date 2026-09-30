import { useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import BranchesPage from './BranchesPage'
import EditBranchPage from './Editbranch'
import CameraPage from './Camerapage'
import EventsPage from './Eventspage'
import VisitsPage from './Visitspage'
import TransactionsPage from './Transactionspage'
import DataTable, { Badge } from './Datatable'
import NewBranchPage from './Newbranchpage'
import './dashboard.css'

type PageKey = 'dashboard' | 'branch' | 'camera' | 'events' | 'visits' | 'transactions'
// Sub-pages of Branch (sidebar keeps "Branch" highlighted on these)
type ViewKey = PageKey | 'branchAdd' | 'branchEdit'

const SUB_TITLES: Partial<Record<ViewKey, string>> = {
  branchAdd: 'Add Branch',
  branchEdit: 'Edit Branch',
}

const NAV: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" /> },
  { key: 'branch', label: 'Branch', icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" /> },
  { key: 'camera', label: 'Camera', icon: <path d="M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /> },
  { key: 'events', label: 'Event', icon: <path d="M13 2 4 14h7l-1 8 9-12h-7z" /> },
  { key: 'visits', label: 'Visit', icon: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /> },
  { key: 'transactions', label: 'Transaction', icon: <path d="M3 7h16l-4-4M21 17H5l4 4" /> },
]

function Logo() {
  return (
    <svg className="ds-logo" viewBox="465 130 270 270" aria-hidden="true">
      <rect x="465" y="130" width="270" height="270" rx="58" fill="#ffffff" />
      <g fill="none" stroke="#111111" strokeWidth="13" strokeLinejoin="miter">
        <path d="M562 158A113 113 0 0 1 712 292" />
        <path d="M668 352A113 113 0 0 1 487 240" />
        <path d="M512 208L538 178L668 352" />
      </g>
    </svg>
  )
}

type BranchOption = { branch_id: string; branch_name: string }
type DateOption = { key: string; label: string }
type Range = readonly [string, string] | null

type LatestEvent = {
  cctv_event_id: string
  direction: string
  confidence: number
  event_time: string
  camera: { camera_name: string } | null
  visit: { visit_type: string } | null
}

const pad = (n: number) => String(n).padStart(2, '0')
// Local calendar day of a timestamp, e.g. 2026-09-30
const dateKey = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// DD Month YYYY, e.g. 05 March 2026
const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
// DD Month YYYY hh:mm AM/PM, e.g. 05 March 2026 03:45 PM
const fmtDateTime = (iso: string) => {
  const d = new Date(iso)
  return `${fmtDate(d)} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`
}
// [start of the day, start of the next day] as ISO strings
const dayRange = (key: string): Range => {
  const start = new Date(`${key}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

// All timestamps of one column (read in pages of 1,000, up to 20,000 rows)
async function loadTimes(table: string, column: string): Promise<string[]> {
  const out: string[] = []
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .order(column, { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as Record<string, string>[]
    out.push(...rows.map((r) => r[column]))
    if (rows.length < 1000) break
  }
  return out
}

// Number of cctv_event rows with the given direction (branch = camera's branch)
function eventCount(direction: 'In' | 'Out', branch: string, range: Range) {
  let q = supabase
    .from(TABLES.cctvEvent)
    .select('cctv_event_id, camera!inner(branch_id)', { count: 'exact', head: true })
    .eq('direction', direction)
  if (branch) q = q.eq('camera.branch_id', branch)
  if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
  return q
}

// Number of transactions with status 'Dealed' (branch = branch of the matched event's camera)
function dealedCount(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.transaction)
    .select('transaction_id, cctv_event!inner(camera!inner(branch_id))', { count: 'exact', head: true })
    .eq('status', 'Dealed')
  if (branch) q = q.eq('cctv_event.camera.branch_id', branch)
  if (range) q = q.gte('transaction_date', range[0]).lt('transaction_date', range[1])
  return q
}

// select ca.camera_name, v.visit_type, cc.direction, cc.confidence, cc.event_time
// from cctv_event cc join camera ca on ... join visit v on ...  (latest 50)
function latestEvents(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.cctvEvent)
    .select(
      'cctv_event_id, direction, confidence, event_time, camera!inner(camera_name, branch_id), visit!inner(visit_type)',
    )
  if (branch) q = q.eq('camera.branch_id', branch)
  if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
  return q.order('event_time', { ascending: false }).limit(50)
}

function Overview() {
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [dates, setDates] = useState<DateOption[]>([])
  const [branch, setBranch] = useState('') // '' = all branches
  const [date, setDate] = useState('') // '' = all dates (YYYY-MM-DD)

  const [counts, setCounts] = useState<{ inCount: number | null; outCount: number | null; dealed: number | null }>({
    inCount: null,
    outCount: null,
    dealed: null,
  })
  const [events, setEvents] = useState<LatestEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filterError, setFilterError] = useState('')
  const [error, setError] = useState('')

  // Options for the two filters
  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from(TABLES.branch).select('branch_id, branch_name').order('branch_name', { ascending: true }),
      loadTimes(TABLES.cctvEvent, 'event_time'),
      loadTimes(TABLES.transaction, 'transaction_date'),
    ])
      .then(([b, eventTimes, transactionTimes]) => {
        if (cancelled) return
        if (b.error) setFilterError(b.error.message)
        else setBranches((b.data ?? []) as BranchOption[])

        const keys = Array.from(new Set([...eventTimes, ...transactionTimes].map(dateKey))).sort().reverse()
        setDates(keys.map((key) => ({ key, label: fmtDate(new Date(`${key}T00:00:00`)) })))
      })
      .catch((err: unknown) => {
        if (!cancelled) setFilterError(err instanceof Error ? err.message : 'Failed to load the filters')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Numbers + latest events, reloaded whenever a filter changes
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const range = date ? dayRange(date) : null

    Promise.all([
      eventCount('In', branch, range),
      eventCount('Out', branch, range),
      dealedCount(branch, range),
      latestEvents(branch, range),
    ]).then(([inRes, outRes, dealRes, evRes]) => {
      if (cancelled) return
      const failed = [inRes, outRes, dealRes, evRes].find((r) => r.error)
      if (failed?.error) setError(failed.error.message)
      setCounts({
        inCount: inRes.error ? null : inRes.count,
        outCount: outRes.error ? null : outRes.count,
        dealed: dealRes.error ? null : dealRes.count,
      })
      setEvents(evRes.error ? [] : ((evRes.data ?? []) as unknown as LatestEvent[]))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [branch, date])

  const inside =
    counts.inCount !== null && counts.outCount !== null ? counts.inCount - counts.outCount : null

  const stats: { label: string; value: number | null }[] = [
    { label: 'People In', value: counts.inCount },
    { label: 'People Out', value: counts.outCount },
    { label: 'People Still Inside', value: inside },
    { label: 'Transactions Dealed', value: counts.dealed },
  ]

  return (
    <>
      <h1>Dashboard</h1>
      <p className="ds-lead">Overview of your branches and cameras.</p>

      <div className="ds-filters">
        <select aria-label="Filter by branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.branch_id} value={b.branch_id}>
              {b.branch_name}
            </option>
          ))}
        </select>
        <div className="ds-datefilter">
          <input
            type="date"
            aria-label="Filter by date"
            value={date}
            min={dates.length ? dates[dates.length - 1].key : undefined}
            max={dates.length ? dates[0].key : undefined}
            onChange={(e) => setDate(e.target.value)}
          />
          <span className="ds-datefilter-label">
            {date ? fmtDate(new Date(`${date}T00:00:00`)) : 'All dates'}
          </span>
          {date && (
            <button type="button" className="ds-datefilter-clear" onClick={() => setDate('')}>
              Clear
            </button>
          )}
        </div>
      </div>

      {filterError && <p className="ds-error">Some filters failed to load: {filterError}</p>}
      {error && <p className="ds-error">Some numbers failed to load: {error}</p>}

      <section className="ds-stats">
        {stats.map((s) => (
          <div className="ds-stat" key={s.label}>
            <small>{s.label}</small>
            <strong>{s.value ?? '—'}</strong>
          </div>
        ))}
      </section>

      <section className="ds-panel">
        <h2>Latest events (top 50)</h2>
        <DataTable
          rows={events}
          loading={loading}
          error=""
          emptyMessage="No CCTV events found."
          rowKey={(r) => r.cctv_event_id}
          columns={[
            { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
            { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
            { header: 'Direction', render: (r) => <Badge text={r.direction} /> },
            { header: 'Confidence', render: (r) => `${Number(r.confidence).toFixed(2)}%` },
            { header: 'Event time', render: (r) => fmtDateTime(r.event_time) },
          ]}
        />
      </section>
    </>
  )
}

export default function Dashboard() {
  const [page, setPage] = useState<ViewKey>('dashboard')
  const [branchId, setBranchId] = useState<string | null>(null)
  const activeNav: PageKey = page === 'branchAdd' || page === 'branchEdit' ? 'branch' : page

  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const label = SUB_TITLES[page] ?? NAV.find((n) => n.key === page)?.label
    document.title = label ? `${label} | JackStudio CCTV Tracking` : 'JackStudio CCTV Tracking'
    mainRef.current?.scrollTo({ top: 0 })
  }, [page])

  return (
    <div className="ds">
      <aside className="ds-side">
        <div
          className="ds-brand"
          role="button"
          tabIndex={0}
          aria-label="Go to dashboard"
          style={{ cursor: 'pointer' }}
          onClick={() => setPage('dashboard')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setPage('dashboard')
            }
          }}
        >
          <Logo />
          <div>
            <div className="ds-brand-name">JackStudio</div>
            <div className="ds-brand-sub">CCTV Tracking</div>
          </div>
        </div>

        <nav className="ds-nav" aria-label="Main">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={activeNav === n.key ? 'active' : ''}
              aria-current={activeNav === n.key ? 'page' : undefined}
              onClick={() => setPage(n.key)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{n.icon}</svg>
              {n.label}
            </button>
          ))}
        </nav>

        <div className="ds-live"><i /> System online</div>
      </aside>

      <main className="ds-main" ref={mainRef}>
        {page === 'dashboard' && <Overview />}
        {page === 'branch' && (
          <BranchesPage
            onAdd={() => setPage('branchAdd')}
            onManage={(id) => {
              setBranchId(id)
              setPage('branchEdit')
            }}
          />
        )}
        {page === 'branchAdd' && <NewBranchPage onBack={() => setPage('branch')} />}
        {page === 'branchEdit' && branchId && <EditBranchPage branchId={branchId} onBack={() => setPage('branch')} />}
        {page === 'camera' && <CameraPage />}
        {page === 'events' && <EventsPage />}
        {page === 'visits' && <VisitsPage />}
        {page === 'transactions' && <TransactionsPage />}
      </main>
    </div>
  )
}