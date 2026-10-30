import { useEffect, useRef, useState } from 'react'
import { ANGLE_CHOICES, BODY_PARTS, bandBoxes, sideOf, type BodyPart, type PartBoxes } from './Bodycheck'

// Adjust one biometric photo by hand (Staff Details → biometric photos → Adjust):
//   - the box of each body part: drag a box to move it, drag a corner to resize it;
//     tick / untick a part to add or remove its box
//   - the direction the person faces, body_view_angle (0-359°: 0 Front, 90 Left side,
//     180 Back, 270 Right side)
// The photo itself is never cropped: the edge box learns each part from inside its box.
// Colours as in the body view design: Head red, Upper body yellow, Lower body blue, Feet green.

export const PART_COLOURS: Record<BodyPart, string> = {
  Head: '#ff3b30',
  'Upper body': '#f5c400',
  'Lower body': '#2f7bff',
  Feet: '#22b33a',
}

type Box = [number, number, number, number] // x1, y1, x2, y2 (0-1)
type Drag = { part: BodyPart; mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; start: [number, number]; box: Box }
const MIN_SIZE = 0.03 // smallest box: 3% of the photo

// The part boxes drawn over a photo (no editing): photo cards
export function BoxOverlay({ boxes }: { boxes: PartBoxes }) {
  return (
    <>
      {BODY_PARTS.filter((p) => boxes[p]).map((p) => {
        const [x1, y1, x2, y2] = boxes[p]!
        return (
          <span
            key={p}
            className="pe-box pe-box--static"
            style={{
              left: `${x1 * 100}%`,
              top: `${y1 * 100}%`,
              width: `${(x2 - x1) * 100}%`,
              height: `${(y2 - y1) * 100}%`,
              borderColor: PART_COLOURS[p],
            }}
            title={p}
          />
        )
      })}
    </>
  )
}

export function PhotoEditor({
  src,
  title,
  angle: startAngle,
  boxes: startBoxes,
  personBox,
  saving,
  onSave,
  onCancel,
}: {
  src: string
  title: string
  angle: number | null
  boxes: PartBoxes
  personBox?: Box // new boxes start inside the person (whole photo when unknown)
  saving?: boolean
  onSave: (angle: number, parts: BodyPart[], boxes: PartBoxes) => void
  onCancel: () => void
}) {
  const [boxes, setBoxes] = useState<PartBoxes>(startBoxes)
  const [angle, setAngle] = useState<number | null>(startAngle)
  const [selected, setSelected] = useState<BodyPart | null>(BODY_PARTS.find((p) => startBoxes[p]) ?? null)
  const [error, setError] = useState('')
  const area = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, saving])

  const parts = BODY_PARTS.filter((p) => boxes[p])

  // 0-1 position of the pointer inside the photo
  const at = (e: React.PointerEvent): [number, number] => {
    const r = area.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }

  const startDrag = (e: React.PointerEvent, part: BodyPart, mode: Drag['mode']) => {
    e.preventDefault()
    e.stopPropagation()
    setSelected(part)
    drag.current = { part, mode, start: at(e), box: boxes[part]! }
    area.current!.setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const [px, py] = at(e)
    const dx = px - d.start[0]
    const dy = py - d.start[1]
    let [x1, y1, x2, y2] = d.box
    if (d.mode === 'move') {
      const w = x2 - x1
      const h = y2 - y1
      x1 = Math.min(1 - w, Math.max(0, x1 + dx))
      y1 = Math.min(1 - h, Math.max(0, y1 + dy))
      x2 = x1 + w
      y2 = y1 + h
    } else {
      if (d.mode === 'nw' || d.mode === 'sw') x1 = Math.min(x2 - MIN_SIZE, Math.max(0, x1 + dx))
      if (d.mode === 'ne' || d.mode === 'se') x2 = Math.max(x1 + MIN_SIZE, Math.min(1, x2 + dx))
      if (d.mode === 'nw' || d.mode === 'ne') y1 = Math.min(y2 - MIN_SIZE, Math.max(0, y1 + dy))
      if (d.mode === 'sw' || d.mode === 'se') y2 = Math.max(y1 + MIN_SIZE, Math.min(1, y2 + dy))
    }
    const r = (v: number) => Math.round(v * 1000) / 1000
    setBoxes((b) => ({ ...b, [d.part]: [r(x1), r(y1), r(x2), r(y2)] }))
  }

  const endDrag = (e: React.PointerEvent) => {
    if (drag.current && area.current?.hasPointerCapture(e.pointerId)) area.current.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  // Tick a part: a box in its usual place inside the person; untick: remove its box
  const togglePart = (part: BodyPart) => {
    setError('')
    setBoxes((b) => {
      if (b[part]) {
        const next = { ...b }
        delete next[part]
        return next
      }
      const usual = bandBoxes([...BODY_PARTS.filter((p) => b[p]), part], personBox ?? [0, 0, 1, 1])
      return { ...b, [part]: usual[part] }
    })
    setSelected(part)
  }

  const save = () => {
    if (!parts.length) return setError('Tick at least one body part and place its box.')
    if (angle === null) return setError('Choose the angle the person faces.')
    onSave(angle, parts, boxes)
  }

  return (
    <div className="pe-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pe-dialog">
        <header className="pe-head">
          <strong>{title}</strong>
          <span className="pe-hint">Drag a box to move it, drag its corners to resize. Only what is inside a box is learnt.</span>
        </header>

        <div className="pe-body">
          <div className="pe-stage">
            <div
              className="pe-area"
              ref={area}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img src={src} alt={title} draggable={false} />
              {BODY_PARTS.filter((p) => boxes[p]).map((p) => {
                const [x1, y1, x2, y2] = boxes[p]!
                return (
                  <div
                    key={p}
                    className={`pe-box${selected === p ? ' pe-box--on' : ''}`}
                    style={{
                      left: `${x1 * 100}%`,
                      top: `${y1 * 100}%`,
                      width: `${(x2 - x1) * 100}%`,
                      height: `${(y2 - y1) * 100}%`,
                      borderColor: PART_COLOURS[p],
                      zIndex: selected === p ? 3 : 2,
                    }}
                    onPointerDown={(e) => startDrag(e, p, 'move')}
                  >
                    <span className="pe-label" style={{ background: PART_COLOURS[p] }}>
                      {p}
                    </span>
                    {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                      <span
                        key={c}
                        className={`pe-handle pe-handle--${c}`}
                        style={{ background: PART_COLOURS[p] }}
                        onPointerDown={(e) => startDrag(e, p, c)}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          </div>

          <aside className="pe-side">
            <fieldset className="pe-group">
              <legend>Body parts in the photo</legend>
              {BODY_PARTS.map((p) => (
                <label key={p} className="pe-part">
                  <input type="checkbox" checked={!!boxes[p]} disabled={saving} onChange={() => togglePart(p)} />
                  <span className="pe-swatch" style={{ background: PART_COLOURS[p] }} />
                  {p}
                </label>
              ))}
            </fieldset>

            <fieldset className="pe-group">
              <legend>Body view angle</legend>
              <div className="pe-angle">
                <input
                  type="range"
                  min={0}
                  max={355}
                  step={5}
                  value={angle ?? 0}
                  disabled={saving}
                  onChange={(e) => setAngle(Number(e.target.value))}
                  aria-label="Body view angle"
                />
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={angle ?? ''}
                  placeholder="°"
                  disabled={saving}
                  onChange={(e) =>
                    setAngle(e.target.value === '' ? null : Math.min(359, Math.max(0, Math.round(Number(e.target.value)))))
                  }
                  aria-label="Body view angle in degrees"
                />
                <span>°</span>
              </div>
              <p className="pe-side-note">{angle === null ? 'Not chosen yet' : `${sideOf(angle)} (${angle}°)`}</p>
              <div className="pe-presets">
                {ANGLE_CHOICES.map((c) => (
                  <button
                    key={c.angle}
                    type="button"
                    className={angle === c.angle ? 'pe-preset pe-preset--on' : 'pe-preset'}
                    disabled={saving}
                    onClick={() => setAngle(c.angle)}
                  >
                    {c.angle}° {c.name}
                  </button>
                ))}
              </div>
            </fieldset>

            {error && <p className="ds-error pe-error">{error}</p>}
            <div className="pe-actions">
              <button type="button" className="pe-cancel" disabled={saving} onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="mc-btn" disabled={saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
