import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { Badge } from './Datatable'
import { TABLES } from './Usetable'
import './Suspects.css'

// Suspicious same person (Camera page, below the cameras).
// The edge box reports pairs of track_ids that look like ONE person (face,
// whole body, clothes; also with the legs hidden): seen by two cameras, or
// re-tracked with a new number on the same camera (supabase/suspect_match.sql).
//
// Shown as ONE CARD PER FIRST track_id, earliest first: the first track_id's
// photo on top, every later track_id that may be the same person below it with
// its own photo (supabase/person_photos.sql + the edge box's PhotoUploader).
//   Merge     the later track_id becomes the first one (counted once).
//   Not same  the later track_id is another person: it leaves this card and is
//             its own first track_id from now on (the edge box never pairs these
//             two again; later lookalikes of it get their own card).
//
// Three tabs: Staff (one of the two visits is a staff), Member (a member), else Guest.
//   Guest   a first track_id only collects later track_ids first seen within
//           10 minutes of it (GUEST_WINDOW_MS); a later one is a new first
//           track_id of its own. The edge box also never pairs two people whose
//           top or pants are clearly another colour (another attire style).
//   Staff   a visit the edge box recognised as a staff (by body, any angle) has the
//           staff's staff_no as its track_id, shown as the FIRST track_id of the card.
//           Pairs at least 70% alike are merged at once by the database (Merged);
//           lower ones wait here: Merge gives the other visit the staff_no
//           (supabase/body_view_angle_staff_track.sql).
//   Member  a visit recognised as a member.
//
// First track_id first: in every tab an admin decides what the FIRST track_id is
// before its later track_ids can be merged / marked Not same:
//   Leave as Guest  → visit_type Guest; the card moves to the Guest tab
//   Is Staff        → pick a staff of the selected branch (staff_no – full_name); the
//                     first track_id becomes that staff (track_id = staff_no) and the
//                     card moves to the Staff tab
// Saved by public.set_first_track_type (supabase/suspect_first_track_type.sql), which
// stamps visit.type_confirmed_at. A decided Guest card shows all its later track_ids
// (the 10-minute Guest window only applies to undecided cards).
//
// Staff tab: every staff of the branch is listed first, as a first track_id (staff_no),
// with an "On duty today" tick (table staff_duty, supabase/staff_duty.sql): the edge box
// then only recognises the staff on duty today. A later track_id in ANY tab has "Is Staff"
// too: pick the staff and that track_id (with the visits merged into it) becomes the
// staff's track_id (staff_no), i.e. it joins that staff's first track_id.

const SUSPECT_TABLE = 'suspect_match'
const REFRESH_MS = 30_000
const SURE_SCORE = 90 // "Merge all sure": only pairs at least this alike
const PAGE = 1000 // Supabase's most rows per request
const MAX_ROWS = 10_000 // today's pairs read at most
type Status = 'Open' | 'Merged' | 'Not same'
type VisitTab = 'Guest' | 'Staff' | 'Member'
const VISIT_TABS: VisitTab[] = ['Guest', 'Staff', 'Member']
const GUEST_WINDOW_MS = 10 * 60_000 // Guest: later track_ids within 10 minutes of the first one

type VisitInfo = {
  track_id: string
  branch_id: string
  visit_type: string
  est_gender: string
  est_age: number | null
  photo_url: string | null
  type_confirmed_at: string | null // when an admin decided Guest / Staff (null = not yet)
  staff?: { staff_no: string; full_name: string } | null
} | null

type StaffOption = { staff_id: string; staff_no: string; full_name: string }

type SuspectRow = {
  suspect_match_id: string
  visit_keep: string
  visit_dup: string
  track_keep: string
  track_dup: string
  kind: string
  score: number
  floor_apart: number | null
  reason: string | null
  seen_keep: string | null
  seen_dup: string | null
  status: Status
  keep: VisitInfo
  dup: VisitInfo
  cam_keep: { camera_name: string } | null
  cam_dup: { camera_name: string } | null
  keep_visit?: string // visit_id of the visit shown as the first track_id (visit_dup when shown swapped)
  dup_visit?: string // visit_id of the visit shown as the later track_id (visit_keep when shown swapped)
}

type Group = {
  track: string // first track_id (as it is now: it may itself have been merged into an earlier one)
  camera: string
  seen: string | null
  keep: VisitInfo
  keepVisits: string[] // visit_id(s) shown as this first track_id
  rows: SuspectRow[] // later track_ids, earliest first
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` // Malaysia date (staff_duty.duty_date)
}
const todayStart = () => {
  const d = new Date()
  return new Date(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`).toISOString()
}
const rowTab = (r: SuspectRow): VisitTab =>
  r.keep?.visit_type === 'Staff' || r.dup?.visit_type === 'Staff'
    ? 'Staff'
    : r.keep?.visit_type === 'Member' || r.dup?.visit_type === 'Member'
      ? 'Member'
      : 'Guest'
// The pair shown the other way round (display only: Merge still uses suspect_match_id)
const swapped = (r: SuspectRow): SuspectRow => ({
  ...r,
  keep: r.dup,
  dup: r.keep,
  track_keep: r.track_dup,
  track_dup: r.track_keep,
  seen_keep: r.seen_dup,
  seen_dup: r.seen_keep,
  cam_keep: r.cam_dup,
  cam_dup: r.cam_keep,
  keep_visit: r.visit_dup,
  dup_visit: r.visit_keep,
})
const person = (v: VisitInfo) =>
  v ? `${v.visit_type} · ${v.est_gender}${v.est_age ? ` · ${v.est_age}` : ''}` : '—'

// Photo of a track_id; opens full size in a new tab. "No photo" until the edge box sends one
// (or after the photos are deleted: 7 days).
function Photo({ url, label }: { url: string | null | undefined; label: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  if (!url || broken) return <div className="sp-photo sp-photo--none">No photo</div>
  return (
    <a className="sp-photo" href={url} target="_blank" rel="noreferrer" title={`Open the photo of ${label}`}>
      <img src={url} alt={`Photo of ${label}`} loading="lazy" onError={() => setBroken(true)} />
    </a>
  )
}

export default function SuspectPanel({ branchId }: { branchId: string }) {
  const [tab, setTab] = useState<VisitTab>('Guest')
  const [status, setStatus] = useState<Status>('Open')
  const [rows, setRows] = useState<SuspectRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [staffList, setStaffList] = useState<StaffOption[]>([])
  const [staffError, setStaffError] = useState('')
  // the first track_id (or "dup:<pair id>" for a later track_id) whose "Is Staff" list is open, and the staff picked
  const [picking, setPicking] = useState<{ track: string; staffId: string } | null>(null)
  const [onDuty, setOnDuty] = useState<Set<string>>(new Set()) // staff_ids ticked "On duty today"
  const [dutyError, setDutyError] = useState('')

  // Staff on duty today in this branch (staff_duty)
  useEffect(() => {
    let cancelled = false
    setOnDuty(new Set())
    setDutyError('')
    supabase
      .from('staff_duty')
      .select('staff_id')
      .eq('branch_id', branchId)
      .eq('duty_date', todayKey())
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setDutyError(error.message)
        else setOnDuty(new Set((data ?? []).map((d: { staff_id: string }) => d.staff_id)))
      })
    return () => {
      cancelled = true
    }
  }, [branchId])

  // Staff of the selected branch only (not resigned), for "Is Staff": staff_no – full_name
  useEffect(() => {
    let cancelled = false
    setStaffList([])
    setStaffError('')
    supabase
      .from(TABLES.staff)
      .select('staff_id, staff_no, full_name')
      .eq('branch_id', branchId)
      .neq('status', 'Resigned')
      .order('staff_no', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setStaffError(error.message)
        else setStaffList((data ?? []) as StaffOption[])
      })
    return () => {
      cancelled = true
    }
  }, [branchId])

  // select s.*, vk.*, vd.*, ck.camera_name, cd.camera_name from suspect_match s
  // join visit vk on s.visit_keep = vk.visit_id join visit vd on s.visit_dup = vd.visit_id
  // left join camera ck on s.camera_keep = ck.camera_id left join camera cd on s.camera_dup = cd.camera_id
  // where vk.branch_id = <selected branch> and s.created_at >= today and s.status = <tab>
  // Supabase returns at most 1000 rows per request, so read today's pairs page by page
  const load = useCallback(async () => {
    const all: SuspectRow[] = []
    let failed = ''
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await supabase
        .from(SUSPECT_TABLE)
        .select(
          'suspect_match_id, visit_keep, visit_dup, track_keep, track_dup, kind, score, floor_apart, reason, ' +
            'seen_keep, seen_dup, status, ' +
            'keep:visit!suspect_match_visit_keep_fkey!inner(track_id, branch_id, visit_type, est_gender, est_age, photo_url, type_confirmed_at, staff(staff_no, full_name)), ' +
            'dup:visit!suspect_match_visit_dup_fkey(track_id, branch_id, visit_type, est_gender, est_age, photo_url, type_confirmed_at, staff(staff_no, full_name)), ' +
            'cam_keep:camera!suspect_match_camera_keep_fkey(camera_name), cam_dup:camera!suspect_match_camera_dup_fkey(camera_name)',
        )
        .eq('keep.branch_id', branchId)
        .eq('status', status)
        .gte('created_at', todayStart())
        .order('seen_keep', { ascending: true })
        .order('suspect_match_id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        failed = error.message
        break
      }
      const page = (data ?? []) as unknown as SuspectRow[]
      all.push(...page)
      if (page.length < PAGE) break
    }
    setError(failed)
    setRows(failed ? [] : all)
    setLoaded(true)
  }, [branchId, status])

  useEffect(() => {
    setLoaded(false)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load, tab])

  // Tab of a pair: Staff if either visit is a staff, Member if either is a member, else Guest.
  // Guest tab: the later track_id was first seen within 10 minutes of the first one
  // (older pairs made before this rule are left out too).
  // Staff / Member tab: the staff's (member's) visit is shown as the first track_id.
  const tabRows = useMemo(
    () =>
      rows
        .filter((r) => {
          if (rowTab(r) !== tab) return false
          if (tab !== 'Guest' || !r.seen_keep || !r.seen_dup) return true
          if (r.keep?.type_confirmed_at) return true // decided Guest: all its later track_ids
          return new Date(r.seen_dup).getTime() - new Date(r.seen_keep).getTime() <= GUEST_WINDOW_MS
        })
        .map((r) => (tab !== 'Guest' && r.dup?.visit_type === tab && r.keep?.visit_type !== tab ? swapped(r) : r)),
    [rows, tab],
  )

  // One card per first track_id, earliest first; its later track_ids earliest first
  const groups = useMemo(() => {
    const byTrack = new Map<string, Group>()
    for (const r of tabRows) {
      const track = r.keep?.track_id ?? r.track_keep
      let g = byTrack.get(track)
      if (!g) {
        g = { track, camera: r.cam_keep?.camera_name ?? '—', seen: r.seen_keep, keep: r.keep, keepVisits: [], rows: [] }
        byTrack.set(track, g)
      }
      const keepVisit = r.keep_visit ?? r.visit_keep
      if (!g.keepVisits.includes(keepVisit)) g.keepVisits.push(keepVisit)
      if (!g.keep?.type_confirmed_at && r.keep?.type_confirmed_at) g.keep = { ...r.keep, photo_url: g.keep?.photo_url ?? r.keep.photo_url }
      if ((r.seen_keep ?? '') < (g.seen ?? '~')) {
        g.seen = r.seen_keep
        g.camera = r.cam_keep?.camera_name ?? g.camera
      }
      if (!g.keep?.photo_url && r.keep?.photo_url) g.keep = r.keep
      g.rows.push(r)
    }
    const list = [...byTrack.values()]
    for (const g of list) g.rows.sort((a, b) => (a.seen_dup ?? '').localeCompare(b.seen_dup ?? ''))
    return list.sort((a, b) => (a.seen ?? '').localeCompare(b.seen ?? ''))
  }, [tabRows])

  // First track_id decided (Guest / Staff)? Only then can its later track_ids be merged / marked Not same
  const decided = (g: Group) => Boolean(g.keep?.type_confirmed_at)

  const sureIds = useMemo(
    () =>
      groups
        .filter((g) => Boolean(g.keep?.type_confirmed_at))
        .flatMap((g) => g.rows)
        .filter((r) => Number(r.score) >= SURE_SCORE)
        .map((r) => r.suspect_match_id),
    [groups],
  )

  // Leave as Guest / Is Staff for the first track_id of a card; the card then moves to that tab
  const decide = async (g: Group, type: 'Guest' | 'Staff', staffId?: string) => {
    if (type === 'Staff' && !staffId) {
      setMessage('Choose the staff first.')
      return
    }
    // A staff card can hold several of that staff's visits: say so before turning them all into guests
    if (
      type === 'Guest' &&
      g.keep?.visit_type === 'Staff' &&
      g.keepVisits.length > 1 &&
      !window.confirm(`${g.track} has ${g.keepVisits.length} visits in this card. Make all ${g.keepVisits.length} guests?`)
    )
      return
    setBusy(true)
    setMessage('')
    const { data, error } = await supabase.rpc('set_first_track_type', {
      p_visits: g.keepVisits,
      p_type: type,
      p_staff: type === 'Staff' ? staffId : null,
    })
    if (error) {
      setMessage(`Could not save: ${error.message}`)
    } else {
      const staff = staffList.find((st) => st.staff_id === staffId)
      setMessage(
        type === 'Staff'
          ? `${g.track} is staff ${staff ? `${staff.staff_no} – ${staff.full_name}` : (data as string)}: moved to the Staff tab. Now decide its later track_ids.`
          : `${g.track} is a guest: moved to the Guest tab. Now decide its later track_ids.`,
      )
      setPicking(null)
      setTab(type)
    }
    setBusy(false)
    load()
  }

  // ids must be oldest first, so a chain A → B → C always ends on A's track_id
  const merge = async (ids: string[]) => {
    setBusy(true)
    setMessage('')
    let done = 0
    for (const id of ids) {
      const { error } = await supabase.rpc('merge_suspect_match', { p_id: id })
      if (error && !/already/i.test(error.message)) {
        setMessage(`Merged ${done}; stopped: ${error.message}`)
        break
      }
      done++
    }
    if (done === ids.length) setMessage(`Merged ${done} pair${done === 1 ? '' : 's'}: each now counts as its first track_id.`)
    setBusy(false)
    load()
  }

  // "On duty today" tick of a staff: the edge box only recognises the staff on duty (when any is ticked)
  const toggleDuty = async (st: StaffOption, on: boolean) => {
    setBusy(true)
    const { error } = on
      ? await supabase
          .from('staff_duty')
          .upsert({ staff_id: st.staff_id, duty_date: todayKey(), branch_id: branchId }, { onConflict: 'staff_id,duty_date' })
      : await supabase.from('staff_duty').delete().eq('staff_id', st.staff_id).eq('duty_date', todayKey())
    if (error) {
      setMessage(`Could not save on duty: ${error.message}`)
    } else {
      setOnDuty((prev) => {
        const next = new Set(prev)
        if (on) next.add(st.staff_id)
        else next.delete(st.staff_id)
        return next
      })
      setMessage(
        `${st.staff_no} – ${st.full_name} is ${on ? '' : 'not '}on duty today. The edge box uses this within 2 minutes.`,
      )
    }
    setBusy(false)
  }

  // "Is Staff" on a later track_id: it (and the visits merged into it) becomes that staff (track_id = staff_no)
  const assignStaff = async (r: SuspectRow, staffId: string) => {
    const st = staffList.find((x) => x.staff_id === staffId)
    if (!st) {
      setMessage('Choose the staff first.')
      return
    }
    setBusy(true)
    setMessage('')
    const track = r.dup?.track_id ?? r.track_dup
    const { error } = await supabase.rpc('set_first_track_type', {
      p_visits: [r.dup_visit ?? r.visit_dup],
      p_type: 'Staff',
      p_staff: staffId,
    })
    setMessage(
      error
        ? `Could not save: ${error.message}`
        : `${track} is staff ${st.staff_no} – ${st.full_name}: it now has the staff's track_id ${st.staff_no}.`,
    )
    if (!error) setPicking(null)
    setBusy(false)
    load()
  }

  // Staff tab: every staff of the branch first (its card, or an empty one), then the other cards
  const items = useMemo(() => {
    if (tab !== 'Staff') return groups.map((g) => ({ g, st: undefined as StaffOption | undefined }))
    const used = new Set<string>()
    const list: { g: Group | undefined; st: StaffOption | undefined }[] = staffList.map((st) => {
      const g = groups.find((x) => x.track === st.staff_no)
      if (g) used.add(g.track)
      return { g, st }
    })
    return [...list, ...groups.filter((g) => !used.has(g.track)).map((g) => ({ g, st: undefined }))]
  }, [tab, groups, staffList])

  // The staff list of "Is Staff": staff of the selected branch only, staff_no – full_name
  const staffPick = (key: string, label: string, onSave: (staffId: string) => void) =>
    picking?.track === key && (
      <span className="sp-staff-pick">
        <select
          aria-label={`Staff for ${label}`}
          value={picking.staffId}
          onChange={(e) => setPicking({ track: key, staffId: e.target.value })}
        >
          <option value="">
            {staffError
              ? `Could not load staff: ${staffError}`
              : staffList.length === 0
                ? 'No staff in this branch'
                : 'Choose the staff…'}
          </option>
          {staffList.map((st) => (
            <option key={st.staff_id} value={st.staff_id}>
              {st.staff_no} – {st.full_name}
            </option>
          ))}
        </select>
        <button type="button" className="cam-add" disabled={busy || !picking.staffId} onClick={() => onSave(picking.staffId)}>
          Save as staff
        </button>
        <button type="button" className="cam-toggle" disabled={busy} onClick={() => setPicking(null)}>
          Cancel
        </button>
      </span>
    )

  const dutyTick = (st: StaffOption) => (
    <label className="sp-duty">
      <input
        type="checkbox"
        checked={onDuty.has(st.staff_id)}
        disabled={busy || Boolean(dutyError)}
        onChange={(e) => toggleDuty(st, e.target.checked)}
      />
      On duty today
    </label>
  )

  const notSame = async (r: SuspectRow) => {
    setBusy(true)
    const { error } = await supabase
      .from(SUSPECT_TABLE)
      .update({ status: 'Not same', updated_at: new Date().toISOString() })
      .eq('suspect_match_id', r.suspect_match_id)
    setMessage(
      error
        ? `Could not save: ${error.message}`
        : `${r.dup?.track_id ?? r.track_dup} is another person: it is now its own first track_id.`,
    )
    setBusy(false)
    load()
  }

  const mergeSure = () => {
    if (!sureIds.length) return
    if (!window.confirm(`Merge the ${sureIds.length} pair(s) at least ${SURE_SCORE}% alike? Check the photos first.`)) return
    merge(sureIds) // groups and their rows are already earliest first
  }

  return (
    <section className="ds-panel">
      <h2>Suspicious same person</h2>
      <p className="cam-count-note">
        One card per first track_id, earliest first. Below it: later track_ids that may be the same person, judged by
        their looks only: attire colour, face, whole body, and the texture of the head, chest and legs. Compare the
        photos. <b>Merge</b> gives the later track_id the first one, so the Dashboard counts
        that person once. <b>Not same</b> makes it its own first track_id. First decide the first track_id:{' '}
        <b>Leave as Guest</b> or <b>Is Staff</b> (pick the staff); the card moves to that tab, then decide its later
        track_ids.
      </p>
      <div className="tabs">
        {VISIT_TABS.map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <>
      {tab === 'Guest' ? (
        <p className="cam-count-note">
          Guest: a first track_id only collects track_ids first seen within 10 minutes of it; a later one becomes a new
          first track_id. People whose top or pants are clearly another colour, or whose shirt or pants pattern is
          clearly different, are never paired.
        </p>
      ) : tab === 'Staff' ? (
        <p className="cam-count-note">
          Staff: every staff of this branch is listed first, with the staff no. as the first track_id. Tick{' '}
          <b>On duty today</b> for the staff working today: the edge box then only recognises them (nobody ticked:
          every staff of the branch). A person recognised as a staff (by body, from any angle) has the staff no. as
          the first track_id. Another track_id that may be the same staff is merged at once when it is at least 70%
          alike (see Merged); lower ones wait here. <b>Merge</b> gives it the staff no.
          {dutyError && <span className="ds-error"> On duty cannot be saved yet: {dutyError} (run staff_duty.sql)</span>}
        </p>
      ) : (
        <p className="cam-count-note">Member: pairs where one of the two people was recognised as a member.</p>
      )}
      <div className="cam-toolbar">
        <label className="cam-filter">
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="Open">Open</option>
            <option value="Merged">Merged</option>
            <option value="Not same">Not same</option>
          </select>
        </label>
        {status === 'Open' && (
          <div className="cam-toolbar-actions">
            <span className="sp-total">
              {groups.length} first track_id{groups.length === 1 ? '' : 's'} · {tabRows.length} pair{tabRows.length === 1 ? '' : 's'}
            </span>
            <button type="button" className="cam-add" disabled={busy || sureIds.length === 0} onClick={mergeSure}>
              Merge all sure ≥{SURE_SCORE}% ({sureIds.length})
            </button>
          </div>
        )}
      </div>
      {message && <p className="cam-count-note">{message}</p>}

      {!loaded ? (
        <p className="ds-empty">Loading…</p>
      ) : error ? (
        <p className="ds-error">Failed to load: {error}</p>
      ) : items.length === 0 ? (
        <p className="ds-empty">
          {status === 'Open' ? 'No suspicious same person today.' : `No ${status.toLowerCase()} pairs today.`}
        </p>
      ) : (
        <div className="sp-list">
          {items.map(({ g, st }) =>
            !g ? (
              st && (
                <article key={`staff-${st.staff_id}`} className="sp-card">
                  <header className="sp-first">
                    <div className="sp-photo sp-photo--none">Staff</div>
                    <div className="sp-info">
                      <span className="sp-label">First track_id (staff)</span>
                      <strong className="sp-track">{st.staff_no}</strong>
                      <span>{st.full_name}</span>
                      {dutyTick(st)}
                      <span className="sp-muted">
                        {status === 'Open'
                          ? 'No suspicious same person for this staff today.'
                          : `No ${status.toLowerCase()} pairs for this staff today.`}
                      </span>
                    </div>
                  </header>
                </article>
              )
            ) : (
            <article key={g.track} className="sp-card">
              <header className="sp-first">
                <Photo url={g.keep?.photo_url} label={g.track} />
                <div className="sp-info">
                  <span className="sp-label">First track_id (kept)</span>
                  <strong className="sp-track">{g.track}</strong>
                  {st && <span>{st.full_name}</span>}
                  {st && dutyTick(st)}
                  <span>
                    {g.camera} · first seen {fmtTime(g.seen)}
                  </span>
                  <span className="sp-muted">{person(g.keep)}</span>
                  {decided(g) ? (
                    <span className="sp-decided">
                      Decided: {g.keep?.visit_type === 'Staff' ? 'Staff' : 'Guest'}
                      {g.keep?.visit_type === 'Staff' && g.keep.staff
                        ? ` · ${g.keep.staff.staff_no} – ${g.keep.staff.full_name}`
                        : ''}
                    </span>
                  ) : (
                    status === 'Open' && <span className="sp-undecided">Decide this first track_id first: Guest or Staff?</span>
                  )}
                  {status === 'Open' && (
                    <span className="sp-actions">
                      <button
                        type="button"
                        className="cam-toggle"
                        disabled={busy}
                        onClick={() => decide(g, 'Guest')}
                      >
                        Leave as Guest
                      </button>
                      <button
                        type="button"
                        className="cam-toggle"
                        disabled={busy}
                        onClick={() => setPicking(picking?.track === g.track ? null : { track: g.track, staffId: '' })}
                      >
                        Is Staff
                      </button>
                    </span>
                  )}
                  {status === 'Open' && staffPick(g.track, g.track, (staffId) => decide(g, 'Staff', staffId))}
                  {status === 'Open' && g.rows.length > 1 && (
                    <button
                      type="button"
                      className="cam-toggle sp-group-merge"
                      disabled={busy || !decided(g)}
                      title={decided(g) ? undefined : 'Decide the first track_id (Guest or Staff) first'}
                      onClick={() => {
                        if (window.confirm(`Merge all ${g.rows.length} track_ids of this card into ${g.track}?`))
                          merge(g.rows.map((r) => r.suspect_match_id))
                      }}
                    >
                      Merge all {g.rows.length} here
                    </button>
                  )}
                </div>
              </header>

              <ul className="sp-dups">
                {g.rows.map((r) => {
                  const track = r.dup?.track_id && r.dup.track_id !== g.track ? r.dup.track_id : r.track_dup
                  return (
                    <li key={r.suspect_match_id} className="sp-dup">
                      <Photo url={r.dup?.photo_url} label={track} />
                      <div className="sp-info">
                        <span className="sp-label">May be the same person</span>
                        <strong className="sp-track">{track}</strong>
                        <span>
                          {r.cam_dup?.camera_name ?? '—'} · first seen {fmtTime(r.seen_dup)}
                        </span>
                        <span className="sp-muted">{person(r.dup)}</span>
                        <span className="sp-why">
                          <Badge text={r.kind} />{' '}
                          <span className={`sp-score ${Number(r.score) >= SURE_SCORE ? 'sp-score--sure' : ''}`}>
                            {Number(r.score).toFixed(0)}% alike
                          </span>
                          {r.floor_apart !== null && <> · {Number(r.floor_apart).toFixed(1)} m apart</>}
                        </span>
                        {r.reason && <span className="sp-muted sp-reason">{r.reason}</span>}
                        {r.status === 'Open' ? (
                          <span className="sp-actions">
                            <button
                              type="button"
                              className="cam-add"
                              disabled={busy || !decided(g)}
                              title={decided(g) ? undefined : 'Decide the first track_id (Guest or Staff) first'}
                              onClick={() => merge([r.suspect_match_id])}
                            >
                              Merge
                            </button>
                            <button
                              type="button"
                              className="cam-toggle"
                              disabled={busy || !decided(g)}
                              title={decided(g) ? undefined : 'Decide the first track_id (Guest or Staff) first'}
                              onClick={() => notSame(r)}
                            >
                              Not same
                            </button>
                            <button
                              type="button"
                              className="cam-toggle"
                              disabled={busy}
                              onClick={() =>
                                setPicking(
                                  picking?.track === `dup:${r.suspect_match_id}`
                                    ? null
                                    : { track: `dup:${r.suspect_match_id}`, staffId: '' },
                                )
                              }
                            >
                              Is Staff
                            </button>
                          </span>
                        ) : (
                          <span className="sp-muted">{r.status}</span>
                        )}
                        {r.status === 'Open' &&
                          staffPick(`dup:${r.suspect_match_id}`, track, (staffId) => assignStaff(r, staffId))}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </article>
            ),
          )}
        </div>
      )}
      </>
    </section>
  )
}