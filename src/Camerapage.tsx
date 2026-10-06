import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TABLES, useTable } from './Usetable'
import type { Branch, Camera } from './types'
import CameraDetails, { CameraScreen, canCapture, formatLongDate } from './Cameradetails'
import NewCameraPage from './Newcamerapage'
import './Camera.css'

// Branch selected when the page opens
const DEFAULT_BRANCH = 'aeon bukit tinggi'

// How often the camera list (last_seen_at, snapshot URL) is refreshed
const LIST_REFRESH_MS = 15_000

// Why a screen shows (or does not show) a picture, under each camera
function screenStatus(cam: Camera): { text: string; tone: 'ok' | 'wait' | 'off' } {
  if (cam.active_status !== 'Active') return { text: 'Inactive', tone: 'off' }
  if (!cam.edge_device_id) return { text: 'No edge box linked to this camera', tone: 'off' }
  if (canCapture(cam)) return { text: 'Live: picture updates every few seconds', tone: 'ok' }
  if (!cam.last_snapshot_url) return { text: 'Waiting for the edge box to send the first picture', tone: 'wait' }
  return { text: `Edge box offline (last seen ${formatLongDate(cam.last_seen_at)})`, tone: 'off' }
}

export default function CameraPage() {
  const cams = useTable<Camera>(TABLES.camera, 'camera_name', true, 500)
  const branches = useTable<Branch>(TABLES.branch, 'branch_name', true, 500)
  const [branchId, setBranchId] = useState('')
  const [expanded, setExpanded] = useState(false)
  // Sub-pages have their own address: /camera/new and /camera/<camera id>
  const navigate = useNavigate()
  const sub = useParams()['*'] ?? ''
  const adding = sub === 'new'
  const selectedId = sub && !adding ? sub : null

  // Pick AEON Bukit Tinggi by default, or the first branch if it does not exist
  useEffect(() => {
    if (branchId || branches.rows.length === 0) return
    const aeon = branches.rows.find((b) => b.branch_name.toLowerCase().includes(DEFAULT_BRANCH))
    setBranchId((aeon ?? branches.rows[0]).branch_id)
  }, [branches.rows, branchId])

  // Keep last_seen_at and snapshot URLs up to date
  const { reload } = cams
  useEffect(() => {
    const timer = setInterval(reload, LIST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [reload])

  if (adding) {
    return (
      <NewCameraPage
        branches={branches.rows}
        defaultBranchId={branchId}
        onBack={() => navigate('/camera')}
        onSaved={(cam) => {
          setBranchId(cam.branch_id) // show the new camera's branch when going back
          reload()
        }}
      />
    )
  }

  const selected = cams.rows.find((c) => c.camera_id === selectedId)
  if (selected) return <CameraDetails camera={selected} onBack={() => navigate('/camera')} />
  if (selectedId && cams.loading && cams.rows.length === 0) return <p className="ds-lead">Loading camera…</p>

  const branchCams = cams.rows.filter((c) => c.branch_id === branchId)

  return (
    <>
      <h1>Camera</h1>

      <div className="cam-toolbar">
        <label className="cam-filter">
          Branch
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.rows.map((b) => (
              <option key={b.branch_id} value={b.branch_id}>
                {b.branch_name}
              </option>
            ))}
          </select>
        </label>
        <div className="cam-toolbar-actions">
          <button type="button" className="cam-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Collapse view' : 'Expand view'}
          </button>
          <button type="button" className="cam-add" onClick={() => navigate('/camera/new')}>
            + Add camera
          </button>
        </div>
      </div>

      <div className="cam-live">
        <span className="cam-live-dot" aria-hidden="true" />
        LIVE
      </div>

      {cams.error && <p className="cam-error">{cams.error}</p>}
      {cams.loading && cams.rows.length === 0 ? (
        <p className="ds-lead">Loading cameras…</p>
      ) : branchCams.length === 0 ? (
        <p className="ds-lead">No cameras found for this branch. Click "+ Add camera" to add one.</p>
      ) : (
        <div className={`cam-grid ${expanded ? 'cam-grid--4' : 'cam-grid--2'}`}>
          {branchCams.map((cam) => (
            <div className="cam-card" key={cam.camera_id}>
              <div className="cam-card-title">{cam.camera_name}</div>
              <CameraScreen camera={cam} />
              <span className={`cam-status cam-status--${screenStatus(cam).tone}`}>{screenStatus(cam).text}</span>
              {/* Shown for every camera, even before the edge box sends a picture */}
              <button
                type="button"
                className="cam-expand"
                onClick={() => navigate(`/camera/${cam.camera_id}`)}
              >
                {/* expand (arrows to the corners) icon */}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
                Expand camera
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}