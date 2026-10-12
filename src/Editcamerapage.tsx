import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Camera } from './types'
import { EDGE_COLUMNS, type EdgeDeviceRow } from './Edgedevicepage'
import { isIpv4, normaliseMac, saveError } from './Newcamerapage'
import './Branches.css'
import './Newbranch.css'
import './Camera.css'

type Notice = { type: 'success' | 'error'; text: string }

type Props = {
  camera: Camera
  onBack: () => void
  onSaved: (camera: Camera) => void
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}

// Change one camera's details. The branch is not chosen here: it is the branch
// of the selected AI edge box. active_status is set by the AI edge box itself.
export default function EditCameraPage({ camera, onBack, onSaved }: Props) {
  const [edgeDevices, setEdgeDevices] = useState<EdgeDeviceRow[]>([])
  const [edgeChoice, setEdgeChoice] = useState(camera.edge_device_id ?? '')

  const [cameraName, setCameraName] = useState(camera.camera_name)
  const [tapoModel, setTapoModel] = useState(camera.tapo_model ?? '')
  const [mac, setMac] = useState(camera.mac_address ?? '')
  const [ip, setIp] = useState((camera.ip_address ?? '').split('/')[0]) // inet may come back as "192.168.1.50/32"
  const [streamPath, setStreamPath] = useState<'stream1' | 'stream2'>(camera.stream_path ?? 'stream2')

  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const edge = useMemo(() => edgeDevices.find((d) => d.edge_device_id === edgeChoice), [edgeDevices, edgeChoice])

  // All AI edge boxes with their branch:
  //   select ed.*, b.branch_name from edge_device ed join branch b on ed.branch_id = b.branch_id
  useEffect(() => {
    let cancelled = false
    supabase
      .from(TABLES.edgeDevice)
      .select(EDGE_COLUMNS)
      .order('device_name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setNotice({ type: 'error', text: `Could not load AI edge boxes: ${error.message}` })
        else setEdgeDevices((data ?? []) as unknown as EdgeDeviceRow[])
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleUpdate() {
    const fail = (text: string) => setNotice({ type: 'error', text })
    setNotice(null)

    const camera_name = cameraName.trim()
    if (!edgeChoice) return fail('Choose the AI edge box.')
    if (!camera_name) return fail('Enter the camera name (Device name in the Tapo app).')

    let mac_address: string | null = null
    if (mac.trim()) {
      mac_address = normaliseMac(mac)
      if (!mac_address) return fail('MAC address must have 12 letters/digits, e.g. AA-BB-CC-DD-EE-FF.')
    }
    const ip_address = ip.trim() || null
    if (ip_address && !isIpv4(ip_address)) return fail('IP address must look like 192.168.1.50.')

    setSaving(true)
    const { data, error } = await supabase
      .from(TABLES.camera)
      .update({
        camera_name,
        edge_device_id: edgeChoice, // the camera's branch comes from this edge box
        tapo_model: tapoModel.trim() || null,
        mac_address,
        ip_address,
        stream_path: streamPath,
      })
      .eq('camera_id', camera.camera_id)
      .select('*')
    setSaving(false)

    if (error) {
      return fail(`Failed to update the camera ${camera_name}: ${saveError(error.message, error.code)}`)
    }
    // RLS can block silently: no error, but zero rows come back
    if (!data || data.length === 0) {
      return fail(`Failed to update the camera ${camera_name}: permission denied (check the update policy on the camera table)`)
    }
    setNotice({ type: 'success', text: `The camera ${camera_name} is updated successfully` })
    onSaved(data[0] as Camera)
  }

  return (
    <>
      <button type="button" className="bc-btn nb-back" onClick={onBack}>
        <ArrowLeftIcon />
        Back to Camera Details
      </button>

      <h1>Edit Camera ({camera.camera_name})</h1>
      <p className="ds-lead">
        Change the camera's details from the Tapo app: camera → ⚙️ Settings → Device Info. The branch follows the AI
        edge box you choose.
      </p>

      {notice && (
        <p className={`bp-notice bp-notice-${notice.type}`} role="status">
          <span>{notice.text}</span>
        </p>
      )}

      <section className="ds-panel nb-panel cam-form">
        <div className="nb-grid">
          <label className="nb-field">
            <span>AI Edge Box</span>
            <select value={edgeChoice} onChange={(e) => setEdgeChoice(e.target.value)}>
              {!edgeChoice && <option value="">Choose an AI edge box</option>}
              {edgeDevices.map((d) => (
                <option key={d.edge_device_id} value={d.edge_device_id}>
                  {d.device_name}
                </option>
              ))}
            </select>
            <small className="nb-hint">The box that reads this camera's video.</small>
          </label>

          <label className="nb-field">
            <span>Branch</span>
            <select value={edge?.branch_id ?? ''} disabled>
              <option value={edge?.branch_id ?? ''}>{edge?.branch?.branch_name ?? '—'}</option>
            </select>
            <small className="nb-hint">Set by the AI edge box selected.</small>
          </label>

          <label className="nb-field">
            <span>Camera Name</span>
            <input value={cameraName} onChange={(e) => setCameraName(e.target.value)} placeholder="e.g. ABT-Entrance" />
          </label>

          <label className="nb-field">
            <span>Tapo Model</span>
            <input value={tapoModel} onChange={(e) => setTapoModel(e.target.value)} placeholder="e.g. C200" />
          </label>

          <label className="nb-field">
            <span>MAC Address</span>
            <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="e.g. AA-BB-CC-DD-EE-FF" />
          </label>

          <label className="nb-field">
            <span>IP Address</span>
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="e.g. 192.168.1.50" />
          </label>

          <label className="nb-field">
            <span>Stream</span>
            <select value={streamPath} onChange={(e) => setStreamPath(e.target.value as 'stream1' | 'stream2')}>
              <option value="stream2">stream2 (lower quality, recommended)</option>
              <option value="stream1">stream1 (full quality)</option>
            </select>
          </label>

          <label className="nb-field">
            <span>Status</span>
            <select value={camera.active_status} disabled>
              <option value={camera.active_status}>{camera.active_status}</option>
            </select>
            <small className="nb-hint">Set automatically: Active while the AI edge box receives the camera's open picture.</small>
          </label>
        </div>
      </section>

      <div className="nb-footer">
        <button type="button" className="nb-save" disabled={saving} onClick={handleUpdate}>
          {saving ? 'Updating…' : 'Update Camera'}
        </button>
      </div>
    </>
  )
}
