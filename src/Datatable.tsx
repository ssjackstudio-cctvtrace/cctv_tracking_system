import type { ReactNode } from 'react'
import './Tables.css'

export type Column<T> = { header: string; render: (row: T) => ReactNode }

type Props<T> = {
  columns: Column<T>[]
  rows: T[]
  loading: boolean
  error: string
  emptyMessage: string
  rowKey: (row: T) => string
}

export function Badge({ text }: { text: string }) {
  return <span className={`badge badge-${text.toLowerCase().replace(/\s+/g, '-')}`}>{text}</span>
}

export default function DataTable<T>({ columns, rows, loading, error, emptyMessage, rowKey }: Props<T>) {
  if (loading) return <p className="ds-empty">Loading…</p>
  if (error) return <p className="ds-error">Failed to load: {error}</p>
  if (rows.length === 0) return <p className="ds-empty">{emptyMessage}</p>

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.header}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}