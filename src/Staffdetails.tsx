import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Branch, Staff, StaffEditable } from './types'
import { STAFF_COLUMNS, type StaffRow } from './Staffpage'
import { BackButton, GENDERS, StatusBadge } from './Peoplecards'
import './Members.css'

type BranchOption = Pick<Branch, 'branch_id' | 'branch_name'>
type Notice = { type: 'success' | 'error'; text: string }
const STATUSES: Staff['status'][] = ['Active', 'Inactive', 'Resigned']

// Every field as the form edits it (text; '' = empty)
type Form = {
  staff_no: string
  full_name: string
  branch_id: string
  position: string
  phone_number: string
  email: string
  gender: string
  dob: string // YYYY-MM-DD
  consent_pdpa: string // 'Yes' | 'No' | ''
  status: string
  designed_at: string // YYYY-MM-DDTHH:mm (local time)
  resigned_at: string
}

// Add Staff: every field empty
const EMPTY: Form = {
  staff_no: '',
  full_name: '',
  branch_id: '',
  position: '',
  phone_number: '',
  email: '',
  gender: '',
  dob: '',
  consent_pdpa: '',
  status: '',
  designed_at: '',
  resigned_at: '',
}

const pad = (n: number) => String(n).padStart(2, '0')
// timestamptz → value of a datetime-local input (local time)
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// datetime-local value → ISO (null when empty)
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)

// View & Edit: the saved values of this staff
const fromRow = (s: StaffRow): Form => ({
  staff_no: s.staff_no,
  full_name: s.full_name,
  branch_id: s.branch_id,
  position: s.position ?? '',
  phone_number: s.phone_number ?? '',
  email: s.email ?? '',
  gender: s.gender ?? '',
  dob: s.dob ?? '',
  consent_pdpa: s.consent_pdpa ? 'Yes' : 'No',
  status: s.status,
  designed_at: toLocalInput(s.designed_at),
  resigned_at: toLocalInput(s.resigned_at),
})

// Friendly text for the database's checks
function saveError(message: string, code?: string): string {
  if (code === '23505' && message.includes('staff_no')) return 'This staff no is already used. Enter another staff no.'
  if (message.includes('staff_resigned_status_check')) return 'A Resigned staff needs a Resigned at date.'
  if (message.includes('staff_resigned_at_check')) return 'Resigned at cannot be before Designed at.'
  return message
}

// Add Staff (staffId undefined): empty form. View & Edit (staffId): the staff's saved details, editable.
export default function StaffDetailsPage({
  staffId,
  onBack,
  onCreated,
}: {
  staffId?: string
  onBack: () => void
  onCreated?: (staffId: string) => void
}) {
  const isNew = !staffId
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [staff, setStaff] = useState<StaffRow | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [loading, setLoading] = useState(!isNew)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const set = (key: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  // Branch choices
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

  // select s.* , b.branch_name from staff s join branch b on s.branch_id = b.branch_id where s.staff_id = <id>
  useEffect(() => {
    if (!staffId) {
      setStaff(null)
      setForm(EMPTY)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    supabase
      .from(TABLES.staff)
      .select(STAFF_COLUMNS)
      .eq('staff_id', staffId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        else {
          const row = data as unknown as StaffRow | null
          setStaff(row)
          if (row) setForm(fromRow(row))
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [staffId])

  async function handleSave() {
    const fail = (text: string) => setNotice({ type: 'error', text })
    setNotice(null)
    const staff_no = form.staff_no.trim()
    const full_name = form.full_name.trim()
    const email = form.email.trim()
    if (!staff_no) return fail('Enter the staff no.')
    if (!full_name) return fail('Enter the staff name.')
    if (!form.branch_id) return fail('Choose the branch.')
    if (!form.status) return fail('Choose the status.')
    if (!form.consent_pdpa) return fail('Choose whether the staff gave PDPA consent.')
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email, or leave it empty.')
    if (form.dob && (form.dob < '1900-01-01' || form.dob > new Date().toISOString().slice(0, 10)))
      return fail('Enter a valid date of birth.')
    if (form.status === 'Resigned' && !form.resigned_at) return fail('A Resigned staff needs a Resigned at date.')
    if (form.designed_at && form.resigned_at && form.resigned_at < form.designed_at)
      return fail('Resigned at cannot be before Designed at.')

    const values: Partial<StaffEditable> = {
      staff_no,
      full_name,
      branch_id: form.branch_id,
      position: form.position.trim() || null,
      phone_number: form.phone_number.trim() || null,
      email: email || null,
      gender: (form.gender || null) as Staff['gender'],
      dob: form.dob || null,
      consent_pdpa: form.consent_pdpa === 'Yes',
      status: form.status as Staff['status'],
      resigned_at: fromLocalInput(form.resigned_at),
    }
    // Designed at left empty on a new staff: the database sets it to now
    const designed = fromLocalInput(form.designed_at)
    if (designed) values.designed_at = designed

    setSaving(true)
    if (isNew) {
      const { data, error } = await supabase.from(TABLES.staff).insert(values).select('staff_id').single()
      setSaving(false)
      if (error || !data) return fail(`Failed to add the staff ${staff_no}: ${saveError(error?.message ?? 'no row returned', error?.code)}`)
      setNotice({ type: 'success', text: `The staff ${staff_no} is added successfully` })
      onCreated?.((data as { staff_id: string }).staff_id)
      return
    }
    const { data, error } = await supabase
      .from(TABLES.staff)
      .update(values)
      .eq('staff_id', staffId)
      .select(STAFF_COLUMNS)
    setSaving(false)
    if (error) return fail(`Failed to update the staff ${staff_no}: ${saveError(error.message, error.code)}`)
    // RLS can block silently: no error, but zero rows come back
    if (!data || data.length === 0) return fail(`Failed to update the staff ${staff_no}: permission denied`)
    const row = data[0] as unknown as StaffRow
    setStaff(row)
    setForm(fromRow(row))
    setNotice({ type: 'success', text: `The staff ${staff_no} is updated successfully` })
  }

  return (
    <>
      <BackButton label="Back to Staff page" onClick={onBack} />
      <h1>{isNew ? 'Add Staff' : 'Staff Details'}</h1>
      <p className="ds-lead">
        {isNew ? 'Fill in the details of the new staff.' : 'View and edit the details of this staff.'}
      </p>

      {notice && (
        <p className={notice.type === 'success' ? 'sf-notice sf-notice--ok' : 'ds-error'} role="status">
          {notice.text}
        </p>
      )}
      {loading && <p className="ds-empty">Loading…</p>}
      {error && <p className="ds-error">Failed to load the staff: {error}</p>}
      {!isNew && !loading && !error && !staff && <p className="ds-empty">This staff was not found.</p>}

      {(isNew || staff) && !loading && (
        <>
          <section className="mc pd-card sf-form">
            {!isNew && staff && (
              <h2 className="mc-title sf-title">
                {staff.staff_no} <StatusBadge status={staff.status} />
              </h2>
            )}
            <div className="sf-grid">
              <label className="sf-field">
                <span>Staff No *</span>
                <input value={form.staff_no} onChange={set('staff_no')} placeholder="e.g. JS-0001" />
              </label>
              <label className="sf-field">
                <span>Staff Name *</span>
                <input value={form.full_name} onChange={set('full_name')} />
              </label>
              <label className="sf-field">
                <span>Branch *</span>
                <select value={form.branch_id} onChange={set('branch_id')}>
                  <option value="">Select branch</option>
                  {branches.map((b) => (
                    <option key={b.branch_id} value={b.branch_id}>
                      {b.branch_name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sf-field">
                <span>Position</span>
                <input value={form.position} onChange={set('position')} placeholder="e.g. Cashier" />
              </label>
              <label className="sf-field">
                <span>Phone number</span>
                <input type="tel" value={form.phone_number} onChange={set('phone_number')} />
              </label>
              <label className="sf-field">
                <span>Email</span>
                <input type="email" value={form.email} onChange={set('email')} />
              </label>
              <label className="sf-field">
                <span>Gender</span>
                <select value={form.gender} onChange={set('gender')}>
                  <option value="">Select gender</option>
                  {GENDERS.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sf-field">
                <span>Date of birth</span>
                <input type="date" value={form.dob} onChange={set('dob')} />
              </label>
              <label className="sf-field">
                <span>PDPA consent *</span>
                <select value={form.consent_pdpa} onChange={set('consent_pdpa')}>
                  <option value="">Select</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </label>
              <label className="sf-field">
                <span>Status *</span>
                <select value={form.status} onChange={set('status')}>
                  <option value="">Select status</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sf-field">
                <span>Designed at</span>
                <input type="datetime-local" value={form.designed_at} onChange={set('designed_at')} />
                {isNew && <small>Leave empty to use the time it is saved.</small>}
              </label>
              <label className="sf-field">
                <span>Resigned at</span>
                <input type="datetime-local" value={form.resigned_at} onChange={set('resigned_at')} />
                <small>Needed when the status is Resigned.</small>
              </label>
            </div>
          </section>

          <div className="sf-footer">
            <button type="button" className="mc-btn sf-save" disabled={saving} onClick={handleSave}>
              {saving ? 'Saving…' : isNew ? 'Save Staff' : 'Update Staff'}
            </button>
          </div>
        </>
      )}
    </>
  )
}
