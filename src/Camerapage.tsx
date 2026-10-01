import { useEffect, useState } from 'react'
import { TABLES, useTable } from './Usetable'
import type { Branch, Camera } from './types'
import CameraDetails, { CameraScreen, canCapture } from './CameraDetails'
import './Camera.css'

// Branch selected when the page opens
const DEFAULT_BRANCH = 'aeon bukit tinggi'

// How often the camera list (last_seen_at, snapshot URL) is refreshed
const LIST_REFRESH_MS = 15_000

export default function CameraPage() {
  const cams = useTable<Camera>(TABLES.camera, 'camera_name', true, 500)
  const branches = useTable<Branch>(TABLES.branch, 'branch_name', true, 500)
  const [branchId, setBranchId] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  const selected = cams.rows.find((c) => c.camera_id === selectedId)
  if (selected) return <CameraDetails camera={selected} onBack={() => setSelectedId(null)} />

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
        <button type="button" className="cam-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse view' : 'Expand view'}
        </button>
      </div>

      <div className="cam-live">
        <span className="cam-live-dot" aria-hidden="true" />
        LIVE
      </div>

      {cams.error && <p className="cam-error">{cams.error}</p>}
      {cams.loading && cams.rows.length === 0 ? (
        <p className="ds-lead">Loading cameras…</p>
      ) : branchCams.length === 0 ? (
        <p className="ds-lead">No cameras found for this branch.</p>
      ) : (
        <div className={`cam-grid ${expanded ? 'cam-grid--4' : 'cam-grid--2'}`}>
          {branchCams.map((cam) => (
            <div className="cam-card" key={cam.camera_id}>
              <div className="cam-card-title">{cam.camera_name}</div>
              <CameraScreen camera={cam} />
              {canCapture(cam) && (
                <button
                  type="button"
                  className="cam-expand"
                  onClick={() => setSelectedId(cam.camera_id)}
                >
                  Expand camera
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}