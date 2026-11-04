import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { Badge } from './Datatable'
import { TABLES } from './Usetable'
import { dayRange, dayWords } from './suspectDay'

// Camera page → Suspicious same person → Staff tab → "Track Staff Today"
// (below "Recognised as staff today", StaffReview.tsx).
//   ONE ROW PER CAMERA CAPTURE (cctv_event) of a person tracked with a staff's staff_no
//   as track_id (visit_type 'Staff') on the selected date, newest first. The edge box may
//   have mistracked a customer as that staff (e.g. a customer joined the staff's track_id),
//   so every capture is listed for a manual check, also when the visit was checked
//   before: a capture recorded AFTER the visit was checked is "To check" again.
//     Correct          it is that staff (stamps visit.type_confirmed_at: checked)
//     Change staff     it is ANOTHER staff: pick the name (staff_no – full_name)
//     Change to Guest  it is a customer: the visit becomes a Guest with a track_id of its own
//                      (supabase/staff_review_guest.sql); its captures count for that guest
// A decision is for the whole VISIT the capture belongs to (all of its captures), through
// public.set_first_track_type, the same as "Recognised as staff today".

type StaffOption = { staff_id: string; staff_no: string; full_name: string }

type StaffCapture = {
  cctv_event_id: string
  event_time: string
  direction: string
  track_region: string
  confidence: number | null
  camera: { camera_name: string } | null
  visit: {
    visit_id: string
    track_id: string
    edge_track_id: string | null
    visit_type: string
    est_gender: string
    est_age: number | null
    photo_url: string | null
    type_confirmed_at: string | null
    staff_id: string | null
    staff: { staff_no: string; full_name: string } | null
  }
}

const REFRESH_MS = 30_000
const MAX_ROWS = 1000 // captures read at most for one day
const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '—'

const COLUMNS =
  'cctv_event_id, event_time, direction, track_region, confidence, camera(camera_name), ' +
  'visit!inner(visit_id, track_id, edge_track_id, visit_type, est_gender, est_age, photo_url, type_confirmed_at, staff_id, staff(staff_no, full_name))'

// checked when an admin decided the visit after this capture was recorded
const checked = (c: StaffCapture) =>
  Boolean(c.visit.type_confirmed_at && new Date(c.visit.type_confirmed_at).getTime() >= new Date(c.event_time).getTime())

function Photo({ url, label }: { url: string | null; label: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  if (!url || broken) return <div className="sp-photo sp-photo--none">No photo</div>
  return (
    <a className="sp-photo" href={url} target="_blank" rel="noreferrer" title={`Open the photo of ${label}`}>
      <img src={url} alt={`Photo of ${label}`} loading="lazy" onError={() => setBroken(true)} />
    </a>
  )
}

export default function StaffTrack({
  branchId,
  staffList,
  day,
  reload,
  onChanged,
}: {
  branchId: string
  staffList: StaffOption[]
  day: string // YYYY-MM-DD: the date chosen in the Date filter above the tabs
  reload: number // bumped by the panel after a decision elsewhere: reload now
  onChanged: () => void // reload the suspicious pairs and "Recognised as staff" too
}) {
  const [captures, setCaptures] = useState<StaffCapture[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [picking, setPicking] = useState<{ event: string; staffId: string } | null>(null)
  const [show, setShow] = useState<'check' | 'all'>('check')

  // select e.*, c.camera_name, v.* from cctv_event e join visit v on v.visit_id = e.visit_id
  // left join camera c on c.camera_id = e.camera_id
  // where v.branch_id = <branch> and v.visit_type = 'Staff' and e.event_time on the selected date
  const load = useCallback(async () => {
    const [start, end] = dayRange(day)
    const { data, error } = await supabase
      .from(TABLES.cctvEvent)
      .select(COLUMNS)
      .eq('visit.branch_id', branchId)
      .eq('visit.visit_type', 'Staff')
      .gte('event_time', start)
      .lt('event_time', end)
      .order('event_time', { ascending: false })
      .limit(MAX_ROWS)
    if (error) setError(error.message)
    else {
      setError('')
      setCaptures((data ?? []) as unknown as StaffCapture[])
    }
    setLoaded(true)
  }, [branchId, day])

  useEffect(() => {
    setLoaded(false)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // a decision in "Recognised as staff" (or the pairs) may have changed these visits too
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (reload) loadRef.current()
  }, [reload])

  const when = dayWords(day)
  const capturesOf = (visitId: string) => captures.filter((c) => c.visit.visit_id === visitId).length

  const decide = async (c: StaffCapture, type: 'Guest' | 'Staff', staffId?: string | null) => {
    const v = c.visit
    if (type === 'Staff' && !staffId) {
      setMessage('Choose the staff first.')
      return
    }
    // the decision is for the whole visit: say so when it has other captures too
    const n = capturesOf(v.visit_id)
    if (
      type === 'Guest' &&
      n > 1 &&
      !window.confirm(`${v.track_id}: this visit has ${n} captures ${when}. Change all ${n} to a Guest?`)
    )
      return
    setBusy(true)
    setMessage('')
    const { data, error } = await supabase.rpc('set_first_track_type', {
      p_visits: [v.visit_id],
      p_type: type,
      p_staff: type === 'Staff' ? staffId : null,
    })
    if (error) setMessage(`Could not save: ${error.message}`)
    else {
      const st = staffList.find((s) => s.staff_id === staffId)
      setMessage(
        type === 'Guest'
          ? `${v.track_id} (${c.camera?.camera_name ?? 'camera'} ${fmtTime(c.event_time)}) is not a staff: it is Guest ${data as string} now (Guest tab); its staff recognition records are deleted.`
          : `${v.edge_track_id ?? v.track_id} (${c.camera?.camera_name ?? 'camera'} ${fmtTime(c.event_time)}) is staff ${st ? `${st.staff_no} – ${st.full_name}` : (data as string)}.`,
      )
      setPicking(null)
    }
    setBusy(false)
    load()
    onChanged()
  }

  const shown = show === 'check' ? captures.filter((c) => !checked(c)) : captures
  const toCheck = captures.filter((c) => !checked(c)).length

  return (
    <div className="sr">
      <div className="sr-head">
        <h3>Track Staff {when === 'today' ? 'Today' : when}</h3>
        <label className="cam-filter">
          Show
          <select value={show} onChange={(e) => setShow(e.target.value as 'check' | 'all')}>
            <option value="check">To check ({toCheck})</option>
            <option value="all">All ({captures.length})</option>
          </select>
        </label>
      </div>
      <p className="cam-count-note">
        Every time a camera captured a person tracked as a staff (track_id = staff no.) {when}, newest first: the
        edge box may have mistracked a customer as the staff, so check each capture by its photo. <b>Correct</b> if
        it is that staff, <b>Change staff</b> if it is another staff, <b>Change to Guest</b> if it is a customer. A
        decision is for the whole visit of that capture; a capture recorded after the visit was checked is to check
        again.
      </p>
      {message && <p className="cam-count-note">{message}</p>}
      {!loaded ? (
        <p className="ds-empty">Loading…</p>
      ) : error ? (
        <p className="ds-error">Failed to load: {error}</p>
      ) : shown.length === 0 ? (
        <p className="ds-empty">
          {show === 'check' ? `Nothing to check: every staff capture ${when} is checked.` : `No staff captures ${when}.`}
        </p>
      ) : (
        <ul className="sp-dups sr-list">
          {shown.map((c) => {
            const v = c.visit
            return (
              <li key={c.cctv_event_id} className="sp-dup sr-item">
                <Photo url={v.photo_url} label={v.track_id} />
                <div className="sp-info">
                  <strong className="sp-track">{v.track_id}</strong>
                  <span>
                    {v.staff ? `${v.staff.staff_no} – ${v.staff.full_name}` : 'Staff without a name'}
                    {v.edge_track_id && v.edge_track_id !== v.track_id && <span className="sp-muted"> · was {v.edge_track_id}</span>}
                  </span>
                  <span>
                    {c.camera?.camera_name ?? '—'} · captured {fmtTime(c.event_time)}
                  </span>
                  <span className="sp-muted">
                    {v.est_gender}
                    {v.est_age ? ` · ${v.est_age}` : ''}
                  </span>
                  <span className="sp-why">
                    <Badge text={c.direction} /> {c.track_region}
                    {c.confidence !== null && <> · {Number(c.confidence).toFixed(0)}%</>}
                    {checked(c) && <span className="sp-decided"> · Checked {fmtTime(v.type_confirmed_at)}</span>}
                  </span>
                  <span className="sp-actions">
                    {v.staff_id && (
                      <button type="button" className="cam-add" disabled={busy} onClick={() => decide(c, 'Staff', v.staff_id)}>
                        Correct
                      </button>
                    )}
                    <button
                      type="button"
                      className="cam-toggle"
                      disabled={busy}
                      onClick={() =>
                        setPicking(picking?.event === c.cctv_event_id ? null : { event: c.cctv_event_id, staffId: '' })
                      }
                    >
                      {v.staff_id ? 'Change staff' : 'Give staff name'}
                    </button>
                    <button type="button" className="cam-toggle" disabled={busy} onClick={() => decide(c, 'Guest')}>
                      Change to Guest
                    </button>
                  </span>
                  {picking?.event === c.cctv_event_id && (
                    <span className="sp-staff-pick">
                      <select
                        aria-label={`Staff for ${v.track_id}`}
                        value={picking.staffId}
                        onChange={(e) => setPicking({ event: c.cctv_event_id, staffId: e.target.value })}
                      >
                        <option value="">{staffList.length ? 'Choose the staff…' : 'No staff in this branch'}</option>
                        {staffList.map((st) => (
                          <option key={st.staff_id} value={st.staff_id}>
                            {st.staff_no} – {st.full_name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="cam-add"
                        disabled={busy || !picking.staffId}
                        onClick={() => decide(c, 'Staff', picking.staffId)}
                      >
                        Save as staff
                      </button>
                      <button type="button" className="cam-toggle" disabled={busy} onClick={() => setPicking(null)}>
                        Cancel
                      </button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
