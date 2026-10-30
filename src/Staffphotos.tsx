import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import {
  ANGLE_CHOICES,
  BODY_PARTS,
  SIDES,
  bandBoxes,
  bodyLabel,
  checkStaffPhoto,
  sideOf,
  type BodyPart,
  type PartBoxes,
} from './Bodycheck'

// Biometric photos of a staff for 360° body recognition (needs PDPA consent = Yes).
// Up to 15 per staff. Each photo is checked when it is chosen (Bodycheck.ts): the
// person is found (also in a close-up of the head), the background is blacked out,
// and the direction the person faces (body_view_angle, 0-360°) and the body parts in
// it are worked out. One part is enough. When the angle cannot be worked out, the
// admin picks it (and the parts). Photos are uploaded when Save / Update Staff is
// clicked. Files: private bucket biometric-photos/<staff_id>/<uuid>.jpg, one row each
// in biometric_photo; the edge box then makes one body_template row per part.

export const BIOMETRIC_BUCKET = 'biometric-photos'
export const BIOMETRIC_PHOTO_TABLE = 'biometric_photo'
export const BODY_TEMPLATE_TABLE = 'body_template'
export const MAX_BIOMETRIC_PHOTOS = 15

// A photo chosen on this page, not uploaded yet
export type PendingPhoto = {
  key: string
  name: string
  preview: string // object URL (the person-only photo once checked)
  status: 'checking' | 'ok' | 'rejected'
  reason?: string // why it was refused
  needs?: boolean // the admin must pick the angle / parts
  angle?: number | null // detected angle (null: not known)
  chosenAngle?: number | null // picked by the admin (overrides the detected one)
  parts?: BodyPart[]
  partBoxes?: PartBoxes
  personBox?: [number, number, number, number]
  jpeg?: Blob // the photo that will be uploaded
}

// Angle to save: the admin's choice, else the detected one
export const photoAngle = (p: PendingPhoto): number | null => p.chosenAngle ?? p.angle ?? null
// Ready to upload: checked, with an angle and at least one part
export const photoReady = (p: PendingPhoto) => p.status === 'ok' && photoAngle(p) !== null && !!p.parts?.length

// A photo already saved for this staff
type SavedPhoto = {
  biometric_photo_id: string
  storage_path: string
  body_view_angle: number
  body_parts: BodyPart[]
  enrol_status: 'Pending' | 'Enrolled' | 'Failed'
  enrol_note: string | null
  url: string | null
}
type Enrolled = { body_view_angle: number; body_part: BodyPart }

// Upload the photos that are ready. Returns the ones that failed (with the reason).
export async function uploadStaffPhotos(staffId: string, photos: PendingPhoto[]): Promise<PendingPhoto[]> {
  const failed: PendingPhoto[] = []
  for (const p of photos) {
    if (!photoReady(p) || !p.jpeg) continue
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
      body_view_angle: photoAngle(p),
      whole_body: p.parts!.length === BODY_PARTS.length,
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

// Templates of this staff: body_template → biometric_photo (staff_id)
const loadEnrolled = async (staffId: string) => {
  const { data } = await supabase
    .from(BODY_TEMPLATE_TABLE)
    .select('body_view_angle, body_part, biometric_photo!inner(staff_id)')
    .eq('biometric_photo.staff_id', staffId)
  return ((data ?? []) as unknown as Enrolled[]).map((e) => ({ body_view_angle: e.body_view_angle, body_part: e.body_part }))
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
      const [photosRes, templates] = await Promise.all([
        supabase
          .from(BIOMETRIC_PHOTO_TABLE)
          .select('biometric_photo_id, storage_path, body_view_angle, body_parts, enrol_status, enrol_note')
          .eq('staff_id', staffId)
          .order('created_at', { ascending: true }),
        loadEnrolled(staffId),
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
      setEnrolled(templates)
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

  // 360° coverage: 4 sides (nearest of 0 / 90 / 180 / 270°) x 4 parts
  type Cell = 'enrolled' | 'saved' | 'new' | ''
  const cell = (side: string, part: BodyPart): Cell => {
    if (enrolled.some((e) => sideOf(e.body_view_angle) === side && e.body_part === part)) return 'enrolled'
    if (saved.some((s) => s.enrol_status !== 'Failed' && sideOf(s.body_view_angle) === side && s.body_parts.includes(part)))
      return 'saved'
    if (pending.some((p) => photoReady(p) && sideOf(photoAngle(p)!) === side && p.parts!.includes(part))) return 'new'
    return ''
  }
  const covered = SIDES.flatMap((s) => BODY_PARTS.map((p) => cell(s.name, p))).filter(Boolean).length
  const allSides = SIDES.every((s) => BODY_PARTS.some((p) => cell(s.name, p)))

  const update = (key: string, change: (p: PendingPhoto) => Partial<PendingPhoto>) =>
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...change(p) } : p)))

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
    // Check one by one (the models are loaded once)
    ;(async () => {
      for (let i = 0; i < added.length; i++) {
        const res = await checkStaffPhoto(list[i])
        update(added[i].key, (p) => {
          if (!res.ok) return { status: 'rejected', reason: res.reason }
          URL.revokeObjectURL(p.preview) // show the person-only photo that will be uploaded
          return {
            status: 'ok',
            needs: res.needs,
            angle: res.angle,
            chosenAngle: null,
            parts: res.parts,
            partBoxes: res.partBoxes,
            personBox: res.personBox,
            jpeg: res.jpeg,
            preview: res.preview,
          }
        })
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

  // Admin ticks a part (only when the landmarks could not find them): boxes = bands of the person
  const togglePart = (key: string, part: BodyPart) =>
    update(key, (p) => {
      const parts = BODY_PARTS.filter((x) => (x === part ? !p.parts?.includes(part) : p.parts?.includes(x)))
      return { parts, partBoxes: p.personBox ? bandBoxes(parts, p.personBox) : p.partBoxes }
    })

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
    setEnrolled(await loadEnrolled(staffId!))
  }

  return (
    <div className="sf-field sf-field--wide sp-box">
      <span>
        Biometric photos for 360° recognition ({saved.length + counted}/{MAX_BIOMETRIC_PHOTOS})
      </span>
      <small>
        Each photo must show this staff only. The whole body is not needed: a photo of the head, the upper body or
        any other part works, from any side. Only the person is kept (the background is blacked out). Photos from all
        sides (front 0°, left side 90°, back 180°, right side 270°) let the cameras recognise the staff from any
        direction. Photos are uploaded when you save.
      </small>

      <table className="sp-cover" aria-label="360° body coverage">
        <thead>
          <tr>
            <th scope="col">View angle</th>
            {BODY_PARTS.map((p) => (
              <th key={p} scope="col">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SIDES.map((s) => (
            <tr key={s.name}>
              <th scope="row">
                {s.name} ({s.angle}°)
              </th>
              {BODY_PARTS.map((p) => {
                const c = cell(s.name, p)
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
        {covered}/16 covered (each angle counts for its nearest side, ±45°).{' '}
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
            const label = bodyLabel(s.body_view_angle, s.body_parts)
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
          {pending.map((p) => {
            const angle = photoAngle(p)
            const ready = photoReady(p)
            return (
              <li key={p.key} className={`sp-item sp-item--${p.status === 'ok' && !ready ? 'needs' : p.status}`}>
                <img src={p.preview} alt={p.name} />
                {p.status === 'checking' && <span className="sp-tag">Checking…</span>}
                {p.status === 'rejected' && <span className="sp-tag sp-tag--bad">✕ {p.reason}</span>}
                {p.status === 'ok' && (
                  <>
                    <span className={ready ? 'sp-tag sp-tag--ok' : 'sp-tag sp-tag--warn'}>
                      {ready ? `✓ ${bodyLabel(angle, p.parts ?? [])}` : 'Person found · choose the angle'}
                    </span>
                    <label className="sp-angle">
                      <span>Angle</span>
                      <select
                        value={p.chosenAngle ?? (p.angle !== null && p.angle !== undefined ? 'auto' : '')}
                        disabled={disabled}
                        onChange={(e) =>
                          update(p.key, () => ({
                            chosenAngle: e.target.value === 'auto' || e.target.value === '' ? null : Number(e.target.value),
                          }))
                        }
                      >
                        {p.angle !== null && p.angle !== undefined ? (
                          <option value="auto">Detected: {p.angle}°</option>
                        ) : (
                          <option value="">Choose…</option>
                        )}
                        {ANGLE_CHOICES.map((c) => (
                          <option key={c.angle} value={c.angle}>
                            {c.angle}° {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {p.needs && (
                      <div className="sp-parts" role="group" aria-label="Body parts in the photo">
                        {BODY_PARTS.map((part) => (
                          <label key={part}>
                            <input
                              type="checkbox"
                              checked={!!p.parts?.includes(part)}
                              disabled={disabled}
                              onChange={() => togglePart(p.key, part)}
                            />
                            {part}
                          </label>
                        ))}
                      </div>
                    )}
                    <span className="sp-state">Not uploaded yet</span>
                  </>
                )}
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
            )
          })}
        </ul>
      )}
    </div>
  )
}
