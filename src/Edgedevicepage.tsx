import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES, edgeStatusNow } from './Usetable'
import type { Branch, EdgeDevice } from './types'
import './Branches.css'
import './Edgedevice.css'

// select ed.device_name, b.branch_name, ed.status, ed.last_heartbeat, ed.created_at
// from edge_device ed join branch b on ed.branch_id = b.branch_id
export const EDGE_COLUMNS =
  'edge_device_id, branch_id, device_name, status, last_heartbeat, created_at, branch!inner(branch_name)'

export type EdgeDeviceRow = EdgeDevice & { branch: Pick<Branch, 'branch_name'> | null }

type BranchOption = Pick<Branch, 'branch_id' | 'branch_name'>

type Props = {
  onAdd: () => void
  onManage: (edgeDeviceId: string) => void
}

type Notice = { type: 'success' | 'error'; text: string }

// DD Month YYYY, e.g. 05 March 2026
export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '—'

export function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m7.5 12.5 3 3 6-7" />
    </svg>
  )
}

export function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

// Online = green pad, Offline = grey pad
export function EdgeStatus({ status }: { status: string }) {
  return <span className={`ed-status ed-status--${status === 'Online' ? 'online' : 'offline'}`}>{status}</span>
}

function EdgeDeviceCard({
  device,
  busy,
  onManage,
  onDelete,
}: {
  device: EdgeDeviceRow
  busy: boolean
  onManage: (id: string) => void
  onDelete: (device: EdgeDeviceRow) => void
}) {
  return (
    <div className="card bc">
      <h2 className="bc-title">{device.device_name}</h2>

      <div className="bc-details">
        <div className="bc-row">
          <span className="bc-label">Created</span>
          <span className="bc-colon">:</span>
          <span className="bc-value">{formatDate(device.created_at)}</span>
        </div>
        <div className="bc-row">
          <span className="bc-label">Last heartbeat</span>
          <span className="bc-colon">:</span>
          <span className="bc-value">{formatDate(device.last_heartbeat)}</span>
        </div>
        <div className="bc-row">
          <span className="bc-label">Status</span>
          <span className="bc-colon">:</span>
          <span className="bc-value">
            <EdgeStatus status={edgeStatusNow(device)} />
          </span>
        </div>
      </div>

      <div className="actions">
        <button className="bc-btn bc-btn-view" disabled={busy} onClick={() => onManage(device.edge_device_id)}>
          <EditIcon />
          View &amp; Edit
        </button>
        <button className="bc-btn bc-btn-delete" disabled={busy} onClick={() => onDelete(device)}>
          <TrashIcon />
          Delete
        </button>
      </div>
    </div>
  )
}

export default function EdgeDevicePage({ onAdd, onManage }: Props) {
  const [devices, setDevices] = useState<EdgeDeviceRow[]>([])
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [branchFilter, setBranchFilter] = useState('') // '' = all branches
  const [statusFilter, setStatusFilter] = useState('') // '' = all statuses

  const [toDelete, setToDelete] = useState<EdgeDeviceRow | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Load edge boxes (with their branch) and the branch list once when the page opens
  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from(TABLES.edgeDevice).select(EDGE_COLUMNS).order('device_name', { ascending: true }),
      supabase.from(TABLES.branch).select('branch_id, branch_name').order('branch_name', { ascending: true }),
    ]).then(([ed, b]) => {
      if (cancelled) return
      const error = ed.error ?? b.error
      if (error) setLoadError(error.message)
      setDevices(ed.error ? [] : ((ed.data ?? []) as unknown as EdgeDeviceRow[]))
      setBranches(b.error ? [] : ((b.data ?? []) as BranchOption[]))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Hide the result message after a few seconds
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  // Live filtering: search looks through branch_name, device_name and status
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return devices.filter((d) => {
      if (branchFilter && d.branch_id !== branchFilter) return false
      if (statusFilter && edgeStatusNow(d) !== statusFilter) return false
      if (!q) return true
      return [d.branch?.branch_name ?? '', d.device_name, edgeStatusNow(d)].some((v) => v.toLowerCase().includes(q))
    })
  }, [devices, search, branchFilter, statusFilter])

  async function confirmDelete() {
    if (!toDelete) return
    const device = toDelete
    const fail = (reason: string) =>
      setNotice({ type: 'error', text: `Failed to delete the AI edge box ${device.device_name}: ${reason}` })

    setBusy(true)
    const { data, error } = await supabase
      .from(TABLES.edgeDevice)
      .delete()
      .eq('edge_device_id', device.edge_device_id)
      .select('edge_device_id')
    setBusy(false)
    setToDelete(null)

    if (error) {
      console.error('Delete AI edge box failed:', error)
      fail(error.code === '23503' ? 'cameras are still linked to this AI edge box' : error.message)
      return
    }
    // RLS can block silently: no error, but zero rows come back
    if (!data || data.length === 0) {
      fail('permission denied (check the delete policy on the edge_device table)')
      return
    }

    setDevices((prev) => prev.filter((d) => d.edge_device_id !== device.edge_device_id))
    setNotice({ type: 'success', text: `The AI edge box ${device.device_name} is deleted successfully` })
  }

  return (
    <>
      <h1>AI Edge Device</h1>
      <p className="ds-lead">Search, view and manage the AI edge boxes in your branches.</p>

      {notice && (
        <p className={`bp-notice bp-notice-${notice.type}`} role="status">
          {notice.type === 'success' ? <TickIcon /> : <CrossIcon />}
          <span>{notice.text}</span>
        </p>
      )}

      <div className="bp-toolbar ed-toolbar">
        <input
          type="search"
          className="bp-search"
          placeholder="Search AI edge box"
          aria-label="Search AI edge box"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="bp-select ed-branch"
          aria-label="Filter by branch"
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
        >
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.branch_id} value={b.branch_id}>
              {b.branch_name}
            </option>
          ))}
        </select>
        <select
          className="bp-select ed-statusfilter"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="Online">Online</option>
          <option value="Offline">Offline</option>
        </select>
        <button type="button" className="bp-add ed-add" onClick={onAdd}>
          + Add AI edge box
        </button>
      </div>

      {loading && <p className="ds-empty">Loading…</p>}
      {loadError && <p className="ds-error">Failed to load AI edge boxes: {loadError}</p>}
      {!loading && !loadError && devices.length === 0 && <p className="ds-empty">No AI edge boxes found.</p>}
      {!loading && devices.length > 0 && filtered.length === 0 && (
        <p className="ds-empty">No AI edge boxes match your search.</p>
      )}

      <div className="bp-grid">
        {filtered.map((d) => (
          <EdgeDeviceCard key={d.edge_device_id} device={d} busy={busy} onManage={onManage} onDelete={setToDelete} />
        ))}
      </div>

      {toDelete && (
        <div className="bp-overlay">
          <div className="bp-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ed-confirm-text">
            <p id="ed-confirm-text">Are you sure want to delete the AI edge box {toDelete.device_name}?</p>
            <div className="actions">
              <button className="bc-btn bc-btn-danger" disabled={busy} onClick={confirmDelete}>
                Yes, delete
              </button>
              <button className="bc-btn" autoFocus disabled={busy} onClick={() => setToDelete(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
