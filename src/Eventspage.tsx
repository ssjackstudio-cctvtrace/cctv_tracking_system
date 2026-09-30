import { useState } from 'react'
import DataTable, { Badge } from './Datatable'
import { TABLES, useTable, formatTime, shortId } from './Usetable'
import type { Camera, CctvEvent, RecognitionEvent } from './types'

function useCameraName() {
  const { rows } = useTable<Camera>(TABLES.camera, 'camera_name', true, 500)
  return (id: string) => rows.find((c) => c.camera_id === id)?.camera_name ?? shortId(id)
}

export function CctvEventsTable({ limit = 100 }: { limit?: number }) {
  const t = useTable<CctvEvent>(TABLES.cctvEvent, 'event_time', false, limit)
  const cameraName = useCameraName()
  return (
    <DataTable
      rows={t.rows}
      loading={t.loading}
      error={t.error}
      emptyMessage="No CCTV events found."
      rowKey={(r) => r.cctv_event_id}
      columns={[
        { header: 'Time', render: (r) => formatTime(r.event_time) },
        { header: 'Camera', render: (r) => cameraName(r.camera_id) },
        { header: 'Visit', render: (r) => shortId(r.visit_id) },
        { header: 'Direction', render: (r) => <Badge text={r.direction} /> },
        { header: 'Confidence', render: (r) => `${Number(r.confidence).toFixed(1)}%` },
      ]}
    />
  )
}

function RecognitionEventsTable() {
  const t = useTable<RecognitionEvent>(TABLES.recognitionEvent, 'event_time', false)
  const cameraName = useCameraName()
  return (
    <DataTable
      rows={t.rows}
      loading={t.loading}
      error={t.error}
      emptyMessage="No recognition events found."
      rowKey={(r) => r.recognition_event_id}
      columns={[
        { header: 'Time', render: (r) => formatTime(r.event_time) },
        { header: 'Camera', render: (r) => cameraName(r.camera_id) },
        { header: 'Visit', render: (r) => shortId(r.visit_id) },
        { header: 'Result', render: (r) => <Badge text={r.result} /> },
        { header: 'Match score', render: (r) => `${Number(r.match_score).toFixed(1)}%` },
      ]}
    />
  )
}

export default function EventsPage() {
  const [tab, setTab] = useState<'cctv' | 'recognition'>('cctv')
  return (
    <>
      <h1>Event</h1>
      <p className="ds-lead">Latest activity detected by the cameras.</p>
      <div className="tabs">
        <button className={tab === 'cctv' ? 'active' : ''} onClick={() => setTab('cctv')}>
          CCTV events
        </button>
        <button className={tab === 'recognition' ? 'active' : ''} onClick={() => setTab('recognition')}>
          Recognition events
        </button>
      </div>
      {tab === 'cctv' ? <CctvEventsTable /> : <RecognitionEventsTable />}
    </>
  )
}