import { useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import BranchesPage from './BranchesPage'
import EditBranchPage from './Editbranch'
import CameraPage from './Camerapage'
import EventsPage, { type EventTab } from './Eventspage'
import MemberPage from './Memberpage'
import TransactionsPage from './Transactionspage'
import DataTable, { Badge } from './Datatable'
import NewBranchPage from './Newbranchpage'
import './dashboard.css'

// Each sidebar page has its own web address, e.g. /camera
type PageKey = 'dashboard' | 'branch' | 'camera' | 'events' | 'members' | 'transactions'

// Titles for sub-pages (the sidebar keeps the parent page highlighted on these)
const SUB_TITLES: { match: RegExp; title: string }[] = [
  { match: /^\/branch\/new$/, title: 'Add Branch' },
  { match: /^\/branch\/[^/]+\/edit$/, title: 'Edit Branch' },
  { match: /^\/camera\/new$/, title: 'Add Camera' },
  { match: /^\/camera\/[^/]+$/, title: 'Camera Details' },
]

const NAV: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" /> },
  { key: 'branch', label: 'Branch', icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" /> },
  { key: 'camera', label: 'Camera', icon: <path d="M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /> },
  { key: 'events', label: 'Event', icon: <path d="M13 2 4 14h7l-1 8 9-12h-7z" /> },
  { key: 'members', label: 'Member', icon: <path d="M3 5h18v14H3zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 16c.5-1.7 1.8-2.5 3-2.5s2.5.8 3 2.5M14 9h4M14 13h4" /> },
  { key: 'transactions', label: 'Transaction', icon: <path d="M3 7h16l-4-4M21 17H5l4 4" /> },
]

export function Logo() {
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

type Gender = 'Male' | 'Female'

type LatestEvent = {
  cctv_event_id: string
  direction: string
  confidence: number
  event_time: string
  camera: { camera_name: string } | null
  visit: { visit_type: string; est_gender: string; est_age: number | null } | null
}

type LatestRecognition = {
  recognition_event_id: string
  match_score: number
  result: string
  event_time: string
  camera: { camera_name: string } | null
  member_face_template: { member: { member_no: string } | null } | null
  visit: { est_gender: string; est_age: number | null } | null
}

type Counts = {
  inCount: number | null
  inMale: number | null
  inFemale: number | null
  outCount: number | null
  outMale: number | null
  outFemale: number | null
  dealed: number | null
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

// Number of cctv_event rows with the given direction (branch = camera's branch),
// optionally only for one estimated gender of the visit
function eventCount(direction: 'In' | 'Out', branch: string, range: Range, gender?: Gender) {
  let q = supabase
    .from(TABLES.cctvEvent)
    .select(
      gender ? 'cctv_event_id, camera!inner(branch_id), visit!inner(est_gender)' : 'cctv_event_id, camera!inner(branch_id)',
      { count: 'exact', head: true },
    )
    .eq('direction', direction)
  if (gender) q = q.eq('visit.est_gender', gender)
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

// select ca.camera_name, cc.direction, cc.confidence, v.visit_type, v.est_gender, v.est_age, cc.event_time
// from cctv_event cc join camera ca on cc.camera_id = ca.camera_id join visit v on cc.visit_id = v.visit_id  (latest 50)
function latestEvents(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.cctvEvent)
    .select(
      'cctv_event_id, direction, confidence, event_time, camera!inner(camera_name, branch_id), visit!inner(visit_type, est_gender, est_age)',
    )
  if (branch) q = q.eq('camera.branch_id', branch)
  if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
  return q.order('event_time', { ascending: false }).limit(50)
}

// select ca.camera_name, m.member_no, v.est_gender, v.est_age, re.match_score, re.result, re.event_time
// from recognition_event re join camera ca on re.camera_id = ca.camera_id
// join member_face_template mft on re.face_template_id = mft.face_template_id
// join member m on mft.member_id = m.member_id join visit v on re.visit_id = v.visit_id  (latest 50)
function latestRecognitions(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.recognitionEvent)
    .select(
      'recognition_event_id, match_score, result, event_time, camera!inner(camera_name, branch_id), member_face_template!inner(member!inner(member_no)), visit!inner(est_gender, est_age)',
    )
  if (branch) q = q.eq('camera.branch_id', branch)
  if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
  return q.order('event_time', { ascending: false }).limit(50)
}

const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null)

function Overview({ onMoreEvents }: { onMoreEvents: (tab: EventTab) => void }) {
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [dates, setDates] = useState<DateOption[]>([])
  const [branch, setBranch] = useState('') // set to the first branch once the branches are loaded
  const [date, setDate] = useState(() => dateKey(new Date().toISOString())) // starts on today; '' = all dates (YYYY-MM-DD)

  const [counts, setCounts] = useState<Counts>({
    inCount: null,
    inMale: null,
    inFemale: null,
    outCount: null,
    outMale: null,
    outFemale: null,
    dealed: null,
  })
  const [events, setEvents] = useState<LatestEvent[]>([])
  const [recognitions, setRecognitions] = useState<LatestRecognition[]>([])
  const [eventTab, setEventTab] = useState<EventTab>('cctv')
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
        else {
          const list = (b.data ?? []) as BranchOption[]
          setBranches(list)
          if (list.length) setBranch((cur) => cur || list[0].branch_id)
          else setLoading(false)
        }

        const keys = Array.from(new Set([...eventTimes, ...transactionTimes].map(dateKey))).sort().reverse()
        setDates(keys.map((key) => ({ key, label: fmtDate(new Date(`${key}T00:00:00`)) })))
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFilterError(err instanceof Error ? err.message : 'Failed to load the filters')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Numbers + latest events, reloaded whenever a filter changes
  useEffect(() => {
    if (!branch) return // wait until a branch is selected
    let cancelled = false
    setLoading(true)
    setError('')
    const range = date ? dayRange(date) : null

    Promise.all([
      eventCount('In', branch, range),
      eventCount('In', branch, range, 'Male'),
      eventCount('In', branch, range, 'Female'),
      eventCount('Out', branch, range),
      eventCount('Out', branch, range, 'Male'),
      eventCount('Out', branch, range, 'Female'),
      dealedCount(branch, range),
      latestEvents(branch, range),
      latestRecognitions(branch, range),
    ]).then(([inRes, inMaleRes, inFemaleRes, outRes, outMaleRes, outFemaleRes, dealRes, evRes, recRes]) => {
      if (cancelled) return
      const failed = [inRes, inMaleRes, inFemaleRes, outRes, outMaleRes, outFemaleRes, dealRes, evRes, recRes].find(
        (r) => r.error,
      )
      if (failed?.error) setError(failed.error.message)
      setCounts({
        inCount: inRes.error ? null : inRes.count,
        inMale: inMaleRes.error ? null : inMaleRes.count,
        inFemale: inFemaleRes.error ? null : inFemaleRes.count,
        outCount: outRes.error ? null : outRes.count,
        outMale: outMaleRes.error ? null : outMaleRes.count,
        outFemale: outFemaleRes.error ? null : outFemaleRes.count,
        dealed: dealRes.error ? null : dealRes.count,
      })
      setEvents(evRes.error ? [] : ((evRes.data ?? []) as unknown as LatestEvent[]))
      setRecognitions(recRes.error ? [] : ((recRes.data ?? []) as unknown as LatestRecognition[]))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [branch, date])

  const stats: {
    label: string
    value: number | null
    male?: number | null
    female?: number | null
    tone?: 'in' | 'out' | 'inside'
  }[] = [
    { label: 'People In', value: counts.inCount, male: counts.inMale, female: counts.inFemale, tone: 'in' },
    { label: 'People Out', value: counts.outCount, male: counts.outMale, female: counts.outFemale, tone: 'out' },
    {
      label: 'People Still Inside',
      value: diff(counts.inCount, counts.outCount),
      male: diff(counts.inMale, counts.outMale),
      female: diff(counts.inFemale, counts.outFemale),
      tone: 'inside',
    },
    { label: 'Transactions Dealed', value: counts.dealed },
  ]

  return (
    <>
      <h1>Dashboard</h1>
      <p className="ds-lead">Overview of your branches and cameras.</p>

      <div className="ds-filters">
        <select aria-label="Filter by branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
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
            max={dates.length && dates[0].key > dateKey(new Date().toISOString()) ? dates[0].key : dateKey(new Date().toISOString())}
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
          <div className={s.tone ? `ds-stat ds-stat--${s.tone}` : 'ds-stat'} key={s.label}>
            <div className="ds-stat-row">
              <small>{s.label}</small>
              <strong>{s.value ?? '—'}</strong>
            </div>
            {s.tone && (
              <>
                <div className="ds-stat-sub">
                  <span>Male:</span>
                  <span>{s.male ?? '—'}</span>
                </div>
                <div className="ds-stat-sub">
                  <span>Female:</span>
                  <span>{s.female ?? '—'}</span>
                </div>
              </>
            )}
          </div>
        ))}
      </section>

      <section className="ds-panel">
        <h2>Latest events (top 50)</h2>
        <div className="ds-tabbar">
          <div className="tabs">
            <button className={eventTab === 'cctv' ? 'active' : ''} onClick={() => setEventTab('cctv')}>
              CCTV Event
            </button>
            <button className={eventTab === 'recognition' ? 'active' : ''} onClick={() => setEventTab('recognition')}>
              Recognition Event
            </button>
          </div>
          <button type="button" className="ds-more" onClick={() => onMoreEvents(eventTab)}>
            {eventTab === 'cctv' ? 'Click for more CCTV events' : 'Click for more recognition events'}
          </button>
        </div>

        {eventTab === 'cctv' ? (
          <DataTable
            rows={events}
            loading={loading}
            error=""
            emptyMessage="No CCTV events found."
            rowKey={(r) => r.cctv_event_id}
            columns={[
              { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
              { header: 'Direction', render: (r) => <Badge text={r.direction} /> },
              { header: 'Confidence', render: (r) => `${Number(r.confidence).toFixed(2)}%` },
              { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
              { header: 'Gender (est.)', render: (r) => r.visit?.est_gender ?? '—' },
              { header: 'Age (est.)', render: (r) => r.visit?.est_age ?? '—' },
              { header: 'Event time', render: (r) => fmtDateTime(r.event_time) },
            ]}
          />
        ) : (
          <DataTable
            rows={recognitions}
            loading={loading}
            error=""
            emptyMessage="No recognition events found."
            rowKey={(r) => r.recognition_event_id}
            columns={[
              { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
              { header: 'Member no.', render: (r) => r.member_face_template?.member?.member_no ?? '—' },
              { header: 'Gender (est.)', render: (r) => r.visit?.est_gender ?? '—' },
              { header: 'Age (est.)', render: (r) => r.visit?.est_age ?? '—' },
              { header: 'Match score', render: (r) => `${Number(r.match_score).toFixed(2)}%` },
              { header: 'Result', render: (r) => <Badge text={r.result} /> },
              { header: 'Event time', render: (r) => fmtDateTime(r.event_time) },
            ]}
          />
        )}
      </section>
    </>
  )
}

// /branch/:branchId/edit
function EditBranchRoute() {
  const { branchId } = useParams()
  const navigate = useNavigate()
  if (!branchId) return <Navigate to="/branch" replace />
  return <EditBranchPage branchId={branchId} onBack={() => navigate('/branch')} />
}

// /events or /events?tab=recognition
function EventsRoute() {
  const [params] = useSearchParams()
  const tab: EventTab = params.get('tab') === 'recognition' ? 'recognition' : 'cctv'
  return <EventsPage key={tab} initialTab={tab} />
}

type DashboardProps = { adminName: string; onSignOut: () => void }

export default function Dashboard({ adminName, onSignOut }: DashboardProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const section = pathname.split('/')[1] || 'dashboard'
  const activeNav = (NAV.some((n) => n.key === section) ? section : 'dashboard') as PageKey

  const mainRef = useRef<HTMLElement>(null)
  const [sideOpen, setSideOpen] = useState(true) // sidebar starts shown
  const lastScrollRef = useRef(0)

  // Phone layout (same width as the @media rule in dashboard.css): when the
  // content is scrolled up, collapse the top sidebar to give the content more room
  function onMainScroll(e: UIEvent<HTMLElement>) {
    const top = e.currentTarget.scrollTop
    const scrolledUp = top > lastScrollRef.current
    lastScrollRef.current = top
    if (sideOpen && scrolledUp && top > 10 && window.matchMedia('(max-width: 760px)').matches) {
      setSideOpen(false)
    }
  }

  useEffect(() => {
    const label = SUB_TITLES.find((t) => t.match.test(pathname))?.title ?? NAV.find((n) => n.key === activeNav)?.label
    document.title = label ? `${label} | JackStudio Retail System Tracking` : 'JackStudio Retail System Tracking'
    mainRef.current?.scrollTo({ top: 0 })
  }, [pathname, activeNav])

  return (
    <div className={sideOpen ? 'ds' : 'ds ds--collapsed'}>
      <aside className="ds-side">
        <div className="ds-side-head">
          <Link className="ds-brand" to="/dashboard" aria-label="Go to dashboard">
            <Logo />
            <div className="ds-brand-text">
              <div className="ds-brand-name">JackStudio</div>
              <div className="ds-brand-sub">Retail System Tracking</div>
            </div>
          </Link>
          <button
            type="button"
            className="ds-toggle"
            aria-label={sideOpen ? 'Hide sidebar' : 'Show sidebar'}
            title={sideOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sideOpen}
            aria-controls="ds-nav"
            onClick={() => setSideOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
              <path d={sideOpen ? 'M15.5 10 13.5 12l2 2' : 'M13.5 10l2 2-2 2'} />
            </svg>
          </button>
        </div>

        <nav className="ds-nav" id="ds-nav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink
              key={n.key}
              to={`/${n.key}`}
              className={activeNav === n.key ? 'active' : ''}
              aria-current={activeNav === n.key ? 'page' : undefined}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{n.icon}</svg>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="ds-live"><i /> System online</div>

        <div className="ds-account">
          <span className="ds-account-name" title={adminName}>{adminName}</span>
          <button type="button" className="ds-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="ds-main" ref={mainRef} onScroll={onMainScroll}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/dashboard"
            element={
              <Overview
                onMoreEvents={(tab) => navigate(tab === 'recognition' ? '/events?tab=recognition' : '/events')}
              />
            }
          />
          <Route
            path="/branch"
            element={
              <BranchesPage
                onAdd={() => navigate('/branch/new')}
                onManage={(id) => navigate(`/branch/${id}/edit`)}
              />
            }
          />
          <Route path="/branch/new" element={<NewBranchPage onBack={() => navigate('/branch')} />} />
          <Route path="/branch/:branchId/edit" element={<EditBranchRoute />} />
          <Route path="/camera/*" element={<CameraPage />} />
          <Route path="/events" element={<EventsRoute />} />
          <Route path="/members" element={<MemberPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  )
}