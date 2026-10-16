import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Camera, Point } from './types'
import type { LiveBox } from './Livevideo'
import {
  REGION_COLORS,
  REGION_KINDS,
  calibrate,
  readFloorAreas,
  regionFloor,
  toPicture,
  type Calibration,
  type FloorAreas,
  type Region,
  type RegionKind,
} from './space3d'

// ---------- 3D helpers (shared by the editor and the live video) ----------
type P3 = [number, number, number]

// A 3D path → picture polylines (0–1); parts behind the camera are left out
function projectPath(cal: Calibration, pts: P3[], closed = false, steps = 12): Point[][] {
  const out: Point[][] = []
  let cur: Point[] = []
  const all = closed ? [...pts, pts[0]] : pts
  for (let i = 0; i < all.length - 1; i++) {
    const [a, b] = [all[i], all[i + 1]]
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps
      const p = toPicture(cal, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
      if (p && Math.abs(p.x) < 50 && Math.abs(p.y) < 50) cur.push(p)
      else if (cur.length) {
        out.push(cur)
        cur = []
      }
    }
  }
  if (cur.length) out.push(cur)
  return out
}

// Where the camera hangs, on the floor plan (metres): the point P maps to nowhere
function cameraSpot(cal: Calibration): Point | null {
  const P = cal.projection
  const [a, b, c, d, e, f, g, h, i] = [P[0], P[1], P[2], P[4], P[5], P[6], P[8], P[9], P[10]]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null
  const [p, q, r] = [-P[3], -P[7], -P[11]]
  const X = (p * (e * i - f * h) - b * (q * i - f * r) + c * (q * h - e * r)) / det
  const Y = (a * (q * i - f * r) - p * (d * i - f * g) + c * (d * r - q * g)) / det
  return { x: X, y: Y }
}

// Floor part to draw the 1 m grid on: around the 4 marks and the areas
function floorBounds(fa: FloorAreas) {
  const pts = [...(fa.calibration?.floor_points ?? []), ...fa.regions.flatMap((r) => r.floor ?? [])]
  if (!pts.length) return null
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return {
    x0: Math.floor(Math.min(...xs)) - 1,
    x1: Math.ceil(Math.max(...xs)) + 1,
    y0: Math.floor(Math.min(...ys)) - 1,
    y1: Math.ceil(Math.max(...ys)) + 1,
  }
}

// Lines to draw for the floor grid, the X / Y / Z axes and each area (3D box)
export type SpaceLines = {
  grid: Point[][]
  axes: { name: 'X' | 'Y' | 'Z'; color: string; line: Point[][]; tip: Point | null }[]
  regions: { region: Region; bottom: Point[][]; top: Point[][]; sides: Point[][]; label: Point | null }[]
}

export function spaceLines(fa: FloorAreas): SpaceLines {
  const cal = fa.calibration
  const lines: SpaceLines = { grid: [], axes: [], regions: [] }
  if (cal) {
    const b = floorBounds(fa)!
    for (let x = b.x0; x <= b.x1; x++) lines.grid.push(...projectPath(cal, [[x, b.y0, 0], [x, b.y1, 0]], false, 24))
    for (let y = b.y0; y <= b.y1; y++) lines.grid.push(...projectPath(cal, [[b.x0, y, 0], [b.x1, y, 0]], false, 24))
    const o = cal.floor_points[0]
    const axis = (name: 'X' | 'Y' | 'Z', color: string, end: P3) => ({
      name,
      color,
      line: projectPath(cal, [[o.x, o.y, 0], end]),
      tip: toPicture(cal, ...end),
    })
    lines.axes = [
      axis('X', '#ef4444', [o.x + 1, o.y, 0]),
      axis('Y', '#22c55e', [o.x, o.y + 1, 0]),
      axis('Z', '#3b82f6', [o.x, o.y, 1]),
    ]
  }
  for (const r of fa.regions) {
    if (cal && r.floor) {
      const bottom: P3[] = r.floor.map((p) => [p.x, p.y, r.z_min])
      const top: P3[] = r.floor.map((p) => [p.x, p.y, r.z_max])
      const c = r.floor.reduce((s, p) => ({ x: s.x + p.x / r.floor!.length, y: s.y + p.y / r.floor!.length }), { x: 0, y: 0 })
      lines.regions.push({
        region: r,
        bottom: projectPath(cal, bottom, true),
        top: projectPath(cal, top, true),
        sides: bottom.flatMap((p, i) => projectPath(cal, [p, top[i]], false, 4)),
        label: toPicture(cal, c.x, c.y, r.z_max),
      })
    } else {
      const n = r.image.length
      lines.regions.push({
        region: r,
        bottom: [[...r.image, r.image[0]]],
        top: [],
        sides: [],
        label: { x: r.image.reduce((s, p) => s + p.x, 0) / n, y: r.image.reduce((s, p) => s + p.y, 0) / n },
      })
    }
  }
  return lines
}

// ---------- Live video drawing ----------
function strokePaths(ctx: CanvasRenderingContext2D, paths: Point[][], W: number, H: number) {
  for (const path of paths) {
    if (path.length < 2) continue
    ctx.beginPath()
    path.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)))
    ctx.stroke()
  }
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, font: number) {
  ctx.font = `700 ${font}px system-ui, sans-serif`
  const w = ctx.measureText(text).width + font * 0.6
  ctx.fillStyle = bg
  ctx.fillRect(x - w / 2, y - font * 0.65, w, font * 1.3)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

// Floor grid (1 m), X / Y / Z axes and each shop area as a 3D box
export function drawSpace(ctx: CanvasRenderingContext2D, lines: SpaceLines) {
  const { width: W, height: H } = ctx.canvas
  const font = Math.max(11, Math.round(H * 0.026))
  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  strokePaths(ctx, lines.grid, W, H)
  ctx.lineWidth = Math.max(2, W / 450)
  for (const a of lines.axes) {
    ctx.strokeStyle = a.color
    strokePaths(ctx, a.line, W, H)
    if (a.tip) tag(ctx, a.name, a.tip.x * W, a.tip.y * H, a.color, font)
  }
  for (const r of lines.regions) {
    const color = REGION_COLORS[r.region.kind]
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.18
    ctx.fillStyle = color
    for (const path of r.bottom) {
      if (path.length < 3) continue
      ctx.beginPath()
      path.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)))
      ctx.fill()
    }
    ctx.globalAlpha = 1
    strokePaths(ctx, [...r.bottom, ...r.top], W, H)
    ctx.globalAlpha = 0.6
    strokePaths(ctx, r.sides, W, H)
    ctx.globalAlpha = 1
    if (r.label) tag(ctx, r.region.name, r.label.x * W, r.label.y * H, color, font)
  }
  ctx.restore()
}

// A person as a 3D box standing on the floor (0.5 m × 0.5 m, as tall as they are)
export function drawPersonBox3d(ctx: CanvasRenderingContext2D, cal: Calibration, xyz: [number, number, number], color: string) {
  const { width: W, height: H } = ctx.canvas
  const [X, Y, Z] = xyz
  const r = 0.25
  const foot: P3[] = [
    [X - r, Y - r, 0],
    [X + r, Y - r, 0],
    [X + r, Y + r, 0],
    [X - r, Y + r, 0],
  ]
  const head: P3[] = foot.map(([x, y]) => [x, y, Z])
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, W / 380)
  strokePaths(ctx, [...projectPath(cal, foot, true, 2), ...projectPath(cal, head, true, 2)], W, H)
  strokePaths(ctx, foot.flatMap((p, i) => projectPath(cal, [p, head[i]], false, 2)), W, H)
  ctx.globalAlpha = 0.25
  ctx.fillStyle = color
  const shadow = foot.map((p) => toPicture(cal, ...p))
  if (shadow.every(Boolean)) {
    ctx.beginPath()
    ;(shadow as Point[]).forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)))
    ctx.fill()
  }
  ctx.restore()
  return toPicture(cal, X, Y, Z) // top of the head, for the label
}

// Small floor plan (seen from above) in the corner of the live video:
// the areas, the camera, and every person on this camera at their X / Y spot
export function drawFloorMap(ctx: CanvasRenderingContext2D, fa: FloorAreas, boxes: LiveBox[], colorOf: (b: LiveBox) => string) {
  const cal = fa.calibration
  if (!cal) return
  const b = floorBounds(fa)
  if (!b) return
  const cam = cameraSpot(cal)
  const xs = [b.x0, b.x1, ...(cam ? [cam.x] : [])]
  const ys = [b.y0, b.y1, ...(cam ? [cam.y] : [])]
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const { width: W, height: H } = ctx.canvas
  const size = Math.round(Math.min(W, H) * 0.34)
  const scale = (size - 16) / Math.max(x1 - x0, y1 - y0, 1)
  const left = W - size - 8
  const topY = H - size - 8
  const at = (p: Point) => [left + 8 + (p.x - x0) * scale, topY + 8 + (p.y - y0) * scale] as const
  const font = Math.max(10, Math.round(size * 0.07))
  ctx.save()
  ctx.globalAlpha = 0.78
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(left, topY, size, size)
  ctx.globalAlpha = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  for (let x = Math.ceil(x0); x <= x1; x++) {
    const [a, c] = [at({ x, y: y0 }), at({ x, y: y1 })]
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(c[0], c[1])
    ctx.stroke()
  }
  for (let y = Math.ceil(y0); y <= y1; y++) {
    const [a, c] = [at({ x: x0, y }), at({ x: x1, y })]
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(c[0], c[1])
    ctx.stroke()
  }
  for (const r of fa.regions) {
    if (!r.floor) continue
    ctx.fillStyle = REGION_COLORS[r.kind]
    ctx.globalAlpha = 0.35
    ctx.beginPath()
    r.floor.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))))
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
  }
  if (cam) {
    const [cx, cy] = at(cam)
    ctx.fillStyle = '#facc15'
    ctx.fillRect(cx - 4, cy - 4, 8, 8)
  }
  ctx.font = `600 ${font}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  for (const box of boxes) {
    if (!box.xyz) continue
    const [px, py] = at({ x: box.xyz[0], y: box.xyz[1] })
    ctx.fillStyle = colorOf(box)
    ctx.beginPath()
    ctx.arc(px, py, Math.max(3, font * 0.4), 0, Math.PI * 2)
    ctx.fill()
    if (box.visit) {
      ctx.fillStyle = '#fff'
      ctx.fillText(box.track.split('-').pop() ?? '', px + font * 0.5, py)
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.fillText('Floor map (top view)', left + 6, topY + font * 0.8)
  ctx.restore()
}

// ---------- Editor: floor calibration (3D) + shop areas ----------
// The camera is fixed, so the 3D space is set once from 4 marks on the floor:
//  1. "Set 3D floor": click 4 floor marks in the picture and type where each
//     one is on the shop floor, in metres from ONE reference corner of the
//     shop (use the same corner for every camera, so all cameras share one
//     floor and the box can tell one person seen by 2 cameras from 2 people).
//  2. "Add area": click the area's outline on the floor (e.g. the counter,
//     a Point of Purchase display), give it a name and a kind, and a height
//     range. It becomes a 3D box: X / Y on the floor, Z up.
// The edge box then knows, for each person, X / Y on the floor, Z (height)
// and the area they stand in, and records cctv_event.track_region.

type Mode = 'view' | 'calibrate' | 'area'
const round = (v: number) => Math.round(v * 1000) / 1000
const polyPoints = (poly: Point[]) => poly.map((p) => `${p.x},${p.y}`).join(' ')
const pathD = (paths: Point[][]) =>
  paths.map((path) => path.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')).join(' ')
const MARK_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#eab308']
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

type Draft = { id: string; name: string; kind: RegionKind; image: Point[]; z_min: string; z_max: string; isNew: boolean }

export function AreasEditor({
  camera,
  grabFrame,
  liveReady,
  onSaved,
}: {
  camera: Camera
  grabFrame: () => string | null
  liveReady: boolean
  onSaved?: (fa: FloorAreas) => void
}) {
  const [saved, setSaved] = useState<FloorAreas>(() => readFloorAreas(camera.floor_areas))
  useEffect(() => setSaved(readFloorAreas(camera.floor_areas)), [camera.floor_areas])

  const [mode, setMode] = useState<Mode>('view')
  const [frozen, setFrozen] = useState<string | null>(null)
  const [aspect, setAspect] = useState(16 / 9)
  const [marks, setMarks] = useState<Point[]>([])
  const [metres, setMetres] = useState<{ x: string; y: string }[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const editing = mode !== 'view'
  const background = (editing && frozen) || camera.last_snapshot_url || frozen

  // Calibration being set: worked out as soon as 4 marks + 8 numbers are in
  const trial = useMemo(() => {
    if (mode !== 'calibrate' || marks.length !== 4) return null
    const floor = metres.map((m) => ({ x: Number(m.x.replace(',', '.')), y: Number(m.y.replace(',', '.')) }))
    if (metres.some((m) => m.x.trim() === '' || m.y.trim() === '') || floor.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
      return null
    return calibrate(marks, floor, aspect)
  }, [mode, marks, metres, aspect])

  // What the picture shows: saved space, or the one being edited
  const shown: FloorAreas = useMemo(() => {
    if (mode === 'calibrate') {
      const cal = trial && 'calibration' in trial ? trial.calibration : null
      return { ...saved, calibration: cal, regions: saved.regions.map((r) => ({ ...r, floor: regionFloor(cal, r.image) })) }
    }
    if (mode === 'area' && draft) {
      const zMin = Number(draft.z_min) || 0
      const zMax = Number(draft.z_max) || 2.2
      const region: Region = {
        id: draft.id,
        name: draft.name || draft.kind,
        kind: draft.kind,
        image: draft.image,
        floor: regionFloor(saved.calibration, draft.image),
        z_min: zMin,
        z_max: zMax,
      }
      const others = saved.regions.filter((r) => r.id !== draft.id)
      return { ...saved, regions: draft.image.length >= 3 ? [...others, region] : others }
    }
    return saved
  }, [mode, saved, trial, draft])
  const lines = useMemo(() => spaceLines(shown), [shown])

  const toPoint = (e: MouseEvent<HTMLDivElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect()
    return {
      x: round(Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1)),
      y: round(Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1)),
    }
  }

  const freeze = () => {
    const still = grabFrame()
    if (!still && !camera.last_snapshot_url) {
      setMessage('Wait until the live video shows a picture, then try again.')
      return false
    }
    setFrozen(still)
    setMessage('')
    return true
  }

  const startCalibrate = () => {
    if (!freeze()) return
    const cal = saved.calibration
    setMarks(cal ? cal.image_points : [])
    setMetres(cal ? cal.floor_points.map((p) => ({ x: String(p.x), y: String(p.y) })) : [])
    setMode('calibrate')
  }

  const startArea = (r?: Region) => {
    if (!freeze()) return
    setDraft(
      r
        ? { id: r.id, name: r.name, kind: r.kind, image: r.image, z_min: String(r.z_min), z_max: String(r.z_max), isNew: false }
        : { id: newId(), name: '', kind: 'Purchasing', image: [], z_min: '0', z_max: '2.2', isNew: true },
    )
    setMode('area')
  }

  const cancel = () => {
    setMode('view')
    setDraft(null)
    setMarks([])
    setMetres([])
    setHover(null)
    setMessage('')
  }

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const p = toPoint(e)
    if (mode === 'calibrate' && marks.length < 4) {
      setMarks((m) => [...m, p])
      setMetres((m) => [...m, { x: '', y: '' }])
    } else if (mode === 'area' && draft) setDraft({ ...draft, image: [...draft.image, p] })
  }

  // Save camera.floor_areas; each area's floor outline (metres) follows the calibration
  const store = async (next: FloorAreas, done: string) => {
    const value: FloorAreas = {
      version: 3,
      calibration: next.calibration,
      regions: next.regions.map((r) => ({ ...r, floor: regionFloor(next.calibration, r.image) })),
    }
    setSaving(true)
    setMessage('')
    const { error } = await supabase.from(TABLES.camera).update({ floor_areas: value }).eq('camera_id', camera.camera_id)
    setSaving(false)
    if (error) {
      setMessage(`Could not save: ${error.message}`)
      return
    }
    setSaved(value)
    onSaved?.(value)
    cancel()
    setMessage(done)
  }

  const saveCalibration = () => {
    if (!trial || !('calibration' in trial)) return
    store({ ...saved, calibration: trial.calibration }, `3D floor saved (camera height ${trial.calibration.camera_height.toFixed(2)} m). The edge box starts using it within a minute.`)
  }

  const removeCalibration = () => {
    if (!window.confirm(`Remove the 3D floor of ${camera.camera_name}? Areas stay, but only as flat outlines on the picture.`)) return
    store({ ...saved, calibration: null }, '3D floor removed.')
  }

  const saveArea = () => {
    if (!draft || draft.image.length < 3) return
    const zMin = Number(draft.z_min.replace(',', '.'))
    const zMax = Number(draft.z_max.replace(',', '.'))
    if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax <= zMin) {
      setMessage('Could not save: the height "to" must be more than the height "from".')
      return
    }
    const region: Region = {
      id: draft.id,
      name: draft.name.trim() || draft.kind,
      kind: draft.kind,
      image: draft.image,
      floor: null,
      z_min: zMin,
      z_max: zMax,
    }
    const regions = draft.isNew
      ? [...saved.regions, region]
      : saved.regions.map((r) => (r.id === region.id ? region : r))
    store({ ...saved, regions }, `Area "${region.name}" saved. The edge box starts using it within a minute.`)
  }

  const deleteArea = (r: Region) => {
    if (!window.confirm(`Delete the area "${r.name}"?`)) return
    store({ ...saved, regions: saved.regions.filter((x) => x.id !== r.id) }, `Area "${r.name}" deleted.`)
  }

  if (!background && !liveReady) {
    return (
      <section className="cam-line">
        <h2>Shop areas (3D)</h2>
        <p className="cam-count-note">
          Areas can be set once the edge box sends a picture (live video or snapshot) from this camera.
        </p>
      </section>
    )
  }

  const cal = saved.calibration
  const note =
    mode === 'calibrate'
      ? marks.length < 4
        ? `Click floor mark ${marks.length + 1} of 4 in the picture. Use 4 spots you can measure on the floor (tape marks, tile corners), spread out, not in one line.`
        : trial && 'error' in trial
          ? trial.error
          : trial
            ? `Camera height worked out: ${trial.calibration.camera_height.toFixed(2)} m. If that is not the real height of the camera, a mark or a measurement is off. The grid shows 1 m squares on the floor.`
            : 'Type where each mark is on the shop floor, in metres from the shop’s reference corner (X along one wall, Y along the other). Use the same corner for every camera.'
      : mode === 'area'
        ? (draft?.image.length ?? 0) < 3
          ? 'Click the corners of the area’s outline on the FLOOR, one after another (at least 3).'
          : cal
            ? 'The area is shown as a 3D box: its floor outline, up to the height you set. Keep clicking to add corners, or Save.'
            : 'Flat area (no 3D floor yet): a person counts as in it when their feet are inside the outline. Keep clicking to add corners, or Save.'
        : cal
          ? `3D floor set (camera height ${cal.camera_height.toFixed(2)} m). Every full-body person gets a floor spot X / Y and a height Z, shown on the live video.`
          : 'No 3D floor yet. Set it with 4 floor marks so the box can place people in 3D and tell when 2 cameras see the same person.'

  return (
    <section className="cam-line">
      <div className="cam-line-head">
        <h2>Shop areas (3D)</h2>
        {mode === 'view' && (
          <div className="cam-line-actions">
            {cal && (
              <button type="button" className="cam-toggle" disabled={saving} onClick={removeCalibration}>
                Remove 3D floor
              </button>
            )}
            <button type="button" className="cam-toggle" onClick={startCalibrate}>
              {cal ? 'Change 3D floor' : 'Set 3D floor'}
            </button>
            <button type="button" className="cam-line-save" onClick={() => startArea()}>
              + Add area
            </button>
          </div>
        )}
        {mode === 'calibrate' && (
          <div className="cam-line-actions">
            <button
              type="button"
              className="cam-toggle"
              disabled={marks.length === 0}
              onClick={() => {
                setMarks((m) => m.slice(0, -1))
                setMetres((m) => m.slice(0, -1))
              }}
            >
              Undo mark
            </button>
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="cam-line-save"
              disabled={!trial || !('calibration' in trial) || saving}
              onClick={saveCalibration}
            >
              {saving ? 'Saving…' : 'Save 3D floor'}
            </button>
          </div>
        )}
        {mode === 'area' && draft && (
          <div className="cam-line-actions">
            <button
              type="button"
              className="cam-toggle"
              disabled={draft.image.length === 0}
              onClick={() => setDraft({ ...draft, image: draft.image.slice(0, -1) })}
            >
              Undo dot
            </button>
            <button type="button" className="cam-toggle" disabled={draft.image.length === 0} onClick={() => setDraft({ ...draft, image: [] })}>
              Redraw outline
            </button>
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="cam-line-save" disabled={draft.image.length < 3 || saving} onClick={saveArea}>
              {saving ? 'Saving…' : 'Save area'}
            </button>
          </div>
        )}
      </div>

      <p className={mode === 'calibrate' && trial && 'error' in trial ? 'cam-error' : 'cam-count-note'}>{note}</p>

      {mode === 'calibrate' && marks.length > 0 && (
        <div className="cam-areas-marks">
          {marks.map((_, i) => (
            <div className="cam-areas-mark" key={i}>
              <span className="cam-areas-chip" style={{ background: MARK_COLORS[i] }}>
                {i + 1}
              </span>
              <label>
                X (m)
                <input
                  inputMode="decimal"
                  value={metres[i]?.x ?? ''}
                  onChange={(e) => setMetres((m) => m.map((v, k) => (k === i ? { ...v, x: e.target.value } : v)))}
                />
              </label>
              <label>
                Y (m)
                <input
                  inputMode="decimal"
                  value={metres[i]?.y ?? ''}
                  onChange={(e) => setMetres((m) => m.map((v, k) => (k === i ? { ...v, y: e.target.value } : v)))}
                />
              </label>
            </div>
          ))}
        </div>
      )}

      {mode === 'area' && draft && (
        <div className="cam-areas-form">
          <label>
            Area name
            <input
              value={draft.name}
              placeholder="e.g. Counter, POP Display – Shoes"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Kind (saved as track region)
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as RegionKind })}>
              {REGION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === 'Purchasing' ? 'Purchasing (Point of Purchase display / shop floor)' : k}
                </option>
              ))}
            </select>
          </label>
          <label>
            Height from (m, Z)
            <input inputMode="decimal" value={draft.z_min} disabled={!cal} onChange={(e) => setDraft({ ...draft, z_min: e.target.value })} />
          </label>
          <label>
            Height to (m, Z)
            <input inputMode="decimal" value={draft.z_max} disabled={!cal} onChange={(e) => setDraft({ ...draft, z_max: e.target.value })} />
          </label>
        </div>
      )}

      {background && (
        <div
          className={`cam-line-canvas${editing ? ' cam-line-canvas--editing' : ''}`}
          onClick={handleClick}
          onMouseMove={(e) => editing && setHover(toPoint(e))}
          onMouseLeave={() => setHover(null)}
        >
          <img
            src={background}
            alt={`Picture from ${camera.camera_name}`}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight)
            }}
          />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            {lines.grid.length > 0 && <path d={pathD(lines.grid)} className="cam-areas-grid" />}
            {lines.axes.map((a) => (
              <path key={a.name} d={pathD(a.line)} className="cam-areas-axis" style={{ stroke: a.color }} />
            ))}
            {lines.regions.map(({ region, bottom, top, sides }) => (
              <g key={region.id} style={{ stroke: REGION_COLORS[region.kind], fill: REGION_COLORS[region.kind] }}>
                {bottom.map((p, i) => (
                  <polygon key={i} points={polyPoints(p)} className="cam-areas-floor" />
                ))}
                {top.length > 0 && <path d={pathD(top)} className="cam-areas-edge" />}
                {sides.length > 0 && <path d={pathD(sides)} className="cam-areas-side" />}
              </g>
            ))}
            {mode === 'area' && draft && draft.image.length > 0 && (
              <polyline points={polyPoints(hover ? [...draft.image, hover] : draft.image)} className="cam-line-next" />
            )}
          </svg>
          {lines.axes.map(
            (a) =>
              a.tip && (
                <span key={a.name} className="cam-areas-tag" style={{ left: `${a.tip.x * 100}%`, top: `${a.tip.y * 100}%`, background: a.color }}>
                  {a.name}
                </span>
              ),
          )}
          {lines.regions.map(
            ({ region, label }) =>
              label && (
                <span
                  key={region.id}
                  className="cam-areas-tag"
                  style={{ left: `${label.x * 100}%`, top: `${label.y * 100}%`, background: REGION_COLORS[region.kind] }}
                >
                  {region.name}
                </span>
              ),
          )}
          {mode === 'calibrate' &&
            marks.map((p, i) => (
              <span key={i} className="cam-areas-markdot" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: MARK_COLORS[i] }}>
                {i + 1}
              </span>
            ))}
          {mode === 'area' &&
            draft?.image.map((p, i) => <span key={i} className="cam-line-dot" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />)}
        </div>
      )}

      {mode === 'view' && saved.regions.length > 0 && (
        <ul className="cam-area-list">
          {saved.regions.map((r) => (
            <li key={r.id}>
              <span className="cam-areas-chip" style={{ background: REGION_COLORS[r.kind] }} />
              <strong>{r.name}</strong>
              <span className="cam-area-kind">{r.kind}</span>
              <span className="cam-area-kind">
                {r.floor ? `3D · Z ${r.z_min}–${r.z_max} m` : 'flat (no 3D floor)'}
              </span>
              <span className="cam-area-actions">
                <button type="button" className="cam-toggle" onClick={() => startArea(r)}>
                  Edit
                </button>
                <button type="button" className="cam-toggle" disabled={saving} onClick={() => deleteArea(r)}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {mode === 'view' && saved.regions.length === 0 && (
        <p className="cam-count-note">
          No areas yet. Add the Counter and each Point of Purchase display area this camera sees. When a visitor walks
          into an area, the box records one CCTV event with its track region (Counter / Purchasing / Outside Shop).
        </p>
      )}

      {message && <p className={message.startsWith('Could') ? 'cam-error' : 'cam-count-note'}>{message}</p>}
    </section>
  )
}
