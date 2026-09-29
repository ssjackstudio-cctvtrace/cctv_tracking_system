import { useState } from 'react'
import type { Branch, BranchEditable } from './types'

type Props = {
  branch: Branch
  isAdmin: boolean
  busy: boolean
  onSave: (branchId: string, changes: BranchEditable) => Promise<boolean>
  onDelete: (branch: Branch) => Promise<void>
}

// optional = column may be empty (saved as null)
const FIELDS: { key: keyof BranchEditable; label: string; optional?: boolean }[] = [
  { key: 'branch_name', label: 'Branch name' },
  { key: 'house_unit', label: 'House / unit', optional: true },
  { key: 'street', label: 'Street', optional: true },
  { key: 'township', label: 'Township', optional: true },
  { key: 'formatted_address', label: 'Full address' },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country', optional: true },
]

function toForm(b: Branch): BranchEditable {
  return {
    branch_name: b.branch_name,
    house_unit: b.house_unit,
    street: b.street,
    township: b.township,
    formatted_address: b.formatted_address,
    postal_code: b.postal_code,
    city: b.city,
    state: b.state,
    country: b.country,
  }
}

// Trim text, and turn empty optional fields into null
function cleanForm(form: BranchEditable): BranchEditable {
  const cleaned = { ...form }
  for (const { key, optional } of FIELDS) {
    const value = (form[key] ?? '').trim()
    ;(cleaned as Record<string, string | null>)[key] = optional && value === '' ? null : value
  }
  return cleaned
}

export default function BranchCard({ branch, isAdmin, busy, onSave, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<BranchEditable>(toForm(branch))

  function startEdit() {
    setForm(toForm(branch)) // start from the latest saved values
    setEditing(true)
  }

  async function handleSave() {
    const ok = await onSave(branch.branch_id, cleanForm(form))
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <div className="card">
        {FIELDS.map(({ key, label, optional }) => (
          <label key={key} className="field">
            {label}
            {optional ? ' (optional)' : ''}
            <input
              value={form[key] ?? ''}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
        <div className="actions">
          <button disabled={busy} onClick={handleSave}>
            Save
          </button>
          <button disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${branch.latitude},${branch.longitude}`

  return (
    <div className="card">
      <h2>{branch.branch_name}</h2>
      <p>{branch.formatted_address}</p>
      <p>
        {branch.city}, {branch.state} {branch.postal_code}
      </p>
      {branch.country && <p>{branch.country}</p>}
      <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
        View on Google Maps →
      </a>

      {isAdmin && (
        <div className="actions">
          <button disabled={busy} onClick={startEdit}>
            Edit
          </button>
          <button disabled={busy} className="danger" onClick={() => onDelete(branch)}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}