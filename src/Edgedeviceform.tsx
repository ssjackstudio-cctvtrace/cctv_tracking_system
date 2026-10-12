import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Branch } from './types'
import { CrossIcon, EDGE_COLUMNS, TickIcon, formatDate, type EdgeDeviceRow } from './Edgedevicepage'
import './Branches.css'
import './Newbranch.css'
import './Edgedevice.css'

type BranchOption = Pick<Branch, 'branch_id' | 'branch_name'>
type Notice = { type: 'success' | 'error'; text: string }

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}

// Edge box chip with a plus (new) or a pencil (edit)
function EdgeTitleIcon({ edit }: { edit?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 5h14v14H5zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
      {edit ? <path d="m9.5 14.5 4-4 1 1-4 4H9.5z" /> : <path d="M12 9v6M9 12h6" />}
    </svg>
  )
}

// Friendly text for the UNIQUE device_name error
function saveError(message: string, code?: string): string {
  if (code === '23505' && message.includes('device_name')) return 'This device name is already used. Choose another name.'
  return message
}

function useBranches() {
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    supabase
      .from(TABLES.branch)
      .select('branch_id, branch_name')
      .order('branch_name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        else setBranches((data ?? []) as BranchOption[])
      })
    return () => {
      cancelled = true
    }
  }, [])
  return { branches, error }
}

type FieldsProps = {
  name: string
  setName: (v: string) => void
  branchId: string
  setBranchId: (v: string) => void
  branches: BranchOption[]
  status: string
  lastHeartbeat: string
  createdAt: string
}

// Device Name + Branch can be changed; Status, Last heartbeat and Created at are set automatically
function EdgeFields({ name, setName, branchId, setBranchId, branches, status, lastHeartbeat, createdAt }: FieldsProps) {
  return (
    <section className="ds-panel nb-panel ed-form">
      <div className="nb-grid">
        <label className="nb-field">
          <span>Device Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. JS-ABT-EDGE-01" />
        </label>

        <label className="nb-field">
          <span>Branch</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.length === 0 && <option value="">No branches yet</option>}
            {branches.map((b) => (
              <option key={b.branch_id} value={b.branch_id}>
                {b.branch_name}
              </option>
            ))}
          </select>
        </label>

        <label className="nb-field">
          <span>Status</span>
          <input value={status} disabled />
          <small className="nb-hint">Set automatically: Online while the AI edge box is running.</small>
        </label>

        <label className="nb-field">
          <span>Last Heartbeat</span>
          <input value={lastHeartbeat} disabled />
          <small className="nb-hint">Updated by the AI edge box every minute.</small>
        </label>

        <label className="nb-field">
          <span>Created At</span>
          <input value={createdAt} disabled />
        </label>
      </div>
    </section>
  )
}

function NoticeBar({ notice }: { notice: Notice | null }) {
  if (!notice) return null
  return (
    <p className={`bp-notice bp-notice-${notice.type}`} role="status">
      {notice.type === 'success' ? <TickIcon /> : <CrossIcon />}
      <span>{notice.text}</span>
    </p>
  )
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="bc-btn nb-back" onClick={onBack}>
      <ArrowLeftIcon />
      Back to AI Edge Box
    </button>
  )
}

// ---------- New AI Edge Box ----------
export function NewEdgeDevicePage({ onBack }: { onBack: () => void }) {
  const { branches, error: branchError } = useBranches()
  const [name, setName] = useState('')
  const [branchId, setBranchId] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // First branch selected once the list arrives
  useEffect(() => {
    if (!branchId && branches.length) setBranchId(branches[0].branch_id)
  }, [branches, branchId])

  async function handleSave() {
    const device_name = name.trim()
    const fail = (text: string) => setNotice({ type: 'error', text })
    setNotice(null)
    if (!device_name) return fail('Enter the device name.')
    if (!branchId) return fail('Choose the branch.')

    setSaving(true)
    // status, last_heartbeat and created_at keep their column defaults
    const { data, error } = await supabase
      .from(TABLES.edgeDevice)
      .insert({ device_name, branch_id: branchId })
      .select('edge_device_id')
      .single()
    setSaving(false)

    if (error || !data) {
      return fail(`Failed to save the AI edge box ${device_name}: ${saveError(error?.message ?? 'no row returned', error?.code)}`)
    }
    setNotice({ type: 'success', text: `The AI edge box ${device_name} is saved successfully` })
    setName('')
  }

  return (
    <>
      <BackButton onBack={onBack} />

      <h1 className="nb-title">
        <EdgeTitleIcon />
        New AI Edge Box
      </h1>
      <p className="ds-lead">Add the AI edge box that reads the cameras of a branch.</p>

      <NoticeBar notice={notice} />
      {branchError && <p className="ds-error">Failed to load branches: {branchError}</p>}

      <EdgeFields
        name={name}
        setName={setName}
        branchId={branchId}
        setBranchId={setBranchId}
        branches={branches}
        status="Offline"
        lastHeartbeat="—"
        createdAt={formatDate(new Date().toISOString())}
      />

      <div className="nb-footer">
        <button type="button" className="nb-save" disabled={saving || branches.length === 0} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save AI Edge Box'}
        </button>
      </div>
    </>
  )
}

// ---------- Edit AI Edge Box ----------
export function EditEdgeDevicePage({ edgeDeviceId, onBack }: { edgeDeviceId: string; onBack: () => void }) {
  const { branches, error: branchError } = useBranches()
  const [device, setDevice] = useState<EdgeDeviceRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [branchId, setBranchId] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  // The selected AI edge box
  useEffect(() => {
    let cancelled = false
    supabase
      .from(TABLES.edgeDevice)
      .select(EDGE_COLUMNS)
      .eq('edge_device_id', edgeDeviceId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setLoadError(error.message)
        else if (!data) setLoadError('This AI edge box was not found.')
        else {
          const row = data as unknown as EdgeDeviceRow
          setDevice(row)
          setName(row.device_name)
          setBranchId(row.branch_id)
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [edgeDeviceId])

  async function handleUpdate() {
    if (!device) return
    const device_name = name.trim()
    const fail = (text: string) => setNotice({ type: 'error', text })
    setNotice(null)
    if (!device_name) return fail('Enter the device name.')
    if (!branchId) return fail('Choose the branch.')

    setSaving(true)
    const { data, error } = await supabase
      .from(TABLES.edgeDevice)
      .update({ device_name, branch_id: branchId })
      .eq('edge_device_id', device.edge_device_id)
      .select(EDGE_COLUMNS)
    setSaving(false)

    if (error) {
      return fail(`Failed to update the AI edge box ${device_name}: ${saveError(error.message, error.code)}`)
    }
    // RLS can block silently: no error, but zero rows come back
    if (!data || data.length === 0) {
      return fail(`Failed to update the AI edge box ${device_name}: permission denied (check the update policy on the edge_device table)`)
    }
    const row = data[0] as unknown as EdgeDeviceRow
    setDevice(row)
    setName(row.device_name)
    setNotice({ type: 'success', text: `The AI edge box ${device_name} is updated successfully` })
  }

  return (
    <>
      <BackButton onBack={onBack} />

      <h1 className="nb-title">
        <EdgeTitleIcon edit />
        Edit AI Edge Box
      </h1>
      <p className="ds-lead">Change the device name or move the AI edge box to another branch.</p>

      <NoticeBar notice={notice} />
      {branchError && <p className="ds-error">Failed to load branches: {branchError}</p>}
      {loading && <p className="ds-empty">Loading…</p>}
      {loadError && <p className="ds-error">Failed to load the AI edge box: {loadError}</p>}

      {device && (
        <>
          <EdgeFields
            name={name}
            setName={setName}
            branchId={branchId}
            setBranchId={setBranchId}
            branches={branches}
            status={device.status}
            lastHeartbeat={formatDate(device.last_heartbeat)}
            createdAt={formatDate(device.created_at)}
          />

          <div className="nb-footer">
            <button type="button" className="nb-save" disabled={saving} onClick={handleUpdate}>
              {saving ? 'Updating…' : 'Update AI Edge Box'}
            </button>
          </div>
        </>
      )}
    </>
  )
}
