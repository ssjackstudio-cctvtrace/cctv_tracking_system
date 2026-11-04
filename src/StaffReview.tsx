import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { Badge } from './Datatable'
import { TABLES } from './Usetable'
import { dayRange, dayWords } from './suspectDay'

// Camera page → Suspicious same person.
//   Staff tab → "Recognised as staff today": EVERY visit the edge box (or an admin) made a
//   Staff today, not only the ones in a suspicious pair, newest first, with its photo, how it
//   was recognised (Body / Staff zone / Admin) and how sure. For each:
//     Correct          it is that staff (stamps visit.type_confirmed_at: reviewed)
//     Change staff     it is ANOTHER staff: pick the name (staff_no – full_name)
//     Leave as Guest   it is a customer: the visit becomes a Guest with a track_id of its
//                      own again (the one the edge box first gave it, or a new one), so its
//                      cctv_event rows count for that guest; its wrong recognition_event rows
//                      are deleted (supabase/staff_review_guest.sql). It moves to the Guest
//                      tab; the edge box stops treating that person as a staff within a
//                      minute and never makes them a staff again today.
//     A staff without a name (recognised by the Staff zone only): Give staff name.
//   Guest tab → "Changed from Staff to Guest today": the visits an admin made Guests, with
//   Is Staff to undo a mistake.
// All decisions go through public.set_first_track_type (supabase/staff_review.sql).

type StaffOption = { staff_id: string; staff_no: string; full_name: string }

type StaffVisit = {
  visit_id: string
  track_id: string
  edge_track_id: string | null
  est_gender: string
  est_age: number | null
  photo_url: string | null
  type_confirmed_at: string | null
  staff_id: string | null
  staff: { staff_no: string; full_name: string } | null
  recognition_event: { method: string | null; match_score: number; result: string; event_time: string }[]
  cctv_event: { event_time: string; camera: { camera_name: string } | null }[]
}

const REFRESH_MS = 30_000
const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '—'

const COLUMNS =
  'visit_id, track_id, edge_track_id, est_gender, est_age, photo_url, type_confirmed_at, staff_id, staff(staff_no, full_name), ' +
  'recognition_event(method, match_score, result, event_time), cctv_event!inner(event_time, camera(camera_name))'

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

export default function StaffReview({
  branchId,
  staffList,
  mode,
  day,
  reload,
  onChanged,
}: {
  branchId: string
  staffList: StaffOption[]
  mode: 'staff' | 'undone' // Staff tab: today's staff visits; Guest tab: staff visits an admin made Guests
  day: string // YYYY-MM-DD: the date chosen in the Date filter above the tabs
  reload: number // bumped by the panel after a decision elsewhere: reload now
  onChanged: () => void // reload the suspicious pairs too (the visit may have moved tab)
}) {
  const [visits, setVisits] = useState<StaffVisit[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [picking, setPicking] = useState<{ visit: string; staffId: string } | null>(null)
  const [show, setShow] = useState<'check' | 'all'>('check')

  const load = useCallback(async () => {
    const [start, end] = dayRange(day)
    let q = supabase
      .from(TABLES.visit)
      .select(COLUMNS)
      .eq('branch_id', branchId)
      .gte('cctv_event.event_time', start)
      .lt('cctv_event.event_time', end)
      .order('event_time', { referencedTable: 'cctv_event', ascending: true })
      .limit(1, { referencedTable: 'cctv_event' })
      .order('event_time', { referencedTable: 'recognition_event', ascending: false })
      .limit(1, { referencedTable: 'recognition_event' })
      .limit(500)
    q =
      mode === 'staff'
        ? q.eq('visit_type', 'Staff')
        : q.eq('visit_type', 'Guest').not('edge_track_id', 'is', null).gte('type_confirmed_at', start).lt('type_confirmed_at', end)
    const { data, error } = await q
    if (error) setError(error.message)
    else {
      setError('')
      const list = (data ?? []) as unknown as StaffVisit[]
      // newest recognition first
      list.sort((a, b) =>
        (b.recognition_event[0]?.event_time ?? b.cctv_event[0]?.event_time ?? '').localeCompare(
          a.recognition_event[0]?.event_time ?? a.cctv_event[0]?.event_time ?? '',
        ),
      )
      setVisits(list)
    }
    setLoaded(true)
  }, [branchId, mode, day])

  useEffect(() => {
    setLoaded(false)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // a decision in Track Staff (or the pairs) may have changed these visits too
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (reload) loadRef.current()
  }, [reload])

  const when = dayWords(day)

  const decide = async (v: StaffVisit, type: 'Guest' | 'Staff', staffId?: string | null) => {
    if (type === 'Staff' && !staffId) {
      setMessage('Choose the staff first.')
      return
    }
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
          ? `${v.track_id} is not a staff: it is Guest ${data as string} now (Guest tab); its staff recognition records are deleted. The edge box stops treating this person as a staff within a minute.`
          : `${v.edge_track_id ?? v.track_id} is staff ${st ? `${st.staff_no} – ${st.full_name}` : (data as string)}.`,
      )
      setPicking(null)
    }
    setBusy(false)
    load()
    onChanged()
  }

  const pick = (v: StaffVisit, label: string) =>
    picking?.visit === v.visit_id && (
      <span className="sp-staff-pick">
        <select
          aria-label={`Staff for ${v.track_id}`}
          value={picking.staffId}
          onChange={(e) => setPicking({ visit: v.visit_id, staffId: e.target.value })}
        >
          <option value="">{staffList.length ? 'Choose the staff…' : 'No staff in this branch'}</option>
          {staffList.map((st) => (
            <option key={st.staff_id} value={st.staff_id}>
              {st.staff_no} – {st.full_name}
            </option>
          ))}
        </select>
        <button type="button" className="cam-add" disabled={busy || !picking.staffId} onClick={() => decide(v, 'Staff', picking.staffId)}>
          {label}
        </button>
        <button type="button" className="cam-toggle" disabled={busy} onClick={() => setPicking(null)}>
          Cancel
        </button>
      </span>
    )

  const shown = mode === 'staff' && show === 'check' ? visits.filter((v) => !v.type_confirmed_at) : visits
  const toCheck = visits.filter((v) => !v.type_confirmed_at).length

  return (
    <div className="sr">
      <div className="sr-head">
        <h3>{mode === 'staff' ? `Recognised as staff ${when}` : `Changed from Staff to Guest ${when}`}</h3>
        {mode === 'staff' && (
          <label className="cam-filter">
            Show
            <select value={show} onChange={(e) => setShow(e.target.value as 'check' | 'all')}>
              <option value="check">To check ({toCheck})</option>
              <option value="all">All ({visits.length})</option>
            </select>
          </label>
        )}
      </div>
      <p className="cam-count-note">
        {mode === 'staff' ? (
          <>
            Every visit recognised as a staff {when}, newest first: check each one by its photo. <b>Correct</b> if it
            is that staff, <b>Change staff</b> if it is another staff, <b>Leave as Guest</b> if it is a customer (it
            gets a track_id of its own, its events count as a guest, its wrong recognition records are deleted, it
            moves to the Guest tab, and the edge box never makes this person a staff again today).
          </>
        ) : (
          <>Visits an admin changed from Staff to Guest {when}. <b>Is Staff</b> undoes a mistake.</>
        )}
      </p>
      {message && <p className="cam-count-note">{message}</p>}
      {!loaded ? (
        <p className="ds-empty">Loading…</p>
      ) : error ? (
        <p className="ds-error">
          Failed to load: {error}
          {/edge_track_id|method/.test(error) && ' (run supabase/staff_review.sql and plan_areas.sql)'}
        </p>
      ) : shown.length === 0 ? (
        <p className="ds-empty">
          {mode === 'staff'
            ? show === 'check'
              ? `Nothing to check: every staff visit ${when} is checked.`
              : `No staff visits ${when}.`
            : `None ${when}.`}
        </p>
      ) : (
        <ul className="sp-dups sr-list">
          {shown.map((v) => {
            const rec = v.recognition_event[0]
            const first = v.cctv_event[0]
            return (
              <li key={v.visit_id} className="sp-dup sr-item">
                <Photo url={v.photo_url} label={v.track_id} />
                <div className="sp-info">
                  <strong className="sp-track">{v.track_id}</strong>
                  <span>
                    {v.staff ? `${v.staff.staff_no} – ${v.staff.full_name}` : mode === 'staff' ? 'Staff without a name' : 'Guest'}
                    {v.edge_track_id && v.edge_track_id !== v.track_id && <span className="sp-muted"> · was {v.edge_track_id}</span>}
                  </span>
                  <span>
                    {first?.camera?.camera_name ?? '—'} · first seen {fmtTime(first?.event_time)}
                  </span>
                  <span className="sp-muted">
                    {v.est_gender}
                    {v.est_age ? ` · ${v.est_age}` : ''}
                  </span>
                  <span className="sp-why">
                    {rec ? (
                      <>
                        <Badge text={rec.method ?? 'Body'} /> {rec.result} · {Number(rec.match_score).toFixed(0)}% · {fmtTime(rec.event_time)}
                      </>
                    ) : (
                      <Badge text="Admin" />
                    )}
                    {v.type_confirmed_at && <span className="sp-decided"> · Checked {fmtTime(v.type_confirmed_at)}</span>}
                  </span>
                  <span className="sp-actions">
                    {mode === 'staff' ? (
                      <>
                        {v.staff_id && (
                          <button type="button" className="cam-add" disabled={busy} onClick={() => decide(v, 'Staff', v.staff_id)}>
                            Correct
                          </button>
                        )}
                        <button
                          type="button"
                          className="cam-toggle"
                          disabled={busy}
                          onClick={() => setPicking(picking?.visit === v.visit_id ? null : { visit: v.visit_id, staffId: '' })}
                        >
                          {v.staff_id ? 'Change staff' : 'Give staff name'}
                        </button>
                        <button type="button" className="cam-toggle" disabled={busy} onClick={() => decide(v, 'Guest')}>
                          Leave as Guest
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="cam-toggle"
                        disabled={busy}
                        onClick={() => setPicking(picking?.visit === v.visit_id ? null : { visit: v.visit_id, staffId: '' })}
                      >
                        Is Staff
                      </button>
                    )}
                  </span>
                  {pick(v, 'Save as staff')}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
