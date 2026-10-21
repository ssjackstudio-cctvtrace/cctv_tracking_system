// Shared by the Member and Staff pages: label : value rows, back button, dates
import type { ReactNode } from 'react'
import { Badge } from './Datatable'

export const GENDERS = ['Male', 'Female'] as const

// DD Month YYYY, e.g. 05 March 2026
export const fmtLongDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '-'

// DD Month YYYY hh:mm AM/PM, e.g. 05 March 2026 03:45 PM
export const fmtLongDateTime = (iso: string | null | undefined) => {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${fmtLongDate(iso)} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`
}

// Date of birth (a DATE, "YYYY-MM-DD") as DD Month YYYY, read as a local day
export const fmtDob = (dob: string | null | undefined) => (dob ? fmtLongDate(`${dob}T00:00:00`) : '-')

// Empty text → "-"
export const orDash = (v: string | null | undefined) => (v && v.trim() ? v : '-')

// Status badge: colour changes with the value (Active / Inactive / Terminated / Resigned)
export const StatusBadge = ({ status }: { status: string }) => <Badge text={status} />

export type DetailRow = { label: string; value: ReactNode }

// label : value, one row each
export function DetailList({ rows }: { rows: DetailRow[] }) {
  return (
    <div className="mc-details">
      {rows.map((r) => (
        <div className="mc-row" key={r.label}>
          <span className="mc-label">{r.label}</span>
          <span className="mc-colon">:</span>
          <span className="mc-value">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

// "← Back to …" at the top left of a details page
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="pd-back" onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 12H5M11 18l-6-6 6-6" />
      </svg>
      {label}
    </button>
  )
}
