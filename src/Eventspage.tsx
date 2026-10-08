import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import DataTable, { Badge } from './Datatable'
import { TABLES } from './Usetable'

export type EventTab = 'cctv' | 'recognition'

type CctvEventRow = {
  cctv_event_id: string
  direction: string
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
export function CctvEventsTable({ limit = 100 }: { limit?: number }) {
  const t = useRows<CctvEventRow>(
    () =>
      supabase
        .from(TABLES.cctvEvent)
        .select(
          'cctv_event_id, direction, confidence, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score)',
        )
        .order('event_time', { ascending: false })
        .limit(limit),
    [limit],
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
function RecognitionEventsTable({ limit = 100 }: { limit?: number }) {
  const t = useRows<RecognitionEventRow>(
    () =>
      supabase
        .from(TABLES.recognitionEvent)
        .select(
          'recognition_event_id, match_score, result, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score), member_face_template!inner(member!inner(member_no, full_name))',
        )
        .order('event_time', { ascending: false })
        .limit(limit),
    [limit],
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

export default function EventsPage({ initialTab = 'cctv' }: { initialTab?: EventTab }) {
  const [tab, setTab] = useState<EventTab>(initialTab)
  return (
    <>
      <h1>Event History</h1>
      <p className="ds-lead">Latest activity detected by the cameras.</p>
      <div className="tabs">
        <button className={tab === 'cctv' ? 'active' : ''} onClick={() => setTab('cctv')}>
          CCTV Events
        </button>
        <button className={tab === 'recognition' ? 'active' : ''} onClick={() => setTab('recognition')}>
          Recognition Events
        </button>
      </div>
      {tab === 'cctv' ? <CctvEventsTable /> : <RecognitionEventsTable />}
    </>
  )
}