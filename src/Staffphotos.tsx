import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { BODY_PARTS, BODY_VIEWS, bodyLabel, checkStaffPhoto, type BodyPart, type BodyView, type PartBoxes } from './Bodycheck'

// Biometric photos of a staff for 360° body recognition (needs PDPA consent = Yes).
// Up to 15 per staff. Each photo is checked when it is chosen (Bodycheck.ts): one
// person, a clear view (Front / Back / Left side / Right side) and the body parts in
// it. Only photos that pass are uploaded, when Save / Update Staff is clicked.
// Files: private bucket biometric-photos/<staff_id>/<uuid>.jpg, one row each in
// biometric_photo. The edge box then makes body_template rows (one per part) from
// each photo: up to 4 views x 4 parts = 16 kinds (supabase/biometric_photo.sql).

export const BIOMETRIC_BUCKET = 'biometric-photos'
export const BIOMETRIC_PHOTO_TABLE = 'biometric_photo'
export const BODY_TEMPLATE_TABLE = 'body_template'
export const MAX_BIOMETRIC_PHOTOS = 15

// A photo chosen on this page, not uploaded yet
export type PendingPhoto = {
  key: string
  name: string
  preview: string // object URL
  status: 'checking' | 'ok' | 'rejected'
  reason?: string // why it was refused
  view?: BodyView
  wholeBody?: boolean
  parts?: BodyPart[]
  partBoxes?: PartBoxes
  label?: string
  jpeg?: Blob // the photo that will be uploaded
}

// A photo already saved for this staff
type SavedPhoto = {
  biometric_photo_id: string
  storage_path: string
  body_view: BodyView
  whole_body: boolean
  body_parts: BodyPart[]
  enrol_status: 'Pending' | 'Enrolled' | 'Failed'
  enrol_note: string | null
  url: string | null
}
type Enrolled = { body_view: BodyView; body_part: BodyPart }

// Upload the photos that passed the check. Returns the ones that failed (with the reason).
export async function uploadStaffPhotos(staffId: string, photos: PendingPhoto[]): Promise<PendingPhoto[]> {
  const failed: PendingPhoto[] = []
  for (const p of photos) {
    if (p.status !== 'ok' || !p.jpeg || !p.view || !p.parts) continue
    const path = `${staffId}/${crypto.randomUUID()}.jpg`
    const up = await supabase.storage
      .from(BIOMETRIC_BUCKET)
      .upload(path, p.jpeg, { contentType: 'image/jpeg', upsert: false })
    if (up.error) {
      failed.push({ ...p, reason: up.error.message })
      continue
    }
    const { error } = await supabase.from(BIOMETRIC_PHOTO_TABLE).insert({
      staff_id: staffId,
      storage_path: path,
      body_view: p.view,
      whole_body: !!p.wholeBody,
      body_parts: p.parts,
      part_boxes: p.partBoxes ?? null,
    })
    if (error) {
      await supabase.storage.from(BIOMETRIC_BUCKET).remove([path]) // no orphan file
      failed.push({ ...p, reason: error.message })
    }
  }
  return failed
}

const ENROL_TEXT: Record<SavedPhoto['enrol_status'], string> = {
  Pending: 'Saved · waiting for the edge box',
  Enrolled: 'Saved · learnt by the edge box',
  Failed: 'Saved · edge box could not use it',
}

export function StaffPhotos({
  staffId,
  pending,
  setPending,
  reloadKey,
  disabled,
}: {
  staffId?: string
  pending: PendingPhoto[]
  setPending: (update: (prev: PendingPhoto[]) => PendingPhoto[]) => void
  reloadKey: number // changes after an upload: reload the saved photos
  disabled?: boolean
}) {
  const [saved, setSaved] = useState<SavedPhoto[]>([])
  const [enrolled, setEnrolled] = useState<Enrolled[]>([])
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Saved photos of this staff (with a link valid for 1 hour) and the parts the edge box has learnt
  useEffect(() => {
    if (!staffId) {
      setSaved([])
      setEnrolled([])
      return
    }
    let cancelled = false
    setLoadError('')
    ;(async () => {
      const [photosRes, templatesRes] = await Promise.all([
        supabase
          .from(BIOMETRIC_PHOTO_TABLE)
          .select('biometric_photo_id, storage_path, body_view, whole_body, body_parts, enrol_status, enrol_note')
          .eq('staff_id', staffId)
          .order('created_at', { ascending: true }),
        supabase.from(BODY_TEMPLATE_TABLE).select('body_view, body_part').eq('staff_id', staffId),
      ])
      if (cancelled) return
      if (photosRes.error) return setLoadError(photosRes.error.message)
      const rows = (photosRes.data ?? []) as Omit<SavedPhoto, 'url'>[]
      let urls: Record<string, string> = {}
      if (rows.length) {
        const signed = await supabase.storage
          .from(BIOMETRIC_BUCKET)
          .createSignedUrls(rows.map((r) => r.storage_path), 3600)
        urls = Object.fromEntries((signed.data ?? []).map((s) => [s.path ?? '', s.signedUrl ?? '']))
      }
      if (cancelled) return
      setSaved(rows.map((r) => ({ ...r, url: urls[r.storage_path] || null })))
      setEnrolled((templatesRes.data ?? []) as Enrolled[])
    })()
    return () => {
      cancelled = true
    }
  }, [staffId, reloadKey])

  // Free the previews when this page closes
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => () => pendingRef.current.forEach((p) => URL.revokeObjectURL(p.preview)), [])

  const counted = pending.filter((p) => p.status !== 'rejected').length
  const room = MAX_BIOMETRIC_PHOTOS - saved.length - counted

  // 360° coverage: 4 views x 4 parts
  type Cell = 'enrolled' | 'saved' | 'new' | ''
  const cell = (view: BodyView, part: BodyPart): Cell => {
    if (enrolled.some((e) => e.body_view === view && e.body_part === part)) return 'enrolled'
    if (saved.some((s) => s.enrol_status !== 'Failed' && s.body_view === view && s.body_parts.includes(part))) return 'saved'
    if (pending.some((p) => p.status === 'ok' && p.view === view && p.parts?.includes(part))) return 'new'
    return ''
  }
  const covered = BODY_VIEWS.flatMap((v) => BODY_PARTS.map((p) => cell(v, p))).filter(Boolean).length
  const allSides = BODY_VIEWS.every((v) => BODY_PARTS.some((p) => cell(v, p)))

  function addFiles(files: FileList | null) {
    setMessage('')
    if (!files || files.length === 0) return
    const list = Array.from(files)
    if (list.length > room)
      setMessage(
        `Up to ${MAX_BIOMETRIC_PHOTOS} photos per staff. ${room > 0 ? `Only the first ${room} chosen photo(s) were added.` : 'Remove a photo to add another.'}`,
      )
    const added: PendingPhoto[] = list.slice(0, Math.max(0, room)).map((f) => ({
      key: crypto.randomUUID(),
      name: f.name,
      preview: URL.createObjectURL(f),
      status: 'checking',
    }))
    if (!added.length) return
    setPending((prev) => [...prev, ...added])
    // Check one by one (the model is loaded once)
    ;(async () => {
      for (let i = 0; i < added.length; i++) {
        const res = await checkStaffPhoto(list[i])
        const done: Partial<PendingPhoto> = res.ok
          ? {
              status: 'ok',
              view: res.view,
              wholeBody: res.wholeBody,
              parts: res.parts,
              partBoxes: res.partBoxes,
              label: res.label,
              jpeg: res.jpeg,
            }
          : { status: 'rejected', reason: res.reason }
        setPending((prev) => prev.map((p) => (p.key === added[i].key ? { ...p, ...done } : p)))
      }
    })()
  }

  function removePending(key: string) {
    setPending((prev) => {
      const p = prev.find((x) => x.key === key)
      if (p) URL.revokeObjectURL(p.preview)
      return prev.filter((x) => x.key !== key)
    })
  }

  async function removeSaved(photo: SavedPhoto) {
    if (!window.confirm('Delete this saved photo? The edge box will stop using it. It cannot be undone.')) return
    setRemoving(photo.biometric_photo_id)
    setMessage('')
    // body_template rows of this photo are deleted with it (on delete cascade)
    const { error } = await supabase
      .from(BIOMETRIC_PHOTO_TABLE)
      .delete()
      .eq('biometric_photo_id', photo.biometric_photo_id)
    if (!error) await supabase.storage.from(BIOMETRIC_BUCKET).remove([photo.storage_path])
    setRemoving(null)
    if (error) return setMessage(`Failed to delete the photo: ${error.message}`)
    setSaved((s) => s.filter((x) => x.biometric_photo_id !== photo.biometric_photo_id))
    const { data } = await supabase.from(BODY_TEMPLATE_TABLE).select('body_view, body_part').eq('staff_id', staffId!)
    setEnrolled((data ?? []) as Enrolled[])
  }

  return (
    <div className="sf-field sf-field--wide sp-box">
      <span>
        Biometric photos for 360° recognition ({saved.length + counted}/{MAX_BIOMETRIC_PHOTOS})
      </span>
      <small>
        Each photo must show this staff only, with a clear front, back, left side or right side of the body. Photos
        from all 4 sides let the cameras recognise the staff from any direction, even when the face is not seen.
        Photos that fail the check cannot be uploaded. Photos are uploaded when you save.
      </small>

      <table className="sp-cover" aria-label="360° body coverage">
        <thead>
          <tr>
            <th scope="col">View</th>
            {BODY_PARTS.map((p) => (
              <th key={p} scope="col">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BODY_VIEWS.map((v) => (
            <tr key={v}>
              <th scope="row">{v}</th>
              {BODY_PARTS.map((p) => {
                const c = cell(v, p)
                return (
                  <td key={p} className={c ? `sp-cell sp-cell--${c}` : 'sp-cell'}>
                    {c === 'enrolled' ? '✓ Learnt' : c === 'saved' ? 'Saved' : c === 'new' ? 'To upload' : '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <small>
        {covered}/16 view and part kinds covered.{' '}
        {allSides ? '360° covered: every side of the body has a photo.' : 'Add photos of the missing sides for 360° recognition.'}
      </small>

      <div className="sp-actions">
        <button
          type="button"
          className="mc-btn sp-add"
          disabled={disabled || room <= 0}
          onClick={() => inputRef.current?.click()}
        >
          Add photos
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = '' // the same photo can be chosen again
          }}
        />
      </div>

      {message && <p className="ds-error sp-msg">{message}</p>}
      {loadError && <p className="ds-error sp-msg">Failed to load the saved photos: {loadError}</p>}

      {(saved.length > 0 || pending.length > 0) && (
        <ul className="sp-grid">
          {saved.map((s) => {
            const label = bodyLabel(s.body_view, s.whole_body, s.body_parts)
            return (
              <li key={s.biometric_photo_id} className={`sp-item sp-item--saved sp-item--${s.enrol_status.toLowerCase()}`}>
                {s.url ? <img src={s.url} alt={label} /> : <div className="sp-noimg" />}
                <span className="sp-tag sp-tag--ok">{label}</span>
                <span className="sp-state" title={s.enrol_note ?? undefined}>
                  {ENROL_TEXT[s.enrol_status]}
                  {s.enrol_status === 'Failed' && s.enrol_note ? `: ${s.enrol_note}` : ''}
                </span>
                <button
                  type="button"
                  className="sp-remove"
                  disabled={disabled || removing === s.biometric_photo_id}
                  onClick={() => removeSaved(s)}
                  aria-label="Delete saved photo"
                >
                  ×
                </button>
              </li>
            )
          })}
          {pending.map((p) => (
            <li key={p.key} className={`sp-item sp-item--${p.status}`}>
              <img src={p.preview} alt={p.name} />
              {p.status === 'checking' && <span className="sp-tag">Checking…</span>}
              {p.status === 'ok' && <span className="sp-tag sp-tag--ok">✓ {p.label}</span>}
              {p.status === 'rejected' && <span className="sp-tag sp-tag--bad">✕ {p.reason}</span>}
              {p.status === 'ok' && <span className="sp-state">Not uploaded yet</span>}
              <button
                type="button"
                className="sp-remove"
                disabled={disabled}
                onClick={() => removePending(p.key)}
                aria-label="Remove photo"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
