import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'
import { Badge } from './Datatable'
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
// Three tabs, one per visit_type of the first track_id: Guest, Staff, Member.
//   Guest   a first track_id only collects later track_ids first seen within
//           10 minutes of it (GUEST_WINDOW_MS); a later one is a new first
//           track_id of its own. The edge box also never pairs two people whose
//           top or pants are clearly another colour (another attire style).
//   Staff / Member  not used yet: they need face recognition of enrolled staff
//           and members first (biometric_photo / body_template, recognition_event).

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
} | null

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
}

type Group = {
  track: string // first track_id (as it is now: it may itself have been merged into an earlier one)
  camera: string
  seen: string | null
  keep: VisitInfo
  rows: SuspectRow[] // later track_ids, earliest first
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtTime = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}
const todayStart = () => {
  const d = new Date()
  return new Date(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`).toISOString()
}
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
            'keep:visit!suspect_match_visit_keep_fkey!inner(track_id, branch_id, visit_type, est_gender, est_age, photo_url), ' +
            'dup:visit!suspect_match_visit_dup_fkey(track_id, branch_id, visit_type, est_gender, est_age, photo_url), ' +
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
    if (tab !== 'Guest') return // Staff / Member: nothing to load yet
    setLoaded(false)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load, tab])

  // Guest tab: first track_id is a Guest, and the later track_id was first seen
  // within 10 minutes of it (older pairs made before this rule are left out too)
  const tabRows = useMemo(
    () =>
      rows.filter((r) => {
        if ((r.keep?.visit_type ?? 'Guest') !== tab) return false
        if (tab !== 'Guest' || !r.seen_keep || !r.seen_dup) return true
        return new Date(r.seen_dup).getTime() - new Date(r.seen_keep).getTime() <= GUEST_WINDOW_MS
      }),
    [rows, tab],
  )

  // One card per first track_id, earliest first; its later track_ids earliest first
  const groups = useMemo(() => {
    const byTrack = new Map<string, Group>()
    for (const r of tabRows) {
      const track = r.keep?.track_id ?? r.track_keep
      let g = byTrack.get(track)
      if (!g) {
        g = { track, camera: r.cam_keep?.camera_name ?? '—', seen: r.seen_keep, keep: r.keep, rows: [] }
        byTrack.set(track, g)
      }
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

  const sureIds = useMemo(
    () =>
      groups.flatMap((g) => g.rows).filter((r) => Number(r.score) >= SURE_SCORE).map((r) => r.suspect_match_id),
    [groups],
  )

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
        that person once. <b>Not same</b> makes it its own first track_id.
      </p>
      <div className="tabs">
        {VISIT_TABS.map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab !== 'Guest' ? (
        <p className="ds-empty">
          {tab} recognition is not set up yet. Suspicious same person for {tab.toLowerCase()}s will be listed here once
          the cameras can recognise enrolled {tab.toLowerCase()}s by face.
        </p>
      ) : (
      <>
      <p className="cam-count-note">
        Guest: a first track_id only collects track_ids first seen within 10 minutes of it; a later one becomes a new
        first track_id. People whose top or pants are clearly another colour, or whose shirt or pants pattern is
        clearly different, are never paired.
      </p>
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
      ) : groups.length === 0 ? (
        <p className="ds-empty">
          {status === 'Open' ? 'No suspicious same person today.' : `No ${status.toLowerCase()} pairs today.`}
        </p>
      ) : (
        <div className="sp-list">
          {groups.map((g) => (
            <article key={g.track} className="sp-card">
              <header className="sp-first">
                <Photo url={g.keep?.photo_url} label={g.track} />
                <div className="sp-info">
                  <span className="sp-label">First track_id (kept)</span>
                  <strong className="sp-track">{g.track}</strong>
                  <span>
                    {g.camera} · first seen {fmtTime(g.seen)}
                  </span>
                  <span className="sp-muted">{person(g.keep)}</span>
                  {status === 'Open' && g.rows.length > 1 && (
                    <button
                      type="button"
                      className="cam-toggle sp-group-merge"
                      disabled={busy}
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
                            <button type="button" className="cam-add" disabled={busy} onClick={() => merge([r.suspect_match_id])}>
                              Merge
                            </button>
                            <button type="button" className="cam-toggle" disabled={busy} onClick={() => notSame(r)}>
                              Not same
                            </button>
                          </span>
                        ) : (
                          <span className="sp-muted">{r.status}</span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </article>
          ))}
        </div>
      )}
      </>
      )}
    </section>
  )
}