import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import DataTable, { Badge } from './Datatable'
import { TABLES } from './Usetable'

export type EventTab = 'cctv' | 'recognition'

type CctvEventRow = {
  cctv_event_id: string
  direction: string
  track_region: string | null
  confidence: number
  event_time: string
  camera: { camera_name: string; tapo_model: string | null } | null
  visit: {
    track_id: string
    visit_type: string
    est_gender: string
    est_age: number | null
    demographic_score: number | null
  } | null
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
  } | null
  member_face_template: { member: { member_no: string; full_name: string } | null } | null
}

// DD Month YYYY hh:mm AM/PM, e.g. 05 March 2026 03:45 PM
const fmtDateTime = (iso: string) => {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  return `${date} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`
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

// select ca.camera_name, v.track_id, ca.tapo_model, v.visit_type, v.est_gender, v.est_age, v.demographic_score,
//        cc.direction, cc.confidence, cc.event_time
// from cctv_event cc join camera ca on cc.camera_id = ca.camera_id join visit v on cc.visit_id = v.visit_id
export function CctvEventsTable({ limit = 100, day }: { limit?: number; day?: string }) {
  const t = useRows<CctvEventRow>(
    () => {
      let q = supabase
        .from(TABLES.cctvEvent)
        .select(
          'cctv_event_id, direction, track_region, confidence, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score)',
        )
      if (day) q = q.gte('event_time', dayRange(day)[0]).lt('event_time', dayRange(day)[1])
      return q.order('event_time', { ascending: false }).limit(day ? Math.max(limit, DAY_LIMIT) : limit)
    },
    [limit, day],
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
        { header: 'Track ID', render: (r) => r.visit?.track_id ?? '—' },
        { header: 'Tapo model', render: (r) => r.camera?.tapo_model ?? '—' },
        { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
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

// select ca.camera_name, v.track_id, ca.tapo_model, v.visit_type, v.est_gender, v.est_age, v.demographic_score,
//        m.member_no, m.full_name, re.match_score, re.result, re.event_time
// from recognition_event re join camera ca on re.camera_id = ca.camera_id join visit v on re.visit_id = v.visit_id
// join member_face_template mft on re.face_template_id = mft.face_template_id join member m on mft.member_id = m.member_id
function RecognitionEventsTable({ limit = 100, day }: { limit?: number; day?: string }) {
  const t = useRows<RecognitionEventRow>(
    () => {
      let q = supabase
        .from(TABLES.recognitionEvent)
        .select(
          'recognition_event_id, match_score, result, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score), member_face_template!inner(member!inner(member_no, full_name))',
        )
      if (day) q = q.gte('event_time', dayRange(day)[0]).lt('event_time', dayRange(day)[1])
      return q.order('event_time', { ascending: false }).limit(day ? Math.max(limit, DAY_LIMIT) : limit)
    },
    [limit, day],
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
        { header: 'Track ID', render: (r) => r.visit?.track_id ?? '—' },
        { header: 'Tapo model', render: (r) => r.camera?.tapo_model ?? '—' },
        { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
        { header: 'Gender (est.)', render: (r) => r.visit?.est_gender ?? '—' },
        { header: 'Age (est.)', render: (r) => r.visit?.est_age ?? '—' },
        { header: 'Demographic score', render: (r) => fmt2(r.visit?.demographic_score) },
        { header: 'Member no.', render: (r) => r.member_face_template?.member?.member_no ?? '—' },
        { header: 'Full name', render: (r) => r.member_face_template?.member?.full_name ?? '—' },
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

export default function EventsPage({ initialTab = 'cctv', initialDay }: { initialTab?: EventTab; initialDay?: string }) {
  const [tab, setTab] = useState<EventTab>(initialTab)
  const [day, setDay] = useState(initialDay ?? todayKey)
  return (
    <>
      <h1>Event History</h1>
      <p className="ds-lead">Activity detected by the cameras on {fmtDay(day)}.</p>
      <div className="ev-toolbar">
        <div className="tabs">
          <button className={tab === 'cctv' ? 'active' : ''} onClick={() => setTab('cctv')}>
            CCTV Event
          </button>
          <button className={tab === 'recognition' ? 'active' : ''} onClick={() => setTab('recognition')}>
            Recognition Event
          </button>
        </div>
        <DayFilter day={day} onChange={setDay} />
      </div>
      {tab === 'cctv' ? <CctvEventsTable day={day} /> : <RecognitionEventsTable day={day} />}
    </>
  )
}
