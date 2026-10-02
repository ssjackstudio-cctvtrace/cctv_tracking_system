import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Badge } from './Datatable'
import { supabase } from './lib/supabase'
import { TABLES, isOnline } from './Usetable'
import type { Camera, CountLine, Point } from './types'
import './Camera.css'

// How often the snapshot image and people counts refresh
const SNAPSHOT_REFRESH_MS = 5_000
const COUNT_REFRESH_MS = 10_000

// "01 October 2026"
export const formatLongDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—'

// A camera can show a live capture when it is active, the edge box has
// uploaded a snapshot, and the edge box reported in the last 5 minutes.
export const canCapture = (cam: Camera) =>
  cam.active_status === 'Active' && !!cam.last_snapshot_url && isOnline(cam.last_seen_at)

// Live screen: shows the latest snapshot uploaded by the edge box and
// reloads it every few seconds. Shows "Cannot capture" when there is none.
export function CameraScreen({ camera }: { camera: Camera }) {
  const [tick, setTick] = useState(0)
  const [failed, setFailed] = useState(false)
  const live = canCapture(camera)

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setTick((t) => t + 1), SNAPSHOT_REFRESH_MS)
    return () => clearInterval(timer)
  }, [live])

  useEffect(() => setFailed(false), [camera.last_snapshot_url])

  if (!live || failed) {
    return (
      <div className="cam-screen cam-screen--empty">
        <span>Cannot capture</span>
      </div>
    )
  }

  const url = camera.last_snapshot_url as string
  const src = `${url}${url.includes('?') ? '&' : '?'}t=${tick}`
  return (
    <div className="cam-screen">
      <img src={src} alt={`Live capture from ${camera.camera_name}`} onError={() => setFailed(true)} />
    </div>
  )
}

// People In / Out / Inside for ONE camera, counted from CCTV_EVENT
// (direction = 'In' / 'Out') since midnight today.
function usePeopleCount(cameraId: string) {
  const [counts, setCounts] = useState({ in: 0, out: 0 })
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const countDirection = (direction: 'In' | 'Out') =>
        supabase
          .from(TABLES.cctvEvent)
          .select('cctv_event_id', { count: 'exact', head: true })
          .eq('camera_id', cameraId)
          .eq('direction', direction)
          .gte('event_time', startOfToday.toISOString())
      const [inRes, outRes] = await Promise.all([countDirection('In'), countDirection('Out')])
      if (cancelled) return
      const err = inRes.error ?? outRes.error
      if (err) setError(err.message)
      else {
        setError('')
        setCounts({ in: inRes.count ?? 0, out: outRes.count ?? 0 })
      }
    }
    load()
    const timer = setInterval(load, COUNT_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cameraId])

  return { ...counts, inside: Math.max(counts.in - counts.out, 0), error }
}

// ---------- Count line editor ----------
// The edge box counts a person when their feet cross this line. Points are
// 0–1 fractions of the picture (same as camera.count_line). Crossing towards
// the green arrow is "In", away from it is "Out".

// Arrow from the middle of the line towards the "In" side, in 0–1 units.
// aspect = picture width / height, so the arrow is drawn at a right angle on screen.
function inArrow(line: CountLine, aspect: number) {
  const mid = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 }
  const dx = (line.end.x - line.start.x) * aspect // in "height units"
  const dy = line.end.y - line.start.y
  const len = Math.hypot(dx, dy) || 1
  const size = 0.12
  // (dy, -dx) is the side the edge box treats as "In"
  const tip = { x: mid.x + ((dy / len) * size) / aspect, y: mid.y + (-dx / len) * size }
  return { mid, tip }
}

function CountLineEditor({ camera }: { camera: Camera }) {
  const [line, setLine] = useState<CountLine | null>(camera.count_line)
  const [pending, setPending] = useState<Point | null>(null) // first click, waiting for the second
  const [editing, setEditing] = useState(false)
  const [aspect, setAspect] = useState(16 / 9)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // Follow changes saved elsewhere while not editing
  useEffect(() => {
    if (!editing) setLine(camera.count_line)
  }, [camera.count_line, editing])

  if (!camera.last_snapshot_url) {
    return (
      <section className="cam-line">
        <h2>Count line</h2>
        <p className="cam-count-note">
          The count line can be drawn once the edge box has sent a picture from this camera.
        </p>
      </section>
    )
  }

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!editing) return
    const box = e.currentTarget.getBoundingClientRect()
    const p = {
      x: Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1),
    }
    const round = (v: number) => Math.round(v * 1000) / 1000
    if (!pending) {
      setPending({ x: round(p.x), y: round(p.y) })
      setLine(null)
    } else {
      setLine({ start: pending, end: { x: round(p.x), y: round(p.y) } })
      setPending(null)
    }
    setMessage('')
  }

  const save = async () => {
    setSaving(true)
    setMessage('')
    const { error } = await supabase
      .from(TABLES.camera)
      .update({ count_line: line })
      .eq('camera_id', camera.camera_id)
    setSaving(false)
    if (error) setMessage(`Could not save: ${error.message}`)
    else {
      setEditing(false)
      setMessage('Saved. The edge box starts using it within a minute.')
    }
  }

  const cancel = () => {
    setLine(camera.count_line)
    setPending(null)
    setEditing(false)
    setMessage('')
  }

  const arrow = line ? inArrow(line, aspect) : null

  return (
    <section className="cam-line">
      <div className="cam-line-head">
        <h2>Count line</h2>
        {!editing ? (
          <button type="button" className="cam-toggle" onClick={() => setEditing(true)}>
            Edit count line
          </button>
        ) : (
          <div className="cam-line-actions">
            <button
              type="button"
              className="cam-toggle"
              disabled={!line}
              onClick={() => line && setLine({ start: line.end, end: line.start })}
            >
              Flip direction
            </button>
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="cam-line-save" disabled={!line || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <p className="cam-count-note">
        {editing
          ? pending
            ? 'Now click the second end of the line.'
            : 'Click two points across the doorway. People crossing towards the green arrow count as In.'
          : line
            ? 'People crossing towards the green arrow count as In, the other way as Out.'
            : 'No count line yet, so this camera is not counting. Click "Edit count line".'}
      </p>

      <div
        className={`cam-line-canvas${editing ? ' cam-line-canvas--editing' : ''}`}
        onClick={handleClick}
      >
        <img
          src={camera.last_snapshot_url}
          alt={`Picture from ${camera.camera_name}`}
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight)
          }}
        />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {pending && <circle cx={pending.x} cy={pending.y} r="0.012" className="cam-line-dot" />}
          {line && arrow && (
            <>
              <line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} className="cam-line-path" />
              <line x1={arrow.mid.x} y1={arrow.mid.y} x2={arrow.tip.x} y2={arrow.tip.y} className="cam-line-arrow" />
              <circle cx={arrow.tip.x} cy={arrow.tip.y} r="0.012" className="cam-line-arrowhead" />
            </>
          )}
        </svg>
        {arrow && (
          <span className="cam-line-in" style={{ left: `${arrow.tip.x * 100}%`, top: `${arrow.tip.y * 100}%` }}>
            IN
          </span>
        )}
      </div>

      {message && <p className={message.startsWith('Could') ? 'cam-error' : 'cam-count-note'}>{message}</p>}
    </section>
  )
}

export default function CameraDetails({ camera, onBack }: { camera: Camera; onBack: () => void }) {
  const people = usePeopleCount(camera.camera_id)

  const details: [string, ReactNode][] = [
    ['Status', <Badge text={camera.active_status} />],
    ['Tapo Model', camera.tapo_model ?? '—'],
    ['MAC Address', camera.mac_address ?? '—'],
    ['IP Address', camera.ip_address ?? '—'],
    ['Stream Path', camera.stream_path ?? '—'],
    ['Last Seen', formatLongDate(camera.last_seen_at)],
    ['Created', formatLongDate(camera.created_at)],
  ]

  return (
    <>
      <button type="button" className="cam-back" onClick={onBack}>
        ← Back to Camera
      </button>

      <h1>Camera ({camera.camera_name})</h1>

      <div className="cam-detail">
        <CameraScreen camera={camera} />
        <dl className="cam-info">
          {details.map(([label, value]) => (
            <div className="cam-info-row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <CountLineEditor camera={camera} />

      {people.error && <p className="cam-error">Could not load people count: {people.error}</p>}
      <p className="cam-count-note">People counted by this camera today</p>
      <div className="cam-counts">
        <div className="cam-count-card">
          <span className="cam-count-label">People In</span>
          <span className="cam-count-value">{people.in}</span>
        </div>
        <div className="cam-count-card">
          <span className="cam-count-label">People Out</span>
          <span className="cam-count-value">{people.out}</span>
        </div>
        <div className="cam-count-card">
          <span className="cam-count-label">People Inside</span>
          <span className="cam-count-value">{people.inside}</span>
        </div>
      </div>
    </>
  )
}