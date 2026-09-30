import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import type { Branch } from './types'
import BranchCard from './BranchCard'
import './Branches.css'

const COLUMNS =
  'branch_id, branch_name, house_unit, street, township, formatted_address, postal_code, city, state, country, google_place_id, latitude, longitude, created_at'

// Fields the search box looks through
const SEARCH_FIELDS = [
  'branch_name',
  'formatted_address',
  'house_unit',
  'street',
  'township',
  'postal_code',
  'city',
  'state',
  'country',
] as const

type Props = {
  onAdd: () => void
  onManage: (branchId: string) => void
}

type Notice = { type: 'success' | 'error'; text: string }

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m7.5 12.5 3 3 6-7" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" />
    </svg>
  )
}

export default function BranchesPage({ onAdd, onManage }: Props) {
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState('') // '' = all states

  const [toDelete, setToDelete] = useState<Branch | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Load branches once when the page opens
  useEffect(() => {
    supabase
      .from('branch')
      .select(COLUMNS)
      .order('branch_name', { ascending: true })
      .then(({ data, error }) => {
        if (error) setLoadError(error.message)
        else setBranches(data as Branch[])
        setLoading(false)
      })
  }, [])

  // Hide the result message after a few seconds
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  // Distinct states found in the branch table
  const states = useMemo(
    () =>
      Array.from(new Set(branches.map((b) => b.state).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [branches],
  )

  // Live filtering: runs on every keystroke / state change
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return branches.filter((b) => {
      if (stateFilter && b.state !== stateFilter) return false
      if (!q) return true
      return SEARCH_FIELDS.some((f) => (b[f] ?? '').toLowerCase().includes(q))
    })
  }, [branches, search, stateFilter])

  async function confirmDelete() {
    if (!toDelete) return
    const branch = toDelete

    const fail = (reason: string) =>
      setNotice({ type: 'error', text: `Failed to delete the branch ${branch.branch_name}: ${reason}` })

    setBusy(true)


    const { data, error } = await supabase
      .from('branch')
      .delete()
      .eq('branch_id', branch.branch_id)
      .select('branch_id')
    setBusy(false)
    setToDelete(null)

    if (error) {
      console.error('Delete branch failed:', error)
      fail(error.message)
      return
    }
    // RLS can block silently: no error, but zero rows come back
    if (!data || data.length === 0) {
      fail('permission denied (check the delete policy on the branch table)')
      return
    }

    const remaining = branches.filter((b) => b.branch_id !== branch.branch_id)
    setBranches(remaining)
    // if the selected state no longer exists, go back to "All states"
    setStateFilter((prev) => (prev && !remaining.some((b) => b.state === prev) ? '' : prev))
    setNotice({ type: 'success', text: `The branch ${branch.branch_name} is deleted successfully` })
  }

  return (
    <>
      <h1>Branch</h1>
      <p className="ds-lead">Search, view and manage your branches.</p>

      {notice && (
        <p className={`bp-notice bp-notice-${notice.type}`} role="status">
          {notice.type === 'success' ? <TickIcon /> : <CrossIcon />}
          <span>{notice.text}</span>
        </p>
      )}

      <div className="bp-toolbar">
        <input
          type="search"
          className="bp-search"
          placeholder="Search branch"
          aria-label="Search branch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="bp-select"
          aria-label="Filter by state"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" className="bp-add" onClick={onAdd}>
          + Add branch
        </button>
      </div>

      {loading && <p className="ds-empty">Loading…</p>}
      {loadError && <p className="ds-error">Failed to load branches: {loadError}</p>}
      {!loading && !loadError && branches.length === 0 && <p className="ds-empty">No branches found.</p>}
      {!loading && branches.length > 0 && filtered.length === 0 && (
        <p className="ds-empty">No branches match your search.</p>
      )}

      <div className="bp-grid">
        {filtered.map((b) => (
          <BranchCard
            key={b.branch_id}
            branch={b}
            busy={busy}
            onManage={onManage}
            onDelete={setToDelete}
          />
        ))}
      </div>

      {toDelete && (
        <div className="bp-overlay">
          <div className="bp-dialog" role="alertdialog" aria-modal="true" aria-labelledby="bp-confirm-text">
            <p id="bp-confirm-text">Are you sure want to delete the branch {toDelete.branch_name}?</p>
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