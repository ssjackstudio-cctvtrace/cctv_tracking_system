import type { Branch } from './types'

type Props = {
  branch: Branch
  busy: boolean
  onManage: (branchId: string) => void
  onDelete: (branch: Branch) => void
}

// DD Month YYYY, e.g. 05 March 2026
const formatDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—'

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

export default function BranchCard({ branch, busy, onManage, onDelete }: Props) {
  const rows: { label: string; value: string }[] = [
    { label: 'Address', value: branch.formatted_address },
    { label: 'Created', value: formatDate(branch.created_at) },
  ]

  return (
    <div className="card bc">
      <h2 className="bc-title">{branch.branch_name}</h2>

      <div className="bc-details">
        {rows.map((r) => (
          <div className="bc-row" key={r.label}>
            <span className="bc-label">{r.label}</span>
            <span className="bc-colon">:</span>
            <span className="bc-value">{r.value}</span>
          </div>
        ))}
      </div>

      <div className="actions">
        <button className="bc-btn bc-btn-view" disabled={busy} onClick={() => onManage(branch.branch_id)}>
          <EditIcon />
          View &amp; Edit
        </button>
        <button className="bc-btn bc-btn-delete" disabled={busy} onClick={() => onDelete(branch)}>
          <TrashIcon />
          Delete
        </button>
      </div>
    </div>
  )
}