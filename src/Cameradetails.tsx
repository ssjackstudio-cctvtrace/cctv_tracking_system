import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import DataTable, { Badge } from './Datatable'
import { supabase } from './lib/supabase'
import { TABLES, isOnline } from './Usetable'
import type { Branch, Camera, EdgeDevice, Point } from './types'
import { LiveVideo, type LiveBox, type LiveFrame, type LiveState } from './Livevideo'
import { areasFor, extendedLine, pointInside, readCountLine, splitAreas, inside, type CountAreas } from './countZones'
import { AreasEditor, drawFloorMap, drawPersonBox3d, drawSpace, spaceLines } from './Areaseditor'
import { REGION_COLORS, floorOrAuto, readFloorAreas, regionFloor, type Calibration, type FloorAreas, type RegionKind } from './space3d'
import ShopFloorMap from './Shopfloormap'
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

// People In / Out / Inside for ONE camera, counted from CCTV_EVENT
// (direction = 'In' / 'Out') since midnight today. People, not rows: one
// person (visit = one track_id) is counted once, even when this camera also
// recorded them walking into a shop area (direction In, track_region =
// the area's kind). reloadKey changes when the edge box says a new row was saved,
// so the numbers change at once.
function usePeopleCount(cameraId: string, reloadKey = 0) {
  const [counts, setCounts] = useState({ in: 0, out: 0 })
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const visitsWith = async (direction: 'In' | 'Out') => {
        const ids = new Set<string>()
        for (let from = 0; from < 20000; from += 1000) {
          const { data, error } = await supabase
            .from(TABLES.cctvEvent)
            .select('visit_id')
            .eq('camera_id', cameraId)
            .eq('direction', direction)
            .gte('event_time', startOfToday.toISOString())
            .range(from, from + 999)
          if (error) return { count: 0, error }
          const rows = (data ?? []) as { visit_id: string }[]
          rows.forEach((r) => ids.add(r.visit_id))
          if (rows.length < 1000) break
        }
        return { count: ids.size, error: null }
      }
      const [inRes, outRes] = await Promise.all([visitsWith('In'), visitsWith('Out')])
      if (cancelled) return
      const err = inRes.error ?? outRes.error
      if (err) setError(err.message)
      else {
        setError('')
        setCounts({ in: inRes.count, out: outRes.count })
      }
    }
    load()
    const timer = setInterval(load, COUNT_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cameraId, reloadKey])

  return { ...counts, inside: Math.max(counts.in - counts.out, 0), error }
}

// ---------- People Comes In / Comes Out timeline (today, 30-minute steps) ----------
// Opening hours: 10:00 AM – 10:30 PM on Friday and Saturday, 10:00 AM – 10:00 PM other days.
// Each person (visit_id) is counted once per direction, in the 30 minutes of
// their first In / Out row from this camera today, like the cards above.
const SLOT_MINUTES = 30

type TimelineSlot = { start: Date; in: number; out: number }

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
          .in('direction', ['In', 'Out'])
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
        in: 0,
        out: 0,
      }))
      const seen = { In: new Set<string>(), Out: new Set<string>() }
      for (const r of rows) {
        const dir = r.direction as 'In' | 'Out'
        if (seen[dir].has(r.visit_id)) continue
        seen[dir].add(r.visit_id)
        const i = Math.floor((new Date(r.event_time).getTime() - open.getTime()) / (SLOT_MINUTES * 60_000))
        if (i >= 0 && i < count) next[i][dir === 'In' ? 'in' : 'out'] += 1
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
    in: s.in,
    out: s.out,
  }))
  const ticks = Array.from({ length: Math.floor(closeAt / 60) - OPEN_MINUTES / 60 + 1 }, (_, i) => OPEN_MINUTES + i * 60)
  if (closeAt % 60) ticks.push(closeAt)

  return (
    <section className="cam-timeline">
      <h2>People Comes In / Comes Out today</h2>
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
          <Line type="monotone" dataKey="in" name="People Comes In" stroke={IN_COLOR} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="out" name="People Comes Out" stroke={OUT_COLOR} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
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

// ---------- Drawing on the live video ----------
const IN_COLOR = '#16a34a'
const OUT_COLOR = '#f97316'

function drawAreas(ctx: CanvasRenderingContext2D, areas: CountAreas) {
  const { width: W, height: H } = ctx.canvas
  const path = (poly: Point[]) => {
    ctx.beginPath()
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)))
    ctx.closePath()
  }
  ctx.save()
  ctx.globalAlpha = 0.12
  ctx.fillStyle = IN_COLOR
  path(areas.inZone)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.lineWidth = Math.max(2, W / 400)
  ctx.strokeStyle = '#facc15'
  if (areas.points.length >= 2) {
    ctx.beginPath()
    areas.points.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)))
    ctx.stroke()
  }
  const font = Math.max(12, Math.round(H * 0.035))
  ctx.font = `700 ${font}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const [text, poly, color] of [
    ['IN', areas.inZone, IN_COLOR],
    ['OUT', areas.outZone, OUT_COLOR],
  ] as const) {
    if (poly.length < 3) continue // whole screen is In: no Out area
    const c = pointInside(poly)
    const w = ctx.measureText(text).width + font * 0.6
    ctx.fillStyle = color
    ctx.fillRect(c.x * W - w / 2, c.y * H - font * 0.65, w, font * 1.3)
    ctx.fillStyle = '#fff'
    ctx.fillText(text, c.x * W, c.y * H)
  }
  ctx.restore()
}

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
      : rec?.direction === 'Out'
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
    if (!linked || box.full === false) ctx.setLineDash([6, 4])
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    ctx.setLineDash([])
  }

  const v = rec?.visit
  const gender = box.g ?? v?.est_gender
  const age = box.a ?? v?.est_age
  const score = box.s ?? v?.demographic_score
  const lines = linked
    ? [
        box.track,
        `${v?.visit_type ?? 'Visitor'} · ${rec?.direction === 'Out' ? 'Out' : 'In'}${box.region ? ` · ${box.region}` : ''}`,
        `${gender ?? 'Unknown'} · Age ${fmtAge(age)}`,
        ...(box.xyz && box.full ? [`X ${box.xyz[0].toFixed(1)} · Y ${box.xyz[1].toFixed(1)} · Z ${box.xyz[2].toFixed(2)} m`] : []),
        ...(rec ? [`Match Confidence ${fmt2(rec.confidence)}%`] : []),
        `Demographic Score ${fmt2(score)}`,
        ...(box.full === false ? ['Partly hidden'] : []),
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

// ---------- Count line editor ----------
// Click as many dots as needed (each new dot joins the line), then "Save line",
// then click the area that is inside the shop to label it In (the other area
// is Out), then "Save". The line is stretched at both ends to the picture
// border to split the picture into the two areas. The edge box counts a
// person In when both their feet are completely inside the In area, after
// being seen in the Out area. Out is only counted for people already counted In.

type EditMode = 'view' | 'dots' | 'label'
const round = (v: number) => Math.round(v * 1000) / 1000
const polyPoints = (poly: Point[]) => poly.map((p) => `${p.x},${p.y}`).join(' ')

function CountLineEditor({
  camera,
  grabFrame,
  liveReady,
}: {
  camera: Camera
  grabFrame: () => string | null // a still picture from the live video
  liveReady: boolean // live video is playing
}) {
  const saved = useMemo(() => readCountLine(camera.count_line), [camera.count_line])
  const [mode, setMode] = useState<EditMode>('view')
  const [points, setPoints] = useState<Point[]>([])
  const [inPoint, setInPoint] = useState<Point | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const [frozen, setFrozen] = useState<string | null>(null) // picture from the live video, held still while editing
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const editing = mode !== 'view'
  const background = (editing && frozen) || camera.last_snapshot_url || frozen

  const toPoint = (e: MouseEvent<HTMLDivElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect()
    return {
      x: round(Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1)),
      y: round(Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1)),
    }
  }

  const startEditing = () => {
    const still = grabFrame()
    if (!still && !camera.last_snapshot_url) {
      setMessage('Wait until the live video shows a picture, then try again.')
      return
    }
    setFrozen(still)
    setPoints([])
    setInPoint(null)
    setMessage('')
    setMode('dots')
  }

  const cancel = () => {
    setPoints([])
    setInPoint(null)
    setHover(null)
    setMode('view')
    setMessage('')
  }

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const p = toPoint(e) // read the click position now (the event is gone later)
    if (mode === 'dots') setPoints((pts) => [...pts, p])
    else if (mode === 'label') setInPoint(p)
  }

  // What to draw: the saved line, or the line being edited
  const shown: CountAreas | null =
    mode === 'view' ? saved : mode === 'label' && inPoint ? { points, inPoint, ...areasFor(points, inPoint) } : null
  const split = mode === 'label' ? splitAreas(points) : null
  const hoverArea = split && hover && !inPoint ? (inside(split[0], hover) ? split[0] : split[1]) : null
  const stretched = mode === 'label' && points.length >= 2 ? extendedLine(points) : null

  // Camera inside the shop: everyone it sees is inside (no line, no Out area)
  const saveWholeScreen = async () => {
    setSaving(true)
    setMessage('')
    const { error } = await supabase.from(TABLES.camera).update({ count_line: { all_in: true } }).eq('camera_id', camera.camera_id)
    setSaving(false)
    if (error) setMessage(`Could not save: ${error.message}`)
    else {
      cancel()
      setMessage('Saved: the whole screen is In. The edge box starts using it within a minute.')
    }
  }

  // No line: this camera stops counting (e.g. a camera that does not see the entrance)
  const remove = async () => {
    if (!window.confirm(`Remove the count line of ${camera.camera_name}? It will stop counting people.`)) return
    setSaving(true)
    const { error } = await supabase.from(TABLES.camera).update({ count_line: null }).eq('camera_id', camera.camera_id)
    setSaving(false)
    setMessage(error ? `Could not save: ${error.message}` : 'Count line removed. This camera stops counting within a minute.')
  }

  const save = async () => {
    if (!inPoint || points.length < 2) return
    const { inZone } = areasFor(points, inPoint)
    const r4 = (p: Point) => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 })
    setSaving(true)
    setMessage('')
    const { error } = await supabase
      .from(TABLES.camera)
      .update({ count_line: { points, in_point: inPoint, in_zone: inZone.map(r4) } })
      .eq('camera_id', camera.camera_id)
    setSaving(false)
    if (error) setMessage(`Could not save: ${error.message}`)
    else {
      setMode('view')
      setHover(null)
      setMessage('Saved. The edge box starts using it within a minute.')
    }
  }

  if (!background && !liveReady) {
    return (
      <section className="cam-line">
        <h2>Count line</h2>
        <p className="cam-count-note">
          The count line can be drawn once the edge box sends a picture (live video or snapshot) from this camera.
        </p>
      </section>
    )
  }

  const note =
    mode === 'dots'
      ? points.length < 2
        ? 'Click dots across the shop entrance, one after another. Add as many as you need. For a camera inside the shop that does not see the entrance, click "Whole screen is In".'
        : `${points.length} dots. Keep clicking to add more, or click "Save line" when the line is done.`
      : mode === 'label'
        ? inPoint
          ? 'Green = In (inside the shop), orange = Out. Click the other area or "Swap In / Out" to change, then Save.'
          : 'Now click the area that is INSIDE the shop. It becomes In; the other area becomes Out.'
        : saved && saved.outZone.length === 0
          ? 'Whole screen is In: everyone this camera sees is inside the shop, and keeps the same track ID they got on the other cameras. This camera does not count Out.'
          : saved
          ? (background ? '' : 'The line and In / Out areas are shown on the live video above. ') +
            'A person counts as In when both feet are completely inside the green In area, after being seen in the Out area. Out is only counted for people already counted In.'
          : 'No count line yet, so this camera is not counting. Click "Edit count line".'

  return (
    <section className="cam-line">
      <div className="cam-line-head">
        <h2>Count line</h2>
        {mode === 'view' && (
          <div className="cam-line-actions">
            {camera.count_line && (
              <button type="button" className="cam-toggle" disabled={saving} onClick={remove}>
                Remove line
              </button>
            )}
            <button type="button" className="cam-toggle" onClick={startEditing}>
              Edit count line
            </button>
          </div>
        )}
        {mode === 'dots' && (
          <div className="cam-line-actions">
            <button
              type="button"
              className="cam-toggle"
              disabled={points.length === 0}
              onClick={() => setPoints((pts) => pts.slice(0, -1))}
            >
              Undo dot
            </button>
            <button type="button" className="cam-toggle" disabled={points.length === 0} onClick={() => setPoints([])}>
              Clear
            </button>
            <button type="button" className="cam-toggle" disabled={saving} onClick={saveWholeScreen}>
              Whole screen is In
            </button>
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="cam-line-save"
              disabled={points.length < 2}
              onClick={() => {
                setInPoint(null)
                setMode('label')
              }}
            >
              Save line
            </button>
          </div>
        )}
        {mode === 'label' && (
          <div className="cam-line-actions">
            <button type="button" className="cam-toggle" onClick={() => setMode('dots')}>
              Back to dots
            </button>
            <button
              type="button"
              className="cam-toggle"
              disabled={!inPoint}
              onClick={() => inPoint && setInPoint(pointInside(areasFor(points, inPoint).outZone))}
            >
              Swap In / Out
            </button>
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="cam-line-save" disabled={!inPoint || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <p className="cam-count-note">{note}</p>

      {background && (
      <div
        className={`cam-line-canvas${editing ? ' cam-line-canvas--editing' : ''}`}
        onClick={handleClick}
        onMouseMove={(e) => editing && setHover(toPoint(e))}
        onMouseLeave={() => setHover(null)}
      >
        <img src={background} alt={`Picture from ${camera.camera_name}`} draggable={false} />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {hoverArea && <polygon points={polyPoints(hoverArea)} className="cam-zone-hover" />}
          {shown && (
            <>
              <polygon points={polyPoints(shown.inZone)} className="cam-zone-in" />
              {shown.outZone.length >= 3 && <polygon points={polyPoints(shown.outZone)} className="cam-zone-out" />}
            </>
          )}
          {stretched && (
            <>
              <line
                x1={stretched[0].x}
                y1={stretched[0].y}
                x2={points[0].x}
                y2={points[0].y}
                className="cam-line-stretch"
              />
              <line
                x1={points[points.length - 1].x}
                y1={points[points.length - 1].y}
                x2={stretched[stretched.length - 1].x}
                y2={stretched[stretched.length - 1].y}
                className="cam-line-stretch"
              />
            </>
          )}
          {(mode === 'view' ? (saved?.points ?? []) : points).length >= 2 && (
            <polyline points={polyPoints(mode === 'view' ? saved!.points : points)} className="cam-line-path" />
          )}
          {mode === 'dots' && hover && points.length > 0 && (
            <line
              x1={points[points.length - 1].x}
              y1={points[points.length - 1].y}
              x2={hover.x}
              y2={hover.y}
              className="cam-line-next"
            />
          )}
        </svg>
        {editing &&
          points.map((p, i) => (
            <span key={i} className="cam-line-dot" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />
          ))}
        {shown &&
          ([
            ['IN', shown.inZone, 'cam-line-in'],
            ['OUT', shown.outZone, 'cam-line-out'],
          ] as const).map(([text, poly, cls]) => {
            if (poly.length < 3) return null
            const c = pointInside(poly)
            return (
              <span key={text} className={cls} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>
                {text}
              </span>
            )
          })}
      </div>
      )}

      {message && <p className={message.startsWith('Could') ? 'cam-error' : 'cam-count-note'}>{message}</p>}
    </section>
  )
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
  const areas = useMemo(() => readCountLine(camera.count_line), [camera.count_line])
  // 3D floor + shop areas (updated at once when saved below, before the camera list reloads)
  const [savedAreas, setFloorAreas] = useState<FloorAreas>(() => readFloorAreas(camera.floor_areas))
  useEffect(() => setFloorAreas(readFloorAreas(camera.floor_areas)), [camera.floor_areas])
  // The saved floor, or the automatic floor (camera 3.25 m high) until one is saved
  const floorAreas = useMemo<FloorAreas>(() => {
    const calibration = floorOrAuto(savedAreas.calibration)
    return { ...savedAreas, calibration, regions: savedAreas.regions.map((r) => ({ ...r, floor: regionFloor(calibration, r.image) })) }
  }, [savedAreas])
  const space = useMemo(() => spaceLines(floorAreas), [floorAreas])
  // Full-body people seen on the live video (feet + top of head), for "Auto-fit tilt from people"
  const peopleSeen = useRef<{ foot: Point; head: Point }[]>([])
  const lastSample = useRef(0)
  const [showAll, setShowAll] = useState(false)
  const [liveMsg, setLiveMsg] = useState<{ state: LiveState; msg: string }>({ state: 'connecting', msg: '' })
  const grabFrameRef = useRef<(() => string | null) | null>(null)
  const onLiveState = useCallback((state: LiveState, msg: string) => setLiveMsg({ state, msg }), [])
  // People inside = people standing in this camera's In area right now (from the live video)
  const [insideNow, setInsideNow] = useState<number | null>(null)

  // 3D view: floor grid + X / Y / Z axes + shop areas as 3D boxes, the count
  // line and In area, then each person (3D box + label), and a floor map
  const draw = (ctx: CanvasRenderingContext2D, frame: LiveFrame) => {
    const nIn = frame.boxes.filter((b) => b.area === 'in').length
    setInsideNow((cur) => (cur === nIn ? cur : nIn))
    if (Date.now() - lastSample.current > 500) {
      lastSample.current = Date.now()
      for (const b of frame.boxes) {
        if (!b.full) continue
        const x = (b.b[0] + b.b[2]) / 2
        peopleSeen.current.push({ foot: { x, y: b.b[3] }, head: { x, y: b.b[1] } })
      }
      if (peopleSeen.current.length > 400) peopleSeen.current.splice(0, peopleSeen.current.length - 400)
    }
    drawSpace(ctx, space)
    if (areas) drawAreas(ctx, areas)
    const shown = frame.boxes.filter((box) => box.visit || records.byTrack.has(box.track) || showAll)
    for (const box of shown) drawPerson(ctx, box, records.byTrack.get(box.track), floorAreas.calibration)
    drawFloorMap(ctx, floorAreas, shown, (b) =>
      b.kind && b.kind in REGION_COLORS ? REGION_COLORS[b.kind as RegionKind] : b.visit ? IN_COLOR : '#94a3b8',
    )
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
        ['Edge Device Status', <Badge text={edge.status} />],
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

      <CountLineEditor
        camera={camera}
        grabFrame={() => grabFrameRef.current?.() ?? null}
        liveReady={liveMsg.state === 'live'}
      />

      <AreasEditor
        camera={camera}
        grabFrame={() => grabFrameRef.current?.() ?? null}
        liveReady={liveMsg.state === 'live'}
        onSaved={setFloorAreas}
        people={peopleSeen}
      />

      <ShopFloorMap
        camera={camera}
        onSaved={(cameraId, value) => cameraId === camera.camera_id && setFloorAreas(value)}
      />

      {people.error && <p className="cam-error">Could not load people count: {people.error}</p>}
      <p className="cam-count-note">People counted by this camera today</p>
      <div className="cam-counts">
        <div className="cam-count-card">
          <span className="cam-count-label">People Comes In</span>
          <span className="cam-count-value">{people.in}</span>
        </div>
        <div className="cam-count-card">
          <span className="cam-count-label">People Comes Out</span>
          <span className="cam-count-value">{people.out}</span>
        </div>
        <div className="cam-count-card">
          <span className="cam-count-label">People Inside (now, this camera)</span>
          <span className="cam-count-value">{liveMsg.state === 'live' && insideNow !== null ? insideNow : '—'}</span>
        </div>
      </div>

      <PeopleTimeline cameraId={camera.camera_id} reloadKey={savedTick} />

      <section className="cam-records">
        <h2>Latest records from this camera</h2>
        <DataTable
          rows={records.rows.slice(0, 10)}
          loading={records.loading}
          error={records.error}
          emptyMessage="No people counted by this camera yet."
          rowKey={(r) => r.cctv_event_id}
          columns={[
            { header: 'Time', render: (r) => formatLongDateTime(r.event_time) },
            { header: 'Track ID', render: (r) => r.visit.track_id },
            { header: 'Visit Type', render: (r) => <Badge text={r.visit.visit_type} /> },
            { header: 'Direction', render: (r) => <Badge text={r.direction} /> },
            { header: 'Track Region', render: (r) => r.track_region ?? '—' },
            { header: 'Gender', render: (r) => r.visit.est_gender },
            { header: 'Age', render: (r) => fmtAge(r.visit.est_age) },
            { header: 'Match Confidence', render: (r) => `${fmt2(r.confidence)}%` },
            { header: 'Demographic Score', render: (r) => fmt2(r.visit.demographic_score) },
          ]}
        />
      </section>
    </>
  )
}
