import { useEffect, useState, type ReactNode } from 'react'
import { Badge } from './Datatable'
import { supabase } from './lib/supabase'
import { TABLES, isOnline } from './Usetable'
import type { Camera } from './types'
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