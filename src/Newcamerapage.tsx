import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Branch, Camera, EdgeDevice } from './types'
import './Branches.css'
import './Newbranch.css'
import './Camera.css'

// "+ New edge box" option in the Edge box list
const NEW_EDGE = '__new__'

type Notice = { type: 'success' | 'error'; text: string }

// Tapo shows the MAC as AA-BB-CC-DD-EE-FF (or with ":"). Store it one way so the
// UNIQUE check on camera.mac_address also catches the same camera typed differently.
function normaliseMac(value: string): string | null {
  const hex = value.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/../g)!.join('-')
}

// Plain IPv4 such as 192.168.1.50 (the camera's address on the shop network)
function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

// Friendly text for "duplicate value" errors from UNIQUE columns
function saveError(message: string, code?: string): string {
  if (code !== '23505') return message
  if (message.includes('camera_name')) return 'This camera name is already used. Choose another name.'
  if (message.includes('mac_address')) return 'A camera with this MAC address is already saved.'
  if (message.includes('device_name')) return 'This edge box name is already used. Choose another name.'
  return message
}

type Props = {
  branches: Branch[]
  defaultBranchId: string
  onBack: () => void
  onSaved: (camera: Camera) => void
}

// Add a camera to an existing branch. Values come from the Tapo app:
// camera → ⚙️ Settings → Device Info. The camera's username / password are NOT
// saved here; they stay in edge/.env on the edge box.
export default function NewCameraPage({ branches, defaultBranchId, onBack, onSaved }: Props) {
  const [branchId, setBranchId] = useState(defaultBranchId || branches[0]?.branch_id || '')
  const [edgeDevices, setEdgeDevices] = useState<EdgeDevice[]>([])
  const [edgeChoice, setEdgeChoice] = useState('')
  const [newEdgeName, setNewEdgeName] = useState('')

  const [cameraName, setCameraName] = useState('')
  const [tapoModel, setTapoModel] = useState('')
  const [mac, setMac] = useState('')
  const [ip, setIp] = useState('')
  const [streamPath, setStreamPath] = useState<'stream1' | 'stream2'>('stream2')
  const [status, setStatus] = useState<'Active' | 'Inactive'>('Active')

  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [savedEdgeId, setSavedEdgeId] = useState('')

  const branch = useMemo(() => branches.find((b) => b.branch_id === branchId), [branches, branchId])

  // Edge boxes of the chosen branch. None yet → offer to create one.
  useEffect(() => {
    if (!branchId) return
    let cancelled = false
    supabase
      .from(TABLES.edgeDevice)
      .select('edge_device_id, branch_id, device_name, status, last_heartbeat, created_at')
      .eq('branch_id', branchId)
      .order('device_name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setNotice({ type: 'error', text: `Could not load edge boxes: ${error.message}` })
          return
        }
        const rows = (data ?? []) as EdgeDevice[]
        setEdgeDevices(rows)
        setEdgeChoice(rows[0]?.edge_device_id ?? NEW_EDGE)
      })
    return () => {
      cancelled = true
    }
  }, [branchId])

  // Suggest a box name such as EDGE-AEON-BUKIT-TINGGI-01 for the chosen branch
  useEffect(() => {
    if (edgeChoice !== NEW_EDGE || !branch) return
    const slug = branch.branch_name
      .toUpperCase()
      .replace(/^JACKSTUDIO\s*@\s*/, '')
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    setNewEdgeName(`EDGE-${slug}-01`)
  }, [edgeChoice, branch])

  async function handleSave() {
    const fail = (text: string) => setNotice({ type: 'error', text })
    setNotice(null)

    const camera_name = cameraName.trim()
    if (!branchId) return fail('Choose the branch.')
    if (!camera_name) return fail('Enter the camera name (Device name in the Tapo app).')
    if (edgeChoice === NEW_EDGE && !newEdgeName.trim()) return fail('Enter a name for the new edge box.')

    let mac_address: string | null = null
    if (mac.trim()) {
      mac_address = normaliseMac(mac)
      if (!mac_address) return fail('MAC address must have 12 letters/digits, e.g. AA-BB-CC-DD-EE-FF.')
    }
    const ip_address = ip.trim() || null
    if (ip_address && !isIpv4(ip_address)) return fail('IP address must look like 192.168.1.50.')

    setSaving(true)

    // 1. Edge box: use the chosen one, or create it first
    let edge_device_id = edgeChoice
    if (edgeChoice === NEW_EDGE) {
      const { data, error } = await supabase
        .from(TABLES.edgeDevice)
        .insert({ branch_id: branchId, device_name: newEdgeName.trim() })
        .select('edge_device_id, branch_id, device_name, status, last_heartbeat, created_at')
        .single()
      if (error || !data) {
        setSaving(false)
        return fail(`Failed to save the edge box: ${saveError(error?.message ?? 'no row returned', error?.code)}`)
      }
      const created = data as EdgeDevice
      edge_device_id = created.edge_device_id
      setEdgeDevices((prev) => [...prev, created])
      setEdgeChoice(created.edge_device_id) // a retry after a camera error reuses this box
    }

    // 2. Camera
    const { data, error } = await supabase
      .from(TABLES.camera)
      .insert({
        camera_name,
        active_status: status,
        branch_id: branchId,
        edge_device_id,
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
    onSaved(data as Camera)
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
        password are not saved here; they go in <code>edge/.env</code> on the edge box.
      </p>

      {notice && (
        <p className={`bp-notice bp-notice-${notice.type}`} role="status">
          <span>{notice.text}</span>
        </p>
      )}

      {saved && (
        <section className="ds-panel cam-saved">
          <p>
            Put this edge box id in <code>edge/.env</code> as <code>EDGE_DEVICE_ID</code>, then run{' '}
            <code>python main.py</code>. The camera screen appears within a few seconds after the edge box
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
            <span>Branch</span>
            <select value={branchId} disabled={saved} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.branch_id} value={b.branch_id}>
                  {b.branch_name}
                </option>
              ))}
            </select>
            <small className="nb-hint">Branch not listed? Add it first on the Branch page.</small>
          </label>

          <label className="nb-field">
            <span>Edge box</span>
            <select value={edgeChoice} disabled={saved} onChange={(e) => setEdgeChoice(e.target.value)}>
              {edgeDevices.map((d) => (
                <option key={d.edge_device_id} value={d.edge_device_id}>
                  {d.device_name}
                </option>
              ))}
              <option value={NEW_EDGE}>+ New edge box</option>
            </select>
            <small className="nb-hint">The box in this branch that reads this camera's video.</small>
          </label>

          {edgeChoice === NEW_EDGE && (
            <label className="nb-field nb-span2">
              <span>New edge box name</span>
              <input
                value={newEdgeName}
                disabled={saved}
                onChange={(e) => setNewEdgeName(e.target.value)}
                placeholder="e.g. EDGE-AEON-BUKIT-TINGGI-01"
              />
            </label>
          )}

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
            <select value={status} disabled={saved} onChange={(e) => setStatus(e.target.value as 'Active' | 'Inactive')}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </label>
        </div>
      </section>

      <div className="nb-footer">
        {saved ? (
          <button type="button" className="nb-save" onClick={onBack}>
            Done
          </button>
        ) : (
          <button type="button" className="nb-save" disabled={saving || branches.length === 0} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save camera'}
          </button>
        )}
      </div>
    </>
  )
}
