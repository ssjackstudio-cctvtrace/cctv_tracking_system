import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import DataTable, { Badge } from './Datatable'
import { supabase } from './lib/supabase'
import { TABLES, edgeStatusNow, isOnline } from './Usetable'
import type { Branch, Camera, EdgeDevice, Point } from './types'
import { LiveVideo, type LiveBox, type LiveFrame, type LiveState } from './Livevideo'
import { AreasEditor, drawPersonBox3d, drawSpace, spaceLines } from './Areaseditor'
import { FloorMap } from './Floormap'
import { REGION_COLORS, floorOrAuto, readFloorAreas, type Calibration, type FloorAreas, type RegionKind } from './space3d'
import { OPEN_MINUTES, closeMinutes } from './shopHours'
import './Camera.css'

// How often the snapshot image and people counts refresh
const SNAPSHOT_REFRESH_MS = 5_000
const COUNT_REFRESH_MS = 10_000

// "01 October 2026"
export const formatLongDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—'

// "09 October 2026 04:54 PM"
export const formatLongDateTime = (iso: string | null) =>
  iso
    ? `${formatLongDate(iso)} ${new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`
    : '—'

// Event time: "09 October 2026 04:54:07 PM" (DD Month YYYY hh:mm:ss AM/PM)
const formatEventTime = (iso: string | null) =>
  iso ? `${formatLongDate(iso)} ${new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}` : '—'

// How often the camera / edge box details refresh (status, last seen, heartbeat)
const INFO_REFRESH_MS = 10_000

// One camera with its edge box and the edge box's branch:
//   select ca.tapo_model, ca.mac_address, ca.ip_address, b.branch_name, ca.stream_path,
//          ca.last_seen_at, ca.active_status, ed.device_name, ed.last_heartbeat, ed.status
//   from camera ca
//   join edge_device ed on ca.edge_device_id = ed.edge_device_id
//   join branch b on ed.branch_id = b.branch_id
// (edge_device is a left join here, so a camera with no edge box still shows its own card)
type CameraInfo = Pick<
  Camera,
  'tapo_model' | 'mac_address' | 'ip_address' | 'stream_path' | 'last_seen_at' | 'active_status'
> & {
  edge_device:
    | (Pick<EdgeDevice, 'device_name' | 'last_heartbeat' | 'status'> & {
        branch: Pick<Branch, 'branch_name'> | null
      })
    | null
}

function useCameraInfo(cameraId: string) {
  const [info, setInfo] = useState<CameraInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const { data, error } = await supabase
        .from(TABLES.camera)
        .select(
          'tapo_model, mac_address, ip_address, stream_path, last_seen_at, active_status, ' +
            'edge_device(device_name, last_heartbeat, status, branch(branch_name))',
        )
        .eq('camera_id', cameraId)
        .maybeSingle()
      if (cancelled) return
      if (error) setError(error.message)
      else {
        setError('')
        setInfo(data as unknown as CameraInfo | null)
      }
    }
    load()
    const timer = setInterval(load, INFO_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cameraId])

  return { info, error }
}

function InfoCard({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <section className="cam-info-card">
      <h2 className="cam-info-title">{title}</h2>
      <dl className="cam-info">
        {rows.map(([label, value]) => (
          <div className="cam-info-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// A camera can show a live capture when it is active, the edge box has
// uploaded a snapshot, and the edge box reported in the last 5 minutes.
export const canCapture = (cam: Camera) =>
  cam.active_status === 'Active' && !!cam.last_snapshot_url && isOnline(cam.last_seen_at)


// Live screen. With the edge box's live video address (edge_device.live_url)
// it plays smooth live video, all the time, whether people move or not.
// Without it (or while the video cannot be reached) it shows the latest
// snapshot uploaded by the edge box, reloaded every few seconds.
// Shows "Cannot capture" when there is neither.
export function CameraScreen({
  camera,
  liveUrl,
  width = 640,
  fps = 10,
  draw,
  onSaved,
  grabFrameRef,
  onLiveState,
}: {
  camera: Camera
  liveUrl?: string | null
  width?: number
  fps?: number
  draw?: (ctx: CanvasRenderingContext2D, frame: LiveFrame) => void
  onSaved?: () => void
  grabFrameRef?: MutableRefObject<(() => string | null) | null>
  onLiveState?: (state: LiveState, message: string) => void
}) {
  const [tick, setTick] = useState(0)
  const [failed, setFailed] = useState(false)
  const [liveState, setLiveState] = useState<LiveState>('connecting')
  const useLive = !!liveUrl && !!camera.edge_device_id && camera.active_status === 'Active'
  const playing = useLive && liveState === 'live'
  const snapshot = canCapture(camera) && !playing

  useEffect(() => {
    if (!snapshot) return
    const timer = setInterval(() => setTick((t) => t + 1), SNAPSHOT_REFRESH_MS)
    return () => clearInterval(timer)
  }, [snapshot])

  useEffect(() => setFailed(false), [camera.last_snapshot_url])

  const handleState = useCallback(
    (s: LiveState, msg: string) => {
      setLiveState(s)
      onLiveState?.(s, msg)
    },
    [onLiveState],
  )

  const url = camera.last_snapshot_url ?? ''
  const showSnapshot = snapshot && !failed
  return (
    <div className={`cam-screen${!playing && !showSnapshot ? ' cam-screen--empty' : ''}`}>
      {showSnapshot && (
        <img
          src={`${url}${url.includes('?') ? '&' : '?'}t=${tick}`}
          alt={`Live capture from ${camera.camera_name}`}
          onError={() => setFailed(true)}
        />
      )}
      {!playing && !showSnapshot && <span>{useLive && liveState === 'connecting' ? 'Connecting…' : 'Cannot capture'}</span>}
      {useLive && (
        <LiveVideo
          cameraId={camera.camera_id}
          liveUrl={liveUrl as string}
          width={width}
          fps={fps}
          draw={draw}
          onSaved={onSaved}
          onState={handleState}
          grabFrameRef={grabFrameRef}
          className={`cam-live-canvas${playing ? '' : ' cam-live-canvas--hidden'}`}
        />
      )}
    </div>
  )
}

// People Passed By / Walk-in for ONE camera (the selected camera), counted
// from CCTV_EVENT since midnight today: Passed By = direction 'Passed By'
// (walked onto the Traffic walkway), Walk-in = direction 'In'. People, not
// rows: one person (visit = one track_id) is counted once, even when this
// camera recorded them more than once. reloadKey changes when the edge box
// says a new row was saved, so the numbers change at once.
function usePeopleCount(cameraId: string, reloadKey = 0) {
  const [counts, setCounts] = useState({ passedBy: 0, in: 0 })
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const visitsWith = async (directions: string[]) => {
        const ids = new Set<string>()
        for (let from = 0; from < 20000; from += 1000) {
          const { data, error } = await supabase
            .from(TABLES.cctvEvent)
            .select('visit_id')
            .eq('camera_id', cameraId)
            .in('direction', directions)
            .gte('event_time', startOfToday.toISOString())
            .range(from, from + 999)
          if (error) return { count: 0, error }
          const rows = (data ?? []) as { visit_id: string }[]
          rows.forEach((r) => ids.add(r.visit_id))
          if (rows.length < 1000) break
        }
        return { count: ids.size, error: null }
      }
      const [passedRes, inRes] = await Promise.all([visitsWith(['Passed By']), visitsWith(['In'])])
      if (cancelled) return
      const err = passedRes.error ?? inRes.error
      if (err) setError(err.message)
      else {
        setError('')
        setCounts({ passedBy: passedRes.count, in: inRes.count })
      }
    }
    load()
    const timer = setInterval(load, COUNT_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cameraId, reloadKey])

  return { ...counts, error }
}

// ---------- People Passed By / Walk-in timeline (today, 30-minute steps) ----------
// Opening hours: 10:00 AM – 10:30 PM on Friday and Saturday, 10:00 AM – 10:00 PM other days.
// Each person (visit_id) is counted once per direction, in the 30 minutes of
// their first Passed By / In row from this camera today, like the cards above.
const SLOT_MINUTES = 30

type TimelineSlot = { start: Date; passedBy: number; in: number }

function usePeopleTimeline(cameraId: string, reloadKey = 0) {
  const [slots, setSlots] = useState<TimelineSlot[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const now = new Date()
      const open = new Date(now)
      open.setHours(0, OPEN_MINUTES, 0, 0)
      const close = new Date(now)
      close.setHours(0, closeMinutes(now), 0, 0)
      const rows: { visit_id: string; direction: string; event_time: string }[] = []
      for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await supabase
          .from(TABLES.cctvEvent)
          .select('visit_id, direction, event_time')
          .eq('camera_id', cameraId)
          .in('direction', ['Passed By', 'In'])
          .gte('event_time', open.toISOString())
          .lt('event_time', close.toISOString())
          .order('event_time', { ascending: true })
          .range(from, from + 999)
        if (cancelled) return
        if (error) {
          setError(error.message)
          return
        }
        rows.push(...((data ?? []) as typeof rows))
        if ((data ?? []).length < 1000) break
      }
      const count = (closeMinutes(now) - OPEN_MINUTES) / SLOT_MINUTES
      const next: TimelineSlot[] = Array.from({ length: count }, (_, i) => ({
        start: new Date(open.getTime() + i * SLOT_MINUTES * 60_000),
        passedBy: 0,
        in: 0,
      }))
      const seen = { passedBy: new Set<string>(), in: new Set<string>() }
      for (const r of rows) {
        const dir = r.direction === 'In' ? 'in' : 'passedBy'
        if (seen[dir].has(r.visit_id)) continue
        seen[dir].add(r.visit_id)
        const i = Math.floor((new Date(r.event_time).getTime() - open.getTime()) / (SLOT_MINUTES * 60_000))
        if (i >= 0 && i < count) next[i][dir] += 1
      }
      setError('')
      // Only up to now: the rest of the day has not happened yet
      setSlots(next.filter((s) => s.start <= now))
    }
    load()
    const timer = setInterval(load, COUNT_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cameraId, reloadKey])

  return { slots, error }
}

// "10:00 AM"
const fmtClock = (d: Date) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })

// Minutes after midnight → "10am", "12pm", "10:30pm"
const fmtHour = (m: number) =>
  `${((Math.floor(m / 60) + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 12 * 60 ? 'am' : 'pm'}`

function PeopleTimeline({ cameraId, reloadKey }: { cameraId: string; reloadKey: number }) {
  const { slots, error } = usePeopleTimeline(cameraId, reloadKey)
  const today = new Date()
  const closeAt = closeMinutes(today)
  // Each point sits in the middle of its 30 minutes
  const data = slots.map((s) => ({
    minute: s.start.getHours() * 60 + s.start.getMinutes() + SLOT_MINUTES / 2,
    range: `${fmtClock(s.start)} – ${fmtClock(new Date(s.start.getTime() + SLOT_MINUTES * 60_000))}`,
    passedBy: s.passedBy,
    in: s.in,
  }))
  const ticks = Array.from({ length: Math.floor(closeAt / 60) - OPEN_MINUTES / 60 + 1 }, (_, i) => OPEN_MINUTES + i * 60)
  if (closeAt % 60) ticks.push(closeAt)

  return (
    <section className="cam-timeline">
      <h2>People Passed By / Walk-in today</h2>
      <p className="cam-count-note">
        People per 30 minutes, {fmtClock(new Date(new Date(today).setHours(0, OPEN_MINUTES, 0, 0)))} –{' '}
        {fmtClock(new Date(new Date(today).setHours(0, closeAt, 0, 0)))}
      </p>
      {error && <p className="cam-error">Could not load the people timeline: {error}</p>}
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="#e2e8f0" vertical={false} />
          <XAxis
            type="number"
            dataKey="minute"
            domain={[OPEN_MINUTES, closeAt]}
            ticks={ticks}
            tickFormatter={fmtHour}
            tick={{ fill: '#64748b', fontSize: 12 }}
            stroke="#cbd5e1"
          />
          <YAxis allowDecimals={false} tick={{ fill: '#64748b', fontSize: 12 }} stroke="#cbd5e1" />
          <Tooltip
            labelFormatter={(_, payload) => payload?.[0]?.payload.range ?? ''}
            contentStyle={{ borderRadius: 8, borderColor: '#e2e8f0' }}
          />
          <Legend verticalAlign="top" align="right" height={32} iconType="plainline" />
          <Line type="monotone" dataKey="passedBy" name="People Passed By" stroke={PASSED_BY_COLOR} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="in" name="People Walk-in" stroke={IN_COLOR} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  )
}

// ---------- People records of this camera (labels on the live video) ----------
//   select v.track_id, v.visit_type, ce.direction, v.est_gender, v.est_age,
//          ce.confidence, v.demographic_score
//   from cctv_event ce join visit v on ce.visit_id = v.visit_id
//   where camera_id = <selected camera>
// (newest first; a person's newest row is their current direction)
type TrackRecord = {
  cctv_event_id: string
  direction: string
  track_region: string | null
  confidence: number | null
  event_time: string
  visit: {
    track_id: string
    visit_type: string
    est_gender: string
    est_age: number | null
    demographic_score: number | null
  }
}

const RECORDS_LIMIT = 300

function useTrackRecords(cameraId: string, reloadKey = 0) {
  const [rows, setRows] = useState<TrackRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const { data, error } = await supabase
        .from(TABLES.cctvEvent)
        .select(
          'cctv_event_id, direction, track_region, confidence, event_time, visit!inner(track_id, visit_type, est_gender, est_age, demographic_score)',
        )
        .eq('camera_id', cameraId)
        .order('event_time', { ascending: false })
        .limit(RECORDS_LIMIT)
      if (cancelled) return
      setLoading(false)
      if (error) setError(error.message)
      else {
        setError('')
        setRows((data ?? []) as unknown as TrackRecord[])
      }
    }
    load()
    const timer = setInterval(load, COUNT_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cameraId, reloadKey])

  // track_id → newest row of that person
  const byTrack = useMemo(() => {
    const map = new Map<string, TrackRecord>()
    for (const r of rows) if (!map.has(r.visit.track_id)) map.set(r.visit.track_id, r)
    return map
  }, [rows])

  return { rows, byTrack, loading, error }
}

const fmt2 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toFixed(2))
// visit.est_age defaults to 0 until the box has seen the person's face
const fmtAge = (age: number | null | undefined) => (age ? String(age) : '—')

// ---------- Records from this camera: CCTV Event / Recognition Event, one day ----------
type RecordTab = 'cctv' | 'recognition'

type RecordVisit = Pick<TrackRecord['visit'], 'track_id' | 'visit_type' | 'est_gender' | 'est_age' | 'demographic_score'>

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
  visit: (RecordVisit & VisitPerson) | null
}

type RecognitionEventRow = {
  recognition_event_id: string
  match_score: number
  result: string
  event_time: string
  camera: { camera_name: string; tapo_model: string | null } | null
  visit: RecordVisit | null
  // the matched face belongs to a member OR a staff
  face_template: {
    member: { member_no: string; full_name: string } | null
    staff: { staff_no: string; full_name: string } | null
  } | null
}

const DAY_LIMIT = 10 // latest records shown for one day
const pad2 = (n: number) => String(n).padStart(2, '0')
// YYYY-MM-DD of today, in local time
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
// "18 October 2026" (day = YYYY-MM-DD)
const fmtDay = (day: string) => formatLongDate(new Date(`${day}T00:00:00`).toISOString())
// [start of the day, start of the next day] as ISO strings, in local time
const dayRange = (day: string): [string, string] => {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

// One day of this camera's rows from cctv_event or recognition_event, refreshed
// every few seconds. Shows "Loading..." only when the tab / camera / day changes;
// reloadKey (a new row saved by the edge box) reloads quietly.
function useCameraEvents<T>(table: string, select: string, cameraId: string, day: string, reloadKey: number) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
  }, [table, cameraId, day])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [from, to] = dayRange(day)
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .eq('camera_id', cameraId)
        .gte('event_time', from)
        .lt('event_time', to)
        .order('event_time', { ascending: false })
        .limit(DAY_LIMIT)
      if (cancelled) return
      setLoading(false)
      if (error) setError(error.message)
      else {
        setError('')
        setRows((data ?? []) as unknown as T[])
      }
    }
    load()
    const timer = setInterval(load, COUNT_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [table, select, cameraId, day, reloadKey])

  return { rows, loading, error }
}

// select ca.camera_name, v.track_id, ca.tapo_model, v.visit_type, v.est_gender, v.est_age, v.demographic_score,
//        s.staff_no, s.full_name, s.position, m.member_no, m.full_name, cc.direction, cc.track_region, cc.confidence, cc.event_time
// from cctv_event cc join camera ca on cc.camera_id = ca.camera_id join visit v on cc.visit_id = v.visit_id
// left join staff s on v.staff_id = s.staff_id left join member m on v.member_id = m.member_id
// where cc.camera_id = <this camera> and cc.event_time on <day>
function CameraCctvEvents({ cameraId, day, reloadKey }: { cameraId: string; day: string; reloadKey: number }) {
  const t = useCameraEvents<CctvEventRow>(
    TABLES.cctvEvent,
    'cctv_event_id, direction, track_region, confidence, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score, staff(staff_no, full_name, position), member(member_no, full_name))',
    cameraId,
    day,
    reloadKey,
  )
  return (
    <DataTable
      rows={t.rows}
      loading={t.loading}
      error={t.error}
      emptyMessage="No CCTV events from this camera on this day."
      rowKey={(r) => r.cctv_event_id}
      columns={[
        { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
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
        { header: 'Event time', render: (r) => formatEventTime(r.event_time) },
      ]}
    />
  )
}

// select ca.camera_name, v.track_id, ca.tapo_model, v.visit_type, v.est_gender, v.est_age, v.demographic_score,
//        coalesce(m.member_no, s.staff_no), coalesce(m.full_name, s.full_name), re.match_score, re.result, re.event_time
// from recognition_event re join camera ca on re.camera_id = ca.camera_id join visit v on re.visit_id = v.visit_id
// join face_template ft on re.face_template_id = ft.face_template_id
// left join member m on ft.member_id = m.member_id left join staff s on ft.staff_id = s.staff_id
// where re.camera_id = <this camera> and re.event_time on <day>
function CameraRecognitionEvents({ cameraId, day, reloadKey }: { cameraId: string; day: string; reloadKey: number }) {
  const t = useCameraEvents<RecognitionEventRow>(
    TABLES.recognitionEvent,
    'recognition_event_id, match_score, result, event_time, camera!inner(camera_name, tapo_model), visit!inner(track_id, visit_type, est_gender, est_age, demographic_score), face_template!inner(member(member_no, full_name), staff(staff_no, full_name))',
    cameraId,
    day,
    reloadKey,
  )
  return (
    <DataTable
      rows={t.rows}
      loading={t.loading}
      error={t.error}
      emptyMessage="No recognition events from this camera on this day."
      rowKey={(r) => r.recognition_event_id}
      columns={[
        { header: 'Camera', render: (r) => r.camera?.camera_name ?? '—' },
        { header: 'Track ID', render: (r) => r.visit?.track_id ?? '—' },
        { header: 'Tapo model', render: (r) => r.camera?.tapo_model ?? '—' },
        { header: 'Visit type', render: (r) => (r.visit ? <Badge text={r.visit.visit_type} /> : '—') },
        { header: 'Gender (est.)', render: (r) => r.visit?.est_gender ?? '—' },
        { header: 'Age (est.)', render: (r) => r.visit?.est_age ?? '—' },
        { header: 'Demographic score', render: (r) => fmt2(r.visit?.demographic_score) },
        {
          header: 'Member / Staff no.',
          render: (r) => r.face_template?.member?.member_no ?? r.face_template?.staff?.staff_no ?? '—',
        },
        {
          header: 'Full name',
          render: (r) => r.face_template?.member?.full_name ?? r.face_template?.staff?.full_name ?? '—',
        },
        { header: 'Match score', render: (r) => fmt2(r.match_score) },
        { header: 'Result', render: (r) => <Badge text={r.result} /> },
        { header: 'Event time', render: (r) => formatEventTime(r.event_time) },
      ]}
    />
  )
}

// Date filter shown as "18 October 2026"; clicking it opens the calendar
function RecordDayFilter({ day, onChange }: { day: string; onChange: (day: string) => void }) {
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

// ---------- Drawing on the live video ----------
const IN_COLOR = '#16a34a'
const OUT_COLOR = '#f97316'
const PASSED_BY_COLOR = '#1d4f91' // line graph: same blue as the "Passed By" direction badge in the tables

// A tracked person: a 3D box on the floor (calibrated camera, full body) or a
// rectangle, with their label. The label comes from the edge box with every
// picture (track_id, gender, age, area, X / Y / Z), so it stays on the person
// on every camera until they go Out, even before this camera saved a record.
function drawPerson(ctx: CanvasRenderingContext2D, box: LiveBox, rec: TrackRecord | undefined, cal: Calibration | null) {
  const { width: W, height: H } = ctx.canvas
  const [x1, y1, x2, y2] = [box.b[0] * W, box.b[1] * H, box.b[2] * W, box.b[3] * H]
  const linked = !!box.visit || !!rec
  const color = !linked
    ? 'rgba(226,232,240,0.9)'
    : box.kind && box.kind in REGION_COLORS
      ? REGION_COLORS[box.kind as RegionKind]
      : rec?.direction === 'Out' || rec?.direction === 'Passed By'
        ? OUT_COLOR
        : IN_COLOR
  ctx.save()
  let labelX = x1
  let labelY = y1
  const in3d = !!(cal && box.xyz && box.full)
  if (in3d) {
    const top = drawPersonBox3d(ctx, cal!, box.xyz!, color)
    if (top) {
      labelX = top.x * W - (x2 - x1) / 2
      labelY = Math.min(top.y * H, y1)
    }
  } else {
    ctx.lineWidth = linked ? Math.max(2, W / 320) : 1
    ctx.strokeStyle = color
    if (linked) {
      // light fill in the area colour: each person keeps their own box, also where people overlap
      ctx.globalAlpha = 0.16
      ctx.fillStyle = color
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
      ctx.globalAlpha = 1
    }
    if (!linked || box.full === false) ctx.setLineDash([6, 4])
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    ctx.setLineDash([])
  }
  if (linked && !in3d && box.full) {
    // feet point: where the person stands (what the shop areas are checked against)
    ctx.fillStyle = color
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc((x1 + x2) / 2, y2, Math.max(3, W / 240), 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  const v = rec?.visit
  const gender = box.g ?? v?.est_gender
  const age = box.a ?? v?.est_age
  const score = box.s ?? v?.demographic_score
  const lines = linked
    ? [
        box.track,
        // direction from where the person stands now: walkway = Passed By, shop area = In
        `${v?.visit_type ?? 'Guest'} · ${box.kind === 'Traffic' ? 'Passed By' : box.kind === 'Purchasing' || box.kind === 'Counter' ? 'In' : rec?.direction ?? '—'}${box.region ? ` · ${box.region}` : ''}`,
        `${gender ?? 'Unknown'} · Age ${fmtAge(age)}`,
        ...(box.xyz && box.full ? [`X ${box.xyz[0].toFixed(1)} · Y ${box.xyz[1].toFixed(1)} · Z ${box.xyz[2].toFixed(2)} m`] : []),
        ...(rec ? [`Match Confidence ${fmt2(rec.confidence)}%`] : []),
        `Demographic Score ${fmt2(score)}`,
        ...(box.est ? ['Feet hidden · spot from head'] : box.full === false ? ['Partly hidden'] : []),
      ]
    : [`${box.track.split('-').pop() ?? box.track}${box.full === false ? ' · partly hidden' : ''}`]
  const font = Math.max(11, Math.round(H * 0.024))
  ctx.font = `600 ${font}px system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const pad = Math.round(font * 0.35)
  const lineH = Math.round(font * 1.25)
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2
  const boxH = lines.length * lineH + pad * 2
  const lx = Math.min(Math.max(labelX, 0), W - boxW)
  const ly = labelY - boxH >= 0 ? labelY - boxH : Math.min(Math.max(labelY, 0), H - boxH) // above the person, or inside the top
  ctx.globalAlpha = 0.85
  ctx.fillStyle = linked ? color : 'rgba(15,23,42,0.7)'
  ctx.fillRect(lx, ly, boxW, boxH)
  ctx.globalAlpha = 1
  ctx.fillStyle = '#fff'
  lines.forEach((l, i) => ctx.fillText(l, lx + pad, ly + pad + i * lineH))
  ctx.restore()
}

// "Store metrics" in the top-left corner of the live video: this camera's
// People Passed By / Walk-in today, and the people inside the shop right now
// (all cameras of the edge box, each person once)
function drawMetrics(ctx: CanvasRenderingContext2D, passedBy: number, walkIn: number, inside: number | null | undefined) {
  const H = ctx.canvas.height
  const font = Math.max(11, Math.round(H * 0.028))
  const lines: [string, string][] = [
    ['STORE METRICS', '#cbd5e1'],
    [`Passed By: ${passedBy}`, OUT_COLOR],
    [`Walk-in: ${walkIn}`, IN_COLOR],
    [`Inside now: ${inside ?? '—'}`, '#ffffff'],
  ]
  ctx.save()
  ctx.font = `700 ${font}px system-ui, sans-serif`
  const pad = Math.round(font * 0.5)
  const lineH = Math.round(font * 1.3)
  const w = Math.max(...lines.map(([t]) => ctx.measureText(t).width)) + pad * 2
  const top = Math.round(H * 0.07) // below the camera's own date / time
  ctx.globalAlpha = 0.72
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(pad, top, w, lines.length * lineH + pad * 2)
  ctx.globalAlpha = 1
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  lines.forEach(([t, c], i) => {
    ctx.fillStyle = c
    ctx.fillText(t, pad * 2, top + pad + i * lineH)
  })
  ctx.restore()
}

export default function CameraDetails({
  camera,
  liveUrl,
  onBack,
  onEdit,
}: {
  camera: Camera
  liveUrl?: string | null
  onBack: () => void
  onEdit: () => void
}) {
  // Goes up each time the edge box saves a row for this camera → reload at once
  const [savedTick, setSavedTick] = useState(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onSaved = useCallback(() => {
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => setSavedTick((t) => t + 1), 300)
  }, [])
  useEffect(() => () => clearTimeout(debounce.current), [])

  const people = usePeopleCount(camera.camera_id, savedTick)
  const records = useTrackRecords(camera.camera_id, savedTick)
  const { info, error: infoError } = useCameraInfo(camera.camera_id)
  const cam = info ?? { ...camera, edge_device: null } // until the query answers
  const edge = info?.edge_device ?? null
  // 3D floor + shop areas (updated at once when saved below, before the camera list reloads)
  const [savedAreas, setFloorAreas] = useState<FloorAreas>(() => readFloorAreas(camera.floor_areas))
  useEffect(() => setFloorAreas(readFloorAreas(camera.floor_areas)), [camera.floor_areas])
  // The saved floor, or the automatic floor (camera 3.25 m high) until one is saved.
  // Shop areas are FLAT: the outline drawn on this camera's picture (no 3D box);
  // the edge box checks the feet point against it.
  const floorAreas = useMemo<FloorAreas>(() => {
    const calibration = floorOrAuto(savedAreas.calibration)
    return { ...savedAreas, calibration, regions: savedAreas.regions.map((r) => ({ ...r, floor: null })) }
  }, [savedAreas])
  const space = useMemo(() => spaceLines(floorAreas), [floorAreas])
  // The Areas editor works on the newest saved floor (also when the Floor map saved it)
  const editorCamera = useMemo(() => ({ ...camera, floor_areas: savedAreas }), [camera, savedAreas])
  // Newest live picture (people, obstacles), for the Shop Floor Map
  const liveFrame = useRef<LiveFrame | null>(null)
  // Full-body people seen on the live video (feet + top of head), for "Auto-fit tilt from people"
  const peopleSeen = useRef<{ foot: Point; head: Point }[]>([])
  const lastSample = useRef(0)
  const [showAll, setShowAll] = useState(false)
  const [liveMsg, setLiveMsg] = useState<{ state: LiveState; msg: string }>({ state: 'connecting', msg: '' })
  const grabFrameRef = useRef<(() => string | null) | null>(null)
  const onLiveState = useCallback((state: LiveState, msg: string) => setLiveMsg({ state, msg }), [])
  // Records from this camera: CCTV Event / Recognition Event tabs, one day at a time
  const [recordTab, setRecordTab] = useState<RecordTab>('cctv')
  const [recordDay, setRecordDay] = useState(todayKey)

  // Live view: the shop areas (Purchasing / Counter / Traffic), then each
  // person (3D box + label), and the store metrics (the floor map is below the video)
  const draw = (ctx: CanvasRenderingContext2D, frame: LiveFrame) => {
    liveFrame.current = frame
    if (Date.now() - lastSample.current > 500) {
      lastSample.current = Date.now()
      for (const b of frame.boxes) {
        if (!b.full) continue
        const x = (b.b[0] + b.b[2]) / 2
        peopleSeen.current.push({ foot: { x, y: b.b[3] }, head: { x, y: b.b[1] } })
      }
      if (peopleSeen.current.length > 400) peopleSeen.current.splice(0, peopleSeen.current.length - 400)
    }
    drawSpace(ctx, { ...space, grid: [], axes: [] }) // flat areas only: no floor grid / axes on the live video
    const shown = frame.boxes.filter((box) => box.visit || records.byTrack.has(box.track) || showAll)
    for (const box of shown) drawPerson(ctx, box, records.byTrack.get(box.track), floorAreas.calibration)
    drawMetrics(ctx, people.passedBy, people.in, frame.inside)
  }

  const cameraRows: [string, ReactNode][] = [
    ['Tapo Model', cam.tapo_model ?? '—'],
    ['MAC Address', cam.mac_address ?? '—'],
    ['IP Address', cam.ip_address ?? '—'],
    ['Branch', edge?.branch?.branch_name ?? '—'],
    ['Stream Path', cam.stream_path ?? '—'],
    ['Last Seen', formatLongDateTime(cam.last_seen_at)],
    ['Camera Status', <Badge text={cam.active_status} />],
  ]

  const edgeRows: [string, ReactNode][] = edge
    ? [
        ['Edge Device Name', edge.device_name],
        ['Last Heartbeat', formatLongDateTime(edge.last_heartbeat)],
        ['Edge Device Status', <Badge text={edgeStatusNow(edge)} />],
      ]
    : [['Edge Device', info ? 'No edge box linked to this camera' : '—']]

  const liveNote = !liveUrl
    ? 'Live video is not set up for this edge box yet, so the picture updates every few seconds.'
    : liveMsg.state === 'live'
      ? savedAreas.calibration
        ? '3D live tracking: each full-body person stands in a 3D box on the 1 m floor grid, with their floor spot (X, Y) and height (Z). The label keeps their track ID on every camera until they go Out.'
        : '3D live tracking on the automatic floor (camera 3.25 m high). Click "Adjust 3D floor" below to fit the floor to this camera.'
      : liveMsg.state === 'failed'
        ? `${liveMsg.msg || 'Cannot reach the live video'}. Showing the latest snapshot.`
        : liveMsg.state === 'off'
          ? liveMsg.msg || 'Camera off'
          : 'Connecting to live video…'

  return (
    <>
      <button type="button" className="cam-back" onClick={onBack}>
        ← Back to Camera
      </button>

      <h1>Camera ({camera.camera_name})</h1>

      <div className="cam-detail">
        <div>
          <CameraScreen
            camera={camera}
            liveUrl={liveUrl}
            width={960}
            fps={12}
            draw={draw}
            onSaved={onSaved}
            grabFrameRef={grabFrameRef}
            onLiveState={onLiveState}
          />
          <div className="cam-live-bar">
            <span className="cam-count-note">{liveNote}</span>
            {liveUrl && (
              <label className="cam-live-check">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                Show everyone detected
              </label>
            )}
          </div>
        </div>
        <div className="cam-info-cards">
          <InfoCard title="Camera" rows={cameraRows} />
          <InfoCard title="AI Edge Box" rows={edgeRows} />
          <button type="button" className="cam-edit" onClick={onEdit}>
            Edit Camera
          </button>
          {infoError && <p className="cam-error">Could not load camera details: {infoError}</p>}
        </div>
      </div>

      <AreasEditor
        camera={editorCamera}
        grabFrame={() => grabFrameRef.current?.() ?? null}
        liveReady={liveMsg.state === 'live'}
        onSaved={setFloorAreas}
        people={peopleSeen}
      />

      <FloorMap
        camera={camera}
        branchName={edge?.branch?.branch_name}
        areas={savedAreas}
        live={liveFrame}
        onSaved={setFloorAreas}
      />


      {people.error && <p className="cam-error">Could not load people count: {people.error}</p>}
      <p className="cam-count-note">People counted by this camera today</p>
      <div className="cam-counts">
        <div className="cam-count-card">
          <span className="cam-count-label">People Passed By</span>
          <span className="cam-count-value">{people.passedBy}</span>
        </div>
        <div className="cam-count-card">
          <span className="cam-count-label">People Walk-in</span>
          <span className="cam-count-value">{people.in}</span>
        </div>
      </div>

      <PeopleTimeline cameraId={camera.camera_id} reloadKey={savedTick} />

      <section className="cam-records">
        <h2>Latest records from this camera</h2>
        <div className="ev-toolbar">
          <div className="tabs">
            <button className={recordTab === 'cctv' ? 'active' : ''} onClick={() => setRecordTab('cctv')}>
              CCTV Event
            </button>
            <button className={recordTab === 'recognition' ? 'active' : ''} onClick={() => setRecordTab('recognition')}>
              Recognition Event
            </button>
          </div>
          <RecordDayFilter day={recordDay} onChange={setRecordDay} />
        </div>
        <div className="event-log-scroll">
          {recordTab === 'cctv' ? (
            <CameraCctvEvents cameraId={camera.camera_id} day={recordDay} reloadKey={savedTick} />
          ) : (
            <CameraRecognitionEvents cameraId={camera.camera_id} day={recordDay} reloadKey={savedTick} />
          )}
        </div>
      </section>
    </>
  )
}
