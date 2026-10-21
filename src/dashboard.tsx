import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import BranchesPage from './BranchesPage'
import EditBranchPage from './Editbranch'
import CameraPage from './Camerapage'
import EdgeDevicePage from './Edgedevicepage'
import { EditEdgeDevicePage, NewEdgeDevicePage } from './Edgedeviceform'
import EventsPage, { type EventTab } from './Eventspage'
import MemberPage from './Memberpage'
import TransactionsPage from './Transactionspage'
import DataTable, { Badge } from './Datatable'
import NewBranchPage from './Newbranchpage'
import './dashboard.css'

// Each sidebar page has its own web address, e.g. /camera
type PageKey = 'dashboard' | 'branch' | 'camera' | 'edge-device' | 'eventhistory' | 'members' | 'transactions'

// Titles for sub-pages (the sidebar keeps the parent page highlighted on these)
const SUB_TITLES: { match: RegExp; title: string }[] = [
  { match: /^\/branch\/new$/, title: 'Add Branch' },
  { match: /^\/branch\/[^/]+\/edit$/, title: 'Edit Branch' },
  { match: /^\/camera\/new$/, title: 'Add Camera' },
  { match: /^\/camera\/[^/]+$/, title: 'Camera Details' },
  { match: /^\/camera\/[^/]+\/edit$/, title: 'Edit Camera' },
  { match: /^\/edge-device\/new$/, title: 'New AI Edge Box' },
  { match: /^\/edge-device\/[^/]+\/edit$/, title: 'Edit AI Edge Box' },
]

const NAV: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" /> },
  { key: 'branch', label: 'Branch', icon: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" /> },
  { key: 'edge-device', label: 'AI Edge Device', icon: <path d="M6 6h12v12H6zM9.5 9.5h5v5h-5zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /> },
  { key: 'camera', label: 'Camera', icon: <path d="M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /> },
  { key: 'eventhistory', label: 'Event History', icon: <path d="M13 2 4 14h7l-1 8 9-12h-7z" /> },
  { key: 'members', label: 'Member', icon: <path d="M3 5h18v14H3zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 16c.5-1.7 1.8-2.5 3-2.5s2.5.8 3 2.5M14 9h4M14 13h4" /> },
  { key: 'transactions', label: 'Transaction', icon: <path d="M3 7h16l-4-4M21 17H5l4 4" /> },
]

export function Logo() {
  return (
    <svg className="ds-logo" viewBox="465 130 320 320" aria-hidden="true">
      {/* No background. Lines use the text colour: light in the sidebar, black on the login card (Login.css) */}
      <mask id="ds-logo-cut">
        <path d="M465 130h320v320h-320z" fill="#ffffff" />
        <circle cx="715" cy="358" r="60" fill="#000000" />
      </mask>
      <g fill="none" stroke="currentColor" strokeWidth="13" strokeLinejoin="miter" mask="url(#ds-logo-cut)">
        <path d="M562 158A113 113 0 0 1 712 292" />
        <path d="M668 352A113 113 0 0 1 487 240" />
        <path d="M512 208L538 178L668 352" />
      </g>
      {/* CCTV camera, bottom right */}
      <svg x="645" y="300" width="140" height="149.3" viewBox="0 0 150 160">
        <ellipse cx="75" cy="148" rx="40" ry="10" fill="#cfe3f7" />
        <path d="M67 112h16l3 32h-22z" fill="#a9c8ea" />
        <ellipse cx="75" cy="116" rx="15" ry="6" fill="#8fb6e3" />
        <circle cx="75" cy="62" r="56" fill="#dbe9f7" stroke="#9fc2e8" strokeWidth="3" />
        <circle cx="75" cy="62" r="46" fill="#1b2a4a" />
        <path d="M45 53v18M105 53v18" stroke="#4f7df0" strokeWidth="11" strokeLinecap="round" />
        <circle cx="75" cy="62" r="17" fill="#4f7df0" />
        <circle cx="75" cy="62" r="11" fill="#1b2a4a" />
        <circle cx="75" cy="62" r="5" fill="#ffffff" />
      </svg>
    </svg>
  )
}

type BranchOption = { branch_id: string; branch_name: string }
type Range = readonly [string, string] | null

type LatestEvent = {
  cctv_event_id: string
  direction: string
  track_region: string | null
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
  // the matched face belongs to a member OR a staff
  face_template: { member: { member_no: string } | null; staff: { staff_no: string } | null } | null
  visit: { est_gender: string; est_age: number | null } | null
}

type Counts = {
  passedCount: number | null
  passedMale: number | null
  passedFemale: number | null
  passedUnknown: number | null
  inCount: number | null
  inMale: number | null
  inFemale: number | null
  inUnknown: number | null
  dealed: number | null
}

type Tally = { all: number; male: number; female: number; unknown: number }

// One finished stay in the shop (Top 5 Longest Stay)
type Stay = { trackId: string; gender: string; seconds: number }

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
// [start of the day, start of the next day] as ISO strings, for one date (YYYY-MM-DD)
const dayRange = (day: string): Range => {
  if (!day) return null
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}
const todayKey = () => dateKey(new Date().toISOString())

// One row per cctv_event: the visit (person, track_id) it belongs to, its direction and time
type PersonEvent = {
  visit_id: string
  direction: string
  event_time: string
  visit: { est_gender: string; track_id: string } | null
}

// All cctv_event rows of the branch in the date range, oldest first
// (read in pages of 1,000, up to 50,000 rows)
async function loadPersonEvents(branch: string, range: Range): Promise<PersonEvent[]> {
  const out: PersonEvent[] = []
  for (let from = 0; from < 50000; from += 1000) {
    let q = supabase
      .from(TABLES.cctvEvent)
      .select('visit_id, direction, event_time, camera!inner(edge_device!inner(branch_id)), visit!inner(est_gender, track_id)')
    if (branch) q = q.eq('camera.edge_device.branch_id', branch)
    if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
    const { data, error } = await q.order('event_time', { ascending: true }).range(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as PersonEvent[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// People, not events: one person (one track_id) can be seen going In by several
// cameras and walk into several areas, so each number counts distinct track_ids.
//   People Passed By = distinct track_ids with a Passed By event (Male + Female + Unknown = the total)
//   People Walk-in = distinct track_ids with an In event (Male + Female + Unknown = the total)
// Time in the shop, per track_id: from an In (Purchasing / Counter) until the
// next Passed By (walked onto the Traffic walkway) or Out; a person who comes
// back in later adds that stay too. A stay that has not ended yet is left out.
export function countPeople(events: PersonEvent[]) {
  const people = new Map<string, { gender: string; wentIn: boolean; passedBy: boolean; since: number | null; seconds: number; ended: boolean }>()
  for (const e of events) {
    // events come oldest first
    const key = e.visit?.track_id ?? e.visit_id
    const p = people.get(key) ?? { gender: e.visit?.est_gender ?? 'Unknown', wentIn: false, passedBy: false, since: null, seconds: 0, ended: false }
    if (e.direction === 'Passed By') p.passedBy = true
    const t = new Date(e.event_time).getTime()
    if (e.direction === 'In') {
      p.wentIn = true
      if (p.since === null) p.since = t // came into the shop (another In while inside = moved to another area)
    } else if ((e.direction === 'Passed By' || e.direction === 'Out') && p.since !== null) {
      p.seconds += Math.max(0, (t - p.since) / 1000)
      p.since = null
      p.ended = true
    }
    people.set(key, p)
  }
  const tally = (list: { gender: string }[]): Tally => {
    const male = list.filter((p) => p.gender === 'Male').length
    const female = list.filter((p) => p.gender === 'Female').length
    return { all: list.length, male, female, unknown: list.length - male - female }
  }
  const walkIn = tally([...people.values()].filter((p) => p.wentIn))
  const passedBy = tally([...people.values()].filter((p) => p.passedBy))
  const stays: Stay[] = [...people.entries()]
    .filter(([, p]) => p.ended && p.seconds >= 1)
    .map(([trackId, p]) => ({ trackId, gender: p.gender, seconds: Math.round(p.seconds) }))
    .sort((x, y) => y.seconds - x.seconds)
  const longest = stays.slice(0, 5)
  // Average time in the shop of everyone with a finished stay on the day (null = no finished stays)
  const averageStay = stays.length ? Math.round(stays.reduce((sum, s) => sum + s.seconds, 0) / stays.length) : null
  return { in: walkIn, passedBy, longest, averageStay, stayCount: stays.length }
}

// 4354 s → "1 hr 12 min 34 sec", 754 s → "12 min 34 sec", 45 s → "45 sec"
const fmtStay = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (seconds >= 3600) return `${h} hr ${pad(m)} min ${pad(s)} sec`
  if (seconds >= 60) return `${m} min ${pad(s)} sec`
  return `${s} sec`
}

// Average Daily Time Taken: average stay of everyone who finished a stay on the day
function AverageStay({
  branchName,
  seconds,
  count,
  loading,
}: {
  branchName: string
  seconds: number | null
  count: number | null
  loading: boolean
}) {
  return (
    <section className="ds-panel ds-avgstay">
      <h2>Average Daily Time Taken staying in {branchName || '—'}</h2>
      <p className="ds-stay-note">Average time from walking in until Passed By, over everyone with a finished stay on this day.</p>
      {loading && seconds === null ? (
        <p className="ds-empty">Loading…</p>
      ) : seconds === null ? (
        <p className="ds-empty">No finished stays on this day yet.</p>
      ) : (
        <div className="ds-avgstay-value">
          <strong>{fmtStay(seconds)}</strong>
          <span>
            Based on {count} {count === 1 ? 'person' : 'people'}
          </span>
        </div>
      )}
    </section>
  )
}

// Top 5 Longest Stay: podium for the top 3 (2nd, 1st, 3rd), then 4th and 5th as rows
function LongestStay({ branchName, stays, loading }: { branchName: string; stays: Stay[] | null; loading: boolean }) {
  const podium = stays ? [stays[1], stays[0], stays[2]] : []
  const places = [2, 1, 3]
  return (
    <section className="ds-panel ds-stay">
      <h2>Top 5 Longest Stay in {branchName || '—'}</h2>
      <p className="ds-stay-note">Time from walking in (Purchasing / Counter) until Passed By on the Traffic walkway.</p>
      {loading && !stays ? (
        <p className="ds-empty">Loading…</p>
      ) : !stays || stays.length === 0 ? (
        <p className="ds-empty">No finished stays on this day yet.</p>
      ) : (
        <>
          <div className="ds-podium">
            {podium.map((s, i) =>
              s ? (
                <div className={`ds-podium-card ds-podium-card--${places[i]}`} key={s.trackId}>
                  <span className="ds-podium-rank">{places[i]}</span>
                  <dl>
                    <dt>Track_Id</dt>
                    <dd className="ds-podium-track">{s.trackId}</dd>
                    <dt>Gender</dt>
                    <dd>{s.gender}</dd>
                    <dt>Time Taken</dt>
                    <dd className="ds-podium-time">{fmtStay(s.seconds)}</dd>
                  </dl>
                </div>
              ) : (
                <div className={`ds-podium-card ds-podium-card--${places[i]} ds-podium-card--empty`} key={`empty-${places[i]}`}>
                  <span className="ds-podium-rank">{places[i]}</span>
                  <p>—</p>
                </div>
              ),
            )}
          </div>
          {stays.length > 3 && (
            <ol className="ds-stay-rows" start={4}>
              {stays.slice(3).map((s, i) => (
                <li key={s.trackId}>
                  <span className="ds-stay-rank">{i + 4}</span>
                  <span className="ds-stay-track">{s.trackId}</span>
                  <span>{s.gender}</span>
                  <span className="ds-stay-time">{fmtStay(s.seconds)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  )
}

// Number of transactions with status 'Dealed' (branch = branch of the matched event's camera's edge box)
function dealedCount(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.transaction)
    .select('transaction_id, cctv_event!inner(camera!inner(edge_device!inner(branch_id)))', { count: 'exact', head: true })
    .eq('status', 'Dealed')
  if (branch) q = q.eq('cctv_event.camera.edge_device.branch_id', branch)
  if (range) q = q.gte('transaction_date', range[0]).lt('transaction_date', range[1])
  return q
}

// select ca.camera_name, cc.direction, cc.confidence, v.visit_type, v.est_gender, v.est_age, cc.event_time
// from cctv_event cc join camera ca on cc.camera_id = ca.camera_id join visit v on cc.visit_id = v.visit_id  (latest 50)
function latestEvents(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.cctvEvent)
    .select(
      'cctv_event_id, direction, track_region, confidence, event_time, camera!inner(camera_name, edge_device!inner(branch_id)), visit!inner(visit_type, est_gender, est_age)',
    )
  if (branch) q = q.eq('camera.edge_device.branch_id', branch)
  if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
  return q.order('event_time', { ascending: false }).limit(50)
}

// select ca.camera_name, coalesce(m.member_no, s.staff_no), v.est_gender, v.est_age, re.match_score, re.result, re.event_time
// from recognition_event re join camera ca on re.camera_id = ca.camera_id
// join face_template ft on re.face_template_id = ft.face_template_id
// left join member m on ft.member_id = m.member_id left join staff s on ft.staff_id = s.staff_id
// join visit v on re.visit_id = v.visit_id  (latest 50)
function latestRecognitions(branch: string, range: Range) {
  let q = supabase
    .from(TABLES.recognitionEvent)
    .select(
      'recognition_event_id, match_score, result, event_time, camera!inner(camera_name, edge_device!inner(branch_id)), face_template!inner(member(member_no), staff(staff_no)), visit!inner(est_gender, est_age)',
    )
  if (branch) q = q.eq('camera.edge_device.branch_id', branch)
  if (range) q = q.gte('event_time', range[0]).lt('event_time', range[1])
  return q.order('event_time', { ascending: false }).limit(50)
}

function Overview({ onMoreEvents }: { onMoreEvents: (tab: EventTab, day: string) => void }) {
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [branch, setBranch] = useState('') // set to the first branch once the branches are loaded
  // One date (YYYY-MM-DD); starts on today
  const [day, setDay] = useState(todayKey)

  const [counts, setCounts] = useState<Counts>({
    passedCount: null,
    passedMale: null,
    passedFemale: null,
    passedUnknown: null,
    inCount: null,
    inMale: null,
    inFemale: null,
    inUnknown: null,
    dealed: null,
  })
  const [longest, setLongest] = useState<Stay[] | null>(null)
  const [averageStay, setAverageStay] = useState<{ seconds: number | null; count: number } | null>(null)
  const [events, setEvents] = useState<LatestEvent[]>([])
  const [recognitions, setRecognitions] = useState<LatestRecognition[]>([])
  const [eventTab, setEventTab] = useState<EventTab>('cctv')
  const [loading, setLoading] = useState(true)
  const [filterError, setFilterError] = useState('')
  const [error, setError] = useState('')

  // Options for the branch filter (the date range accepts any dates)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(
      supabase.from(TABLES.branch).select('branch_id, branch_name').order('branch_name', { ascending: true }),
    )
      .then((b) => {
        if (cancelled) return
        if (b.error) setFilterError(b.error.message)
        else {
          const list = (b.data ?? []) as BranchOption[]
          setBranches(list)
          if (list.length) setBranch((cur) => cur || list[0].branch_id)
          else setLoading(false)
        }
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
    const range = dayRange(day)

    Promise.all([
      loadPersonEvents(branch, range).then(
        (rows) => ({ people: countPeople(rows), error: null }),
        (err: unknown) => ({ people: null, error: { message: err instanceof Error ? err.message : String(err) } }),
      ),
      dealedCount(branch, range),
      latestEvents(branch, range),
      latestRecognitions(branch, range),
    ]).then(([peopleRes, dealRes, evRes, recRes]) => {
      if (cancelled) return
      const failed = [peopleRes, dealRes, evRes, recRes].find((r) => r.error)
      if (failed?.error) setError(failed.error.message)
      const p = peopleRes.people
      setCounts({
        passedCount: p ? p.passedBy.all : null,
        passedMale: p ? p.passedBy.male : null,
        passedFemale: p ? p.passedBy.female : null,
        passedUnknown: p ? p.passedBy.unknown : null,
        inCount: p ? p.in.all : null,
        inMale: p ? p.in.male : null,
        inFemale: p ? p.in.female : null,
        inUnknown: p ? p.in.unknown : null,
        dealed: dealRes.error ? null : dealRes.count,
      })
      setLongest(p ? p.longest : null)
      setAverageStay(p ? { seconds: p.averageStay, count: p.stayCount } : null)
      setEvents(evRes.error ? [] : ((evRes.data ?? []) as unknown as LatestEvent[]))
      setRecognitions(recRes.error ? [] : ((recRes.data ?? []) as unknown as LatestRecognition[]))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [branch, day])

  const stats: {
    label: string
    value: number | null
    male?: number | null
    female?: number | null
    unknown?: number | null
    tone?: 'in' | 'passed'
  }[] = [
    {
      label: 'People Passed By',
      value: counts.passedCount,
      male: counts.passedMale,
      female: counts.passedFemale,
      unknown: counts.passedUnknown,
      tone: 'passed',
    },
    {
      label: 'People Walk-in',
      value: counts.inCount,
      male: counts.inMale,
      female: counts.inFemale,
      unknown: counts.inUnknown,
      tone: 'in',
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
          <label className="ds-datefilter-field">
            Date
            <input
              type="date"
              aria-label="Date"
              value={day}
              required
              onChange={(e) => setDay(e.target.value || todayKey())}
            />
          </label>
          <span className="ds-datefilter-label">{fmtDate(new Date(`${day}T00:00:00`))}</span>
          {day !== todayKey() && (
            <button type="button" className="ds-datefilter-clear" onClick={() => setDay(todayKey())}>
              Today
            </button>
          )}
        </div>
      </div>

      {filterError && <p className="ds-error">Some filters failed to load: {filterError}</p>}
      {error && <p className="ds-error">Some numbers failed to load: {error}</p>}

      <section className="ds-stats ds-stats--three">
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
                <div className="ds-stat-sub">
                  <span>Unknown:</span>
                  <span>{s.unknown ?? '—'}</span>
                </div>
              </>
            )}
          </div>
        ))}
      </section>

      <div className="ds-stay-pair">
        <LongestStay
          branchName={branches.find((b) => b.branch_id === branch)?.branch_name ?? ''}
          stays={longest}
          loading={loading}
        />
        <AverageStay
          branchName={branches.find((b) => b.branch_id === branch)?.branch_name ?? ''}
          seconds={averageStay?.seconds ?? null}
          count={averageStay?.count ?? null}
          loading={loading}
        />
      </div>

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
          <button type="button" className="ds-more" onClick={() => onMoreEvents(eventTab, day)}>
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
              { header: 'Track region', render: (r) => r.track_region ?? '—' },
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
              {
                header: 'Member / Staff no.',
                render: (r) => r.face_template?.member?.member_no ?? r.face_template?.staff?.staff_no ?? '—',
              },
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

// /edge-device/:edgeDeviceId/edit
function EditEdgeDeviceRoute() {
  const { edgeDeviceId } = useParams()
  const navigate = useNavigate()
  if (!edgeDeviceId) return <Navigate to="/edge-device" replace />
  return <EditEdgeDevicePage edgeDeviceId={edgeDeviceId} onBack={() => navigate('/edge-device')} />
}

// /eventhistory, /eventhistory?tab=recognition, /eventhistory?date=2026-10-18
function EventsRoute() {
  const [params] = useSearchParams()
  const tab: EventTab = params.get('tab') === 'recognition' ? 'recognition' : 'cctv'
  const date = params.get('date') ?? ''
  const initialDay = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
  return <EventsPage key={`${tab}|${initialDay ?? ''}`} initialTab={tab} initialDay={initialDay} />
}

// Current time in the sidebar, ticking every second: DD Month YYYY HH:MM.SS (24 hours)
function LiveClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const pad = (n: number) => String(n).padStart(2, '0')
  const month = now.toLocaleString('en-GB', { month: 'long' })
  const text = `${pad(now.getDate())} ${month} ${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return <time className="ds-clock" dateTime={now.toISOString()}>{text}</time>
}

type DashboardProps = { adminName: string; onSignOut: () => void }

export default function Dashboard({ adminName, onSignOut }: DashboardProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const section = pathname.split('/')[1] || 'dashboard'
  const activeNav = (NAV.some((n) => n.key === section) ? section : 'dashboard') as PageKey

  const mainRef = useRef<HTMLElement>(null)
  const [sideOpen, setSideOpen] = useState(true) // sidebar starts shown
  const sideRef = useRef<HTMLElement>(null)
  const lastScrollRef = useRef(0)
  const sideAnimRef = useRef<Animation | null>(null) // sidebar collapse / expand in progress
  const pendingExpandRef = useRef<number | null>(null) // sidebar height when the expand started

  // Sidebar collapse / expand always takes 0.5 s (no animation if the phone asks for reduced motion)
  function sideDuration() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500
  }

  // Phone layout (same width as the @media rule in dashboard.css):
  // scrolling down the content -> collapse the top sidebar to give the content more room,
  // scrolling back up to the very top of the content -> expand it again
  function onMainScroll(e: UIEvent<HTMLElement>) {
    const top = e.currentTarget.scrollTop
    const delta = top - lastScrollRef.current
    lastScrollRef.current = top

    const side = sideRef.current
    if (!side || sideAnimRef.current || !window.matchMedia('(max-width: 760px)').matches) return

    if (sideOpen && delta > 0 && top > 10) {
      // Shrink to the collapsed height first, then switch to the collapsed layout
      const root = side.parentElement as HTMLElement
      const from = side.offsetHeight
      root.classList.add('ds--collapsed')
      const to = side.offsetHeight
      root.classList.remove('ds--collapsed')
      const duration = sideDuration()
      if (!duration) {
        setSideOpen(false)
        return
      }
      const anim = side.animate(
        [
          { height: `${from}px`, overflow: 'hidden' },
          { height: `${to}px`, overflow: 'hidden' },
        ],
        { duration, easing: 'ease-out', fill: 'forwards' },
      )
      sideAnimRef.current = anim
      anim.onfinish = () => setSideOpen(false)
    } else if (!sideOpen && delta < 0 && top <= 0) {
      // Back at the top: render the open layout, then grow it from the current height
      pendingExpandRef.current = side.offsetHeight
      setSideOpen(true)
    }
  }

  // After the sidebar opens or closes: finish the collapse / start the expand animation
  useLayoutEffect(() => {
    sideAnimRef.current?.cancel()
    sideAnimRef.current = null
    const main = mainRef.current
    // the content height just changed, so measure scrolling from here
    if (main) lastScrollRef.current = main.scrollTop

    const from = pendingExpandRef.current
    pendingExpandRef.current = null
    const side = sideRef.current
    if (from === null || !side || !sideOpen) return
    const to = side.offsetHeight
    const duration = sideDuration()
    if (!duration) return
    const anim = side.animate(
      [
        { height: `${from}px`, overflow: 'hidden' },
        { height: `${to}px`, overflow: 'hidden' },
      ],
      { duration, easing: 'ease-out' },
    )
    sideAnimRef.current = anim
    anim.onfinish = () => {
      if (sideAnimRef.current === anim) sideAnimRef.current = null
      if (main) lastScrollRef.current = main.scrollTop
    }
  }, [sideOpen])

  useEffect(() => {
    const label = SUB_TITLES.find((t) => t.match.test(pathname))?.title ?? NAV.find((n) => n.key === activeNav)?.label
    document.title = label ? `${label} | JackStudio Retail System Tracking` : 'JackStudio Retail System Tracking'
    mainRef.current?.scrollTo({ top: 0 })
  }, [pathname, activeNav])

  return (
    <div className={sideOpen ? 'ds' : 'ds ds--collapsed'}>
      <aside className="ds-side" ref={sideRef}>
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
              aria-label={n.label}
              title={sideOpen ? undefined : n.label} // name on hover when only the icon shows
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">{n.icon}</svg>
              <span className="ds-nav-label">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ds-live"><i /> System online</div>
        <LiveClock />

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
                onMoreEvents={(tab, day) =>
                  navigate(`/eventhistory?${tab === 'recognition' ? 'tab=recognition&' : ''}date=${day}`)
                }
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
          <Route
            path="/edge-device"
            element={
              <EdgeDevicePage
                onAdd={() => navigate('/edge-device/new')}
                onManage={(id) => navigate(`/edge-device/${id}/edit`)}
              />
            }
          />
          <Route path="/edge-device/new" element={<NewEdgeDevicePage onBack={() => navigate('/edge-device')} />} />
          <Route path="/edge-device/:edgeDeviceId/edit" element={<EditEdgeDeviceRoute />} />
          <Route path="/eventhistory" element={<EventsRoute />} />
          <Route path="/members" element={<MemberPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  )
}
