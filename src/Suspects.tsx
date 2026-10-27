import { useCallback, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import DataTable, { Badge } from './Datatable'

// Suspicious same person (Camera page, below the cameras).
// The edge box reports pairs of track_ids that look like ONE person (face,
// whole body, clothes; also with the legs hidden): seen by two cameras, or
// re-tracked with a new number on the same camera (supabase/suspect_match.sql).
// "Merge" gives the later visit the FIRST track_id, so it is counted once.

const SUSPECT_TABLE = 'suspect_match'
const REFRESH_MS = 30_000
type Status = 'Open' | 'Merged' | 'Not same'

type VisitInfo = { track_id: string; branch_id: string; visit_type: string; est_gender: string; est_age: number | null } | null

type SuspectRow = {
  suspect_match_id: string
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

export default function SuspectPanel({ branchId }: { branchId: string }) {
  const [status, setStatus] = useState<Status>('Open')
  const [rows, setRows] = useState<SuspectRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  // select s.*, vk.track_id, vd.track_id, ck.camera_name, cd.camera_name from suspect_match s
  // join visit vk on s.visit_keep = vk.visit_id join visit vd on s.visit_dup = vd.visit_id
  // left join camera ck on s.camera_keep = ck.camera_id left join camera cd on s.camera_dup = cd.camera_id
  // where vk.branch_id = <selected branch> and s.created_at >= today and s.status = <tab>
  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from(SUSPECT_TABLE)
      .select(
        'suspect_match_id, track_keep, track_dup, kind, score, floor_apart, reason, seen_keep, seen_dup, status, ' +
          'keep:visit!suspect_match_visit_keep_fkey!inner(track_id, branch_id, visit_type, est_gender, est_age), ' +
          'dup:visit!suspect_match_visit_dup_fkey(track_id, branch_id, visit_type, est_gender, est_age), ' +
          'cam_keep:camera!suspect_match_camera_keep_fkey(camera_name), cam_dup:camera!suspect_match_camera_dup_fkey(camera_name)',
      )
      .eq('keep.branch_id', branchId)
      .eq('status', status)
      .gte('created_at', todayStart())
      .order('seen_dup', { ascending: false })
      .limit(200)
    setError(error ? error.message : '')
    setRows(error ? [] : ((data ?? []) as unknown as SuspectRow[]))
    setLoaded(true)
  }, [branchId, status])

  useEffect(() => {
    setLoaded(false)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

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

  const notSame = async (id: string) => {
    setBusy(true)
    const { error } = await supabase
      .from(SUSPECT_TABLE)
      .update({ status: 'Not same', updated_at: new Date().toISOString() })
      .eq('suspect_match_id', id)
    setMessage(error ? `Could not save: ${error.message}` : 'Marked as two different people.')
    setBusy(false)
    load()
  }

  // oldest first, so a chain A → B → C always ends on A's track_id
  const mergeAll = () => {
    if (!rows.length || !window.confirm(`Merge all ${rows.length} suspicious pairs? Each later track_id becomes the first one.`)) return
    const ordered = [...rows].sort((a, b) => (a.seen_keep ?? '').localeCompare(b.seen_keep ?? ''))
    merge(ordered.map((r) => r.suspect_match_id))
  }

  return (
    <section className="ds-panel">
      <h2>Suspicious same person</h2>
      <p className="cam-count-note">
        Today's pairs of track_ids that look like one person (face, whole body, clothes; also when the legs are hidden):
        seen by two cameras, or given a new number again on the same camera. Merge gives the later track_id the first
        one, so the Dashboard counts that person once. Check both cameras before merging.
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
            <button type="button" className="cam-add" disabled={busy || rows.length === 0} onClick={mergeAll}>
              Merge all ({rows.length})
            </button>
          </div>
        )}
      </div>
      {message && <p className="cam-count-note">{message}</p>}
      <div className="event-log-scroll">
        <DataTable
          rows={rows}
          loading={!loaded}
          error={error}
          emptyMessage={status === 'Open' ? 'No suspicious same person today.' : `No ${status.toLowerCase()} pairs today.`}
          rowKey={(r) => r.suspect_match_id}
          columns={[
            { header: 'First track_id (kept)', render: (r) => r.track_keep },
            { header: 'Its camera', render: (r) => r.cam_keep?.camera_name ?? '—' },
            { header: 'First seen', render: (r) => fmtTime(r.seen_keep) },
            { header: 'Its person', render: (r) => person(r.keep) },
            { header: 'Suspicious track_id', render: (r) => r.track_dup },
            { header: 'Suspicious camera', render: (r) => r.cam_dup?.camera_name ?? '—' },
            { header: 'Suspicious first seen', render: (r) => fmtTime(r.seen_dup) },
            { header: 'Suspicious person', render: (r) => person(r.dup) },
            { header: 'Kind', render: (r) => <Badge text={r.kind} /> },
            { header: 'Alike', render: (r) => `${Number(r.score).toFixed(1)}%` },
            { header: 'Floor apart', render: (r) => (r.floor_apart === null ? '—' : `${Number(r.floor_apart).toFixed(1)} m`) },
            { header: 'Why', render: (r) => r.reason ?? '—' },
            {
              header: 'Action',
              render: (r) =>
                r.status === 'Open' ? (
                  <span style={{ display: 'inline-flex', gap: '0.4rem' }}>
                    <button type="button" className="cam-toggle" disabled={busy} onClick={() => merge([r.suspect_match_id])}>
                      Merge
                    </button>
                    <button type="button" className="cam-toggle" disabled={busy} onClick={() => notSame(r.suspect_match_id)}>
                      Not same
                    </button>
                  </span>
                ) : (
                  r.status
                ),
            },
          ]}
        />
      </div>
    </section>
  )
}
