import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Branch, Camera } from './types'
import { EDGE_COLUMNS, type EdgeDeviceRow } from './Edgedevicepage'
import './Branches.css'
import './Newbranch.css'
import './Camera.css'

type Notice = { type: 'success' | 'error'; text: string }

// Tapo shows the MAC as AA-BB-CC-DD-EE-FF (or with ":"). Store it one way so the
// UNIQUE check on camera.mac_address also catches the same camera typed differently.
export function normaliseMac(value: string): string | null {
  const hex = value.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/../g)!.join('-')
}

// Plain IPv4 such as 192.168.1.50 (the camera's address on the shop network)
export function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

// Friendly text for "duplicate value" errors from UNIQUE columns
export function saveError(message: string, code?: string): string {
  if (code !== '23505') return message
  if (message.includes('camera_name')) return 'This camera name is already used. Choose another name.'
  if (message.includes('mac_address')) return 'A camera with this MAC address is already saved.'
  if (message.includes('device_name')) return 'This edge box name is already used. Choose another name.'
  return message
}

type Props = {
  branches: Branch[] // not used any more: the branch comes from the AI edge box
  defaultBranchId: string
  onBack: () => void
  onSaved: (branchId: string, camera: Camera) => void
}

// Add a camera to an existing branch. Values come from the Tapo app:
// camera → ⚙️ Settings → Device Info. The camera's username / password are NOT
// saved here; they stay in edge/.env on the AI edge box.
export default function NewCameraPage({ defaultBranchId, onBack, onSaved }: Props) {
  const [edgeDevices, setEdgeDevices] = useState<EdgeDeviceRow[]>([])
  const [edgeChoice, setEdgeChoice] = useState('')

  const [cameraName, setCameraName] = useState('')
  const [tapoModel, setTapoModel] = useState('')
  const [mac, setMac] = useState('')
  const [ip, setIp] = useState('')
  const [streamPath, setStreamPath] = useState<'stream1' | 'stream2'>('stream2')

  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [savedEdgeId, setSavedEdgeId] = useState('')

  // The branch is not chosen here: it is the branch of the selected AI edge box
  const edge = useMemo(() => edgeDevices.find((d) => d.edge_device_id === edgeChoice), [edgeDevices, edgeChoice])
  const branchId = edge?.branch_id ?? ''

  // All AI edge boxes with their branch:
  //   select ed.*, b.branch_name from edge_device ed join branch b on ed.branch_id = b.branch_id
  // First pick: a box in the branch shown on the Camera page, else the first box.
  useEffect(() => {
    let cancelled = false
    supabase
      .from(TABLES.edgeDevice)
      .select(EDGE_COLUMNS)
      .order('device_name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setNotice({ type: 'error', text: `Could not load AI edge boxes: ${error.message}` })
          return
        }
        const rows = (data ?? []) as unknown as EdgeDeviceRow[]
        setEdgeDevices(rows)
        const first = rows.find((d) => d.branch_id === defaultBranchId) ?? rows[0]
        setEdgeChoice(first?.edge_device_id ?? '')
      })
    return () => {
      cancelled = true
    }
  }, [defaultBranchId])

  async function handleSave() {
    const fail = (text: string) => setNotice({ type: 'error', text })
    setNotice(null)

    const camera_name = cameraName.trim()
    if (!edgeChoice) return fail('Choose the AI edge box. None yet? Add one on the AI Edge Device page.')
    if (!camera_name) return fail('Enter the camera name (Device name in the Tapo app).')

    let mac_address: string | null = null
    if (mac.trim()) {
      mac_address = normaliseMac(mac)
      if (!mac_address) return fail('MAC address must have 12 letters/digits, e.g. AA-BB-CC-DD-EE-FF.')
    }
    const ip_address = ip.trim() || null
    if (ip_address && !isIpv4(ip_address)) return fail('IP address must look like 192.168.1.50.')

    setSaving(true)

    const edge_device_id = edgeChoice

    // Camera
    const { data, error } = await supabase
      .from(TABLES.camera)
      .insert({
        camera_name,
        active_status: 'Inactive', // the AI edge box sets Active once the camera picture is live
        edge_device_id, // the camera's branch comes from this edge box
        tapo_model: tapoModel.trim() || null,
        mac_address,
        ip_address,
        stream_path: streamPath,
      })
      .select('*')
      .single()
    setSaving(false)

    if (error || !data) {
      return fail(`Failed to save the camera ${camera_name}: ${saveError(error?.message ?? 'no row returned', error?.code)}`)
    }

    setSavedEdgeId(edge_device_id)
    setNotice({ type: 'success', text: `The camera ${camera_name} is saved successfully` })
    onSaved(branchId, data as Camera)
  }

  const saved = !!savedEdgeId

  return (
    <>
      <button type="button" className="cam-back" onClick={onBack}>
        ← Back to Camera
      </button>

      <h1>Add Camera</h1>
      <p className="ds-lead">
        Copy the details from the Tapo app: camera → ⚙️ Settings → Device Info. The camera's username and
        password are not saved here; they go in <code>edge/.env</code> on the AI edge box.
      </p>

      {notice && (
        <p className={`bp-notice bp-notice-${notice.type}`} role="status">
          <span>{notice.text}</span>
        </p>
      )}

      {saved && (
        <section className="ds-panel cam-saved">
          <p>
            Put this AI edge box id in <code>edge/.env</code> as <code>EDGE_DEVICE_ID</code>, then run{' '}
            <code>python main.py</code>. The camera screen appears within a few seconds after the AI edge box
            sends its first picture.
          </p>
          <p className="cam-saved-id">
            <code>EDGE_DEVICE_ID={savedEdgeId}</code>
            <button type="button" className="cam-toggle" onClick={() => navigator.clipboard?.writeText(`EDGE_DEVICE_ID=${savedEdgeId}`)}>
              Copy
            </button>
          </p>
        </section>
      )}

      <section className="ds-panel nb-panel cam-form">
        <div className="nb-grid">
          <label className="nb-field">
            <span>AI Edge Box</span>
            <select value={edgeChoice} disabled={saved} onChange={(e) => setEdgeChoice(e.target.value)}>
              {edgeDevices.length === 0 && <option value="">No AI edge boxes yet</option>}
              {edgeDevices.map((d) => (
                <option key={d.edge_device_id} value={d.edge_device_id}>
                  {d.device_name}
                </option>
              ))}
            </select>
            <small className="nb-hint">The box that reads this camera's video. Add boxes on the AI Edge Device page.</small>
          </label>

          <label className="nb-field">
            <span>Branch</span>
            <select value={branchId} disabled>
              <option value={branchId}>{edge?.branch?.branch_name ?? '—'}</option>
            </select>
            <small className="nb-hint">Set by the AI edge box selected.</small>
          </label>

          <label className="nb-field">
            <span>Camera name (Tapo device name)</span>
            <input
              value={cameraName}
              disabled={saved}
              onChange={(e) => setCameraName(e.target.value)}
              placeholder="e.g. ABT-Entrance"
            />
          </label>

          <label className="nb-field">
            <span>Tapo model (optional)</span>
            <input value={tapoModel} disabled={saved} onChange={(e) => setTapoModel(e.target.value)} placeholder="e.g. C200" />
          </label>

          <label className="nb-field">
            <span>MAC address (optional)</span>
            <input value={mac} disabled={saved} onChange={(e) => setMac(e.target.value)} placeholder="e.g. AA-BB-CC-DD-EE-FF" />
          </label>

          <label className="nb-field">
            <span>IP address</span>
            <input value={ip} disabled={saved} onChange={(e) => setIp(e.target.value)} placeholder="e.g. 192.168.1.50" />
            <small className="nb-hint">The same IP you used in VLC. Fix it in your router so it never changes.</small>
          </label>

          <label className="nb-field">
            <span>Stream</span>
            <select value={streamPath} disabled={saved} onChange={(e) => setStreamPath(e.target.value as 'stream1' | 'stream2')}>
              <option value="stream2">stream2 (lower quality, recommended)</option>
              <option value="stream1">stream1 (full quality)</option>
            </select>
          </label>

          <label className="nb-field">
            <span>Status</span>
            <select value="Inactive" disabled>
              <option value="Inactive">Inactive</option>
            </select>
            <small className="nb-hint">Set automatically: Active while the AI edge box receives the camera's open picture.</small>
          </label>
        </div>
      </section>

      <div className="nb-footer">
        {saved ? (
          <button type="button" className="nb-save" onClick={onBack}>
            Done
          </button>
        ) : (
          <button type="button" className="nb-save" disabled={saving || edgeDevices.length === 0} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save camera'}
          </button>
        )}
      </div>
    </>
  )
}
