import { useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject, type PointerEvent } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Camera, Point } from './types'
import {
  AUTO_FLOOR,
  CAMERA_HEIGHT,
  TAPO_C230,
  lensAngles,
  REGION_COLORS,
  REGION_KINDS,
  autoCalibration,
  fitTilt,
  floorOrAuto,
  initialMesh,
  meshAddLine,
  meshHasZ,
  meshNewPole,
  meshRemoveLine,
  readFloorAreas,
  snapPoint,
  toPicture,
  trimArea,
  type AutoFloor,
  type Calibration,
  type FloorAreas,
  type FloorMesh,
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
  regions: { region: Region; bottom: Point[][]; top: Point[][]; sides: Point[][]; hidden: Point[][]; label: Point | null }[]
}

export function spaceLines(fa: FloorAreas): SpaceLines {
  const cal = fa.calibration
  const lines: SpaceLines = { grid: [], axes: [], regions: [] }
  const b = cal ? floorBounds(fa) : null
  if (cal && b && !cal.mesh) {
    // (a dragged floor mesh is drawn by the editor itself: its X / Y lines and Z poles)
    for (let x = b.x0; x <= b.x1; x++) lines.grid.push(...projectPath(cal, [[x, b.y0, 0], [x, b.y1, 0]], false, 24))
    for (let y = b.y0; y <= b.y1; y++) lines.grid.push(...projectPath(cal, [[b.x0, y, 0], [b.x1, y, 0]], false, 24))
    const o = cal.floor_points[0] ?? { x: cal.place?.x ?? 0, y: (cal.place?.y ?? 0) + 2 }
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
        hidden: [],
        label: toPicture(cal, c.x, c.y, r.z_max),
      })
    } else {
      const outline = r.image.length >= 3 ? r.image : (r.hidden?.[0] ?? r.image)
      const n = outline.length || 1
      lines.regions.push({
        region: r,
        bottom: r.image.length >= 3 ? [[...r.image, r.image[0]]] : [],
        top: [],
        sides: [],
        hidden: (r.hidden ?? []).filter((h) => h.length >= 3).map((h) => [...h, h[0]]),
        label: { x: outline.reduce((s, p) => s + p.x, 0) / n, y: outline.reduce((s, p) => s + p.y, 0) / n },
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
    ctx.globalAlpha = 0.08
    for (const path of r.hidden) {
      ctx.beginPath()
      path.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)))
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.setLineDash([Math.max(4, W / 160), Math.max(3, W / 240)]) // blind spots: dotted
    strokePaths(ctx, r.hidden, W, H)
    ctx.setLineDash([])
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

// ---------- Editor: 3D floor (X / Y lines, Z poles) + shop areas ----------
//  1. "Adjust 3D floor": the lens sliders (height, tilt, lens) give a first guess,
//     then "Make X / Y / Z lines" lays it out as polylines on the picture:
//       X lines (red)  — floor lines along X, a row of dots each
//       Y lines (green) — floor lines along Y, a column of dots each
//       Z poles (blue) — a dot on the floor, and dots 1 m and 2 m above it
//     Drag every dot onto the real floor (tile lines, the foot of the counter,
//     a 1 m mark on a shelf or a person of known height). Lines can be added or
//     removed. The edge box then turns any picture point into a floor spot
//     through these cells, and a head into a floor spot with the Z poles.
//  2. "Add area": click dots around the floor you can SEE in the area, and add
//     its blind spots (dotted): floor hidden behind the counter / tables where
//     people still walk or stand. Dots can be dragged; right-click removes one.
//     Kinds: Purchasing / Counter (inside the shop, In) or Traffic (the walkway
//     outside, Passed By). Areas must not overlap. Anywhere not in an area is
//     Out of Range, unless the camera is "Inside only".
// There is no shared shop plan and no Staff zone: each camera has its own floor
// and areas, and where someone stands never makes them a staff.

type Mode = 'view' | 'calibrate' | 'area'
const round = (v: number) => Math.round(v * 1000) / 1000
const polyPoints = (poly: Point[]) => poly.map((p) => `${p.x},${p.y}`).join(' ')
const pathD = (paths: Point[][]) =>
  paths.map((path) => path.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')).join(' ')
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const X_COLOR = '#ef4444'
const Y_COLOR = '#22c55e'
const Z_COLOR = '#3b82f6'

// target -1 = the outline of the floor you can see, k >= 0 = blind spot k
type Draft = {
  id: string
  name: string
  kind: RegionKind
  image: Point[]
  hidden: Point[][]
  target: number
  z_min: string
  z_max: string
  isNew: boolean
}
type Drag =
  | { kind: 'node'; i: number; j: number }
  | { kind: 'pole'; k: number; m: number } // m = -1: the floor dot (moves the whole pole)
  | { kind: 'vertex'; target: number; idx: number }

// A number box that lets you type decimals: the text you type is kept as it is
// (e.g. "0." or "-") and the number is used as soon as it is a whole number.
// "," works as the decimal point too.
function DecimalInput({ value, onValue }: { value: number; onValue: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    // the value changed from outside (not by typing here): show it
    setText((t) => (Number(t.replace(',', '.')) === value ? t : String(value)))
  }, [value])
  return (
    <input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        const n = Number(t.replace(',', '.'))
        if (t.trim() !== '' && Number.isFinite(n)) onValue(n)
      }}
      onBlur={() => setText(String(value))}
    />
  )
}

const r4 = (p: Point): Point => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 })

export function AreasEditor({
  camera,
  grabFrame,
  liveReady,
  onSaved,
  people,
}: {
  camera: Camera
  grabFrame: () => string | null
  liveReady: boolean
  onSaved?: (fa: FloorAreas) => void
  people?: MutableRefObject<{ foot: Point; head: Point }[]> // full-body people seen on the live video (feet, head)
}) {
  const [saved, setSaved] = useState<FloorAreas>(() => readFloorAreas(camera.floor_areas))
  useEffect(() => setSaved(readFloorAreas(camera.floor_areas)), [camera.floor_areas])

  const [mode, setMode] = useState<Mode>('view')
  const [frozen, setFrozen] = useState<string | null>(null)
  const [aspect, setAspect] = useState(16 / 9)
  const [auto, setAuto] = useState<AutoFloor | null>(null) // lens sliders (first guess of the floor)
  const [mesh, setMesh] = useState<FloorMesh | null>(null) // X / Y lines and Z poles being dragged
  const [step, setStep] = useState(1) // metres between two lines, for "Make X / Y / Z lines"
  const [draft, setDraft] = useState<Draft | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragged = useRef(false) // a drag just ended: the click that follows adds no dot

  const editing = mode !== 'view'
  const background = (editing && frozen) || camera.last_snapshot_url || frozen

  // The floor in use: the saved one, or the automatic floor (camera 3.25 m high)
  const savedCal = useMemo(() => floorOrAuto(saved.calibration, aspect), [saved.calibration, aspect])
  // Floor being adjusted: the lens sliders + the dragged lines
  const trial = useMemo(() => {
    if (mode !== 'calibrate' || !auto) return null
    const cal = autoCalibration(aspect, auto)
    return mesh ? { ...cal, mesh } : cal
  }, [mode, auto, mesh, aspect])

  // Outlines (seen floor + blind spots) of the OTHER areas: the one being drawn must not overlap them
  const otherOutlines = useMemo(
    () =>
      saved.regions
        .filter((r) => !draft || r.id !== draft.id)
        .flatMap((r) => [r.image, ...(r.hidden ?? [])])
        .filter((p) => p.length >= 3),
    [saved.regions, draft?.id],
  )
  // The seen-floor outline with the parts lying on other areas cut off (what will be saved)
  const trimmed = useMemo(
    () => (draft && draft.image.length >= 3 ? trimArea(draft.image, otherOutlines, aspect) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft?.image, otherOutlines, aspect],
  )

  // What the picture shows: saved space, or the one being edited
  const shown: FloorAreas = useMemo(() => {
    const flat = (r: Region) => ({ ...r, floor: null })
    if (mode === 'calibrate') return { ...saved, calibration: trial ?? savedCal, regions: saved.regions.map(flat) }
    if (mode === 'area' && draft) {
      const region: Region = {
        id: draft.id,
        name: draft.name || draft.kind,
        kind: draft.kind,
        image: trimmed?.image ?? draft.image,
        hidden: draft.hidden.filter((h) => h.length >= 3),
        floor: null,
        z_min: Number(draft.z_min) || 0,
        z_max: Number(draft.z_max) || 2.2,
      }
      const others = saved.regions.filter((r) => r.id !== draft.id).map(flat)
      const drawn = region.image.length >= 3 || (region.hidden?.length ?? 0) > 0
      return { ...saved, calibration: savedCal, regions: drawn ? [...others, region] : others }
    }
    return { ...saved, calibration: savedCal, regions: saved.regions.map(flat) }
  }, [mode, saved, savedCal, trial, draft, trimmed])
  // Areas on the picture; the automatic floor grid and X / Y / Z axes only while adjusting the floor
  const lines = useMemo(() => {
    const l = spaceLines(shown)
    return mode === 'calibrate' ? l : { ...l, grid: [], axes: [] }
  }, [shown, mode])

  const pointOf = (clientX: number, clientY: number): Point => {
    const box = canvasRef.current?.getBoundingClientRect()
    if (!box) return { x: 0, y: 0 }
    return {
      x: round(Math.min(Math.max((clientX - box.left) / box.width, 0), 1)),
      y: round(Math.min(Math.max((clientY - box.top) / box.height, 0), 1)),
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
    setAuto(
      cal?.mode === 'auto'
        ? {
            height: cal.camera_height ?? CAMERA_HEIGHT,
            tilt: cal.tilt ?? AUTO_FLOOR.tilt,
            hfov: cal.hfov ?? AUTO_FLOOR.hfov,
            k1: cal.k1 ?? AUTO_FLOOR.k1,
          }
        : { ...AUTO_FLOOR, height: CAMERA_HEIGHT },
    )
    setMesh(cal?.mesh ?? null)
    setMode('calibrate')
  }

  // Tilt from people walking past on the live video (feet on the floor, head ~1.65 m up)
  const autoFitTilt = () => {
    if (!auto) return
    const seen = people?.current ?? []
    const tilt = fitTilt(seen, aspect, auto.hfov, auto.k1, auto.height)
    if (tilt === null) {
      setMessage(
        `Not enough people seen yet (${seen.length}). Keep this page open with the live video playing while people walk past, then try again.`,
      )
      return
    }
    setAuto({ ...auto, tilt })
    setMessage(`Tilt worked out from ${seen.length} views of people: ${tilt}°. Now press "Make X / Y / Z lines" and drag the dots onto the floor.`)
  }

  const makeLines = () => {
    if (!auto) return
    if (mesh && !window.confirm('Make the X / Y / Z lines again from the sliders? The dots you dragged are lost.')) return
    setMesh(initialMesh(autoCalibration(aspect, auto), step))
    setMessage('Drag each dot onto the real floor: X lines (red) and Y lines (green) on straight floor lines such as tile joints, Z poles (blue) on something of known height.')
  }

  const startArea = (r?: Region) => {
    if (!freeze()) return
    setDraft(
      r
        ? {
            id: r.id,
            name: r.name,
            kind: r.kind,
            image: r.image,
            hidden: r.hidden ?? [],
            target: r.image.length >= 3 || !(r.hidden ?? []).length ? -1 : 0,
            z_min: String(r.z_min),
            z_max: String(r.z_max),
            isNew: false,
          }
        : { id: newId(), name: '', kind: 'Purchasing', image: [], hidden: [], target: -1, z_min: '0', z_max: '2.2', isNew: true },
    )
    setMode('area')
  }

  const cancel = () => {
    setMode('view')
    setDraft(null)
    setAuto(null)
    setMesh(null)
    setHover(null)
    setDrag(null)
    setMessage('')
  }

  // The polygon being drawn: the seen-floor outline (-1) or a blind spot
  const targetPoly = (d: Draft, t = d.target) => (t < 0 ? d.image : (d.hidden[t] ?? []))
  const withTarget = (d: Draft, t: number, poly: Point[]): Draft =>
    t < 0 ? { ...d, image: poly } : { ...d, hidden: d.hidden.map((h, k) => (k === t ? poly : h)) }

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    if (mode !== 'area' || !draft) return
    // a dot near another area's corner / edge lands exactly on it (shared border, no overlap)
    const p = snapPoint(pointOf(e.clientX, e.clientY), otherOutlines, aspect)
    setDraft(withTarget(draft, draft.target, [...targetPoly(draft), p]))
  }

  const startDrag = (e: PointerEvent<HTMLSpanElement>, d: Drag) => {
    e.stopPropagation()
    e.preventDefault()
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragged.current = false
    setDrag(d)
  }

  const moveDrag = (p: Point) => {
    if (!drag) return
    dragged.current = true
    if (drag.kind === 'node')
      setMesh((m) => m && { ...m, nodes: m.nodes.map((row, i) => (i !== drag.i ? row : row.map((q, j) => (j !== drag.j ? q : r4(p))))) })
    else if (drag.kind === 'pole')
      setMesh(
        (m) =>
          m && {
            ...m,
            poles: m.poles.map((pole, k) => {
              if (k !== drag.k) return pole
              if (drag.m >= 0) return { ...pole, marks: pole.marks.map((q, n) => (n === drag.m ? r4(p) : q)) }
              const dx = p.x - pole.base.x
              const dy = p.y - pole.base.y // the floor dot moves the whole pole
              return { base: r4(p), marks: pole.marks.map((q) => r4({ x: q.x + dx, y: q.y + dy })) }
            }),
          },
      )
    else
      setDraft((d) => {
        if (!d) return d
        const q = snapPoint(p, otherOutlines, aspect)
        return withTarget(d, drag.target, targetPoly(d, drag.target).map((v, n) => (n === drag.idx ? q : v)))
      })
  }

  const removeVertex = (e: MouseEvent<HTMLSpanElement>, target: number, idx: number) => {
    e.preventDefault()
    e.stopPropagation()
    setDraft((d) => d && withTarget({ ...d, target }, target, targetPoly(d, target).filter((_, n) => n !== idx)))
  }

  // Save camera.floor_areas
  const store = async (next: FloorAreas, done: string) => {
    const calibration = next.calibration ?? floorOrAuto(null, aspect) // never saved without a floor
    const value: FloorAreas = {
      version: 3,
      calibration,
      // flat areas: the edge box checks the feet point against the outlines on the picture
      regions: next.regions.map((r) => ({ ...r, floor: null })),
      inside_only: next.inside_only === true,
      // obstacles saved before stay when the floor / areas are saved here
      ...(next.obstacles?.length ? { obstacles: next.obstacles } : {}),
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
    if (!trial) return
    if (trial.mesh && !meshHasZ(trial)) {
      setMessage('Could not save: put at least one Z pole upright (its 1 m and 2 m dots above its floor dot).')
      return
    }
    store(
      { ...saved, calibration: trial },
      trial.mesh
        ? `3D floor saved: ${trial.mesh.ys.length} X lines, ${trial.mesh.xs.length} Y lines, ${trial.mesh.poles.length} Z pole(s). The edge box starts using it within a minute.`
        : `3D floor saved (camera ${trial.camera_height} m high, tilted ${trial.tilt}°). The edge box starts using it within a minute.`,
    )
  }

  const resetCalibration = () => {
    if (!window.confirm(`Reset the 3D floor of ${camera.camera_name} to the automatic floor (the dragged X / Y / Z lines are removed)? Areas stay.`)) return
    store({ ...saved, calibration: null }, '3D floor reset to the automatic floor.')
  }

  const saveArea = () => {
    if (!draft) return
    const zMin = Number(draft.z_min.replace(',', '.'))
    const zMax = Number(draft.z_max.replace(',', '.'))
    if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax <= zMin) {
      setMessage('Could not save: the height "to" must be more than the height "from".')
      return
    }
    if (saved.inside_only && draft.kind === 'Traffic') {
      setMessage('Could not save: this camera is Inside only, so it has no Traffic walkway.')
      return
    }
    // Parts lying on other areas are cut off, so areas never overlap
    const cut = draft.image.length >= 3 ? trimArea(draft.image, otherOutlines, aspect) : null
    if (draft.image.length >= 3 && !cut) {
      setMessage('Could not save: almost all of the seen floor lies on other areas. Draw it on the free part of the floor.')
      return
    }
    const hidden = draft.hidden
      .filter((h) => h.length >= 3)
      .map((h) => trimArea(h, otherOutlines, aspect))
      .filter((h): h is { image: Point[]; trimmed: boolean } => !!h)
    if (!cut && hidden.length === 0) {
      setMessage('Could not save: draw the floor you can see (at least 3 dots) or a blind spot.')
      return
    }
    const region: Region = {
      id: draft.id,
      name: draft.name.trim() || draft.kind,
      kind: draft.kind,
      image: cut?.image ?? [],
      hidden: hidden.map((h) => h.image),
      floor: null,
      z_min: zMin,
      z_max: zMax,
    }
    const regions = draft.isNew ? [...saved.regions, region] : saved.regions.map((r) => (r.id === region.id ? region : r))
    const wasCut = !!cut?.trimmed || hidden.some((h) => h.trimmed)
    store(
      { ...saved, regions },
      `Area "${region.name}" saved${hidden.length ? ` with ${hidden.length} blind spot(s)` : ''}${wasCut ? ' (the part on other areas was cut off)' : ''}. The edge box starts using it within a minute.`,
    )
  }

  const deleteArea = (r: Region) => {
    if (!window.confirm(`Delete the area "${r.name}"?`)) return
    store({ ...saved, regions: saved.regions.filter((x) => x.id !== r.id) }, `Area "${r.name}" deleted.`)
  }

  if (!background && !liveReady) {
    return (
      <section className="cam-line">
        <h2>Shop Areas</h2>
        <p className="cam-count-note">
          Areas can be set once the edge box sends a picture (live video or snapshot) from this camera.
        </p>
      </section>
    )
  }

  const cal = saved.calibration
  const drawing = draft ? targetPoly(draft) : []
  const note =
    mode === 'calibrate'
      ? mesh
        ? 'Drag every dot onto the real floor. X lines (red) and Y lines (green): put them on straight floor lines (tile joints, the foot of a wall or the counter) — they may bend near the picture edges, follow the floor. Z poles (blue): put the floor dot where something of known height stands, and its 1 m and 2 m dots at those heights (a shelf, a door frame, a staff of known height standing there). Use poles near and far. Add or remove lines where the floor needs them.'
        : `First guess of the floor: type the camera's real height (now ${auto?.height ?? CAMERA_HEIGHT} m), click "Auto-fit tilt from people" if people walked past, then "Make X / Y / Z lines" and drag the lines onto the floor.`
      : mode === 'area'
        ? draft && draft.target >= 0
          ? `Blind spot ${draft.target + 1} (dotted): click dots around floor of this area that is HIDDEN behind the counter / a table / a display, where people still walk or stand. Someone whose body ends here has their feet hidden: the edge box works out where they stand from the top of their head.`
          : drawing.length < 3
            ? 'Click the corners of the floor you can SEE in this area, one after another (at least 3). A dot near another area’s corner or edge snaps onto it. Drag a dot to move it; right-click a dot to remove it.'
            : trimmed?.trimmed
              ? 'The coloured shape is what will be saved: the part lying on other areas is cut off automatically. Keep clicking to add corners, drag dots to adjust, or add a blind spot.'
              : 'Keep clicking to add corners, drag dots to adjust (right-click removes one), add a blind spot for floor hidden behind furniture, or Save.'
        : `${
            saved.inside_only
              ? 'Inside only: everyone this camera sees is inside the shop (In only, never Passed By / Out); places without an area count as Purchasing.'
              : 'Counter and Purchasing areas are inside the shop (In). Traffic is the walkway outside the shop (Passed By). Everywhere else (grey) is Out of Range.'
          } Each area is the floor you can see (solid line) plus its blind spots (dotted): floor hidden behind the counter or tables where people still stand. ${
            cal?.mesh
              ? `3D floor: dragged by hand (${cal.mesh.ys.length} X lines, ${cal.mesh.xs.length} Y lines, ${cal.mesh.poles.length} Z poles).`
              : `3D floor: automatic (camera ${(cal?.camera_height ?? CAMERA_HEIGHT).toFixed(2)} m high) — press "Adjust 3D floor" and drag the X / Y / Z lines onto the floor for exact spots behind the counter.`
          }`

  // ----- picture overlay -----
  const meshRows = mesh ? mesh.nodes : []
  const meshCols = mesh ? mesh.xs.map((_, j) => mesh.nodes.map((row) => row[j])) : []
  const dot = (key: string, p: Point, color: string, d: Drag, title: string, extra?: { onContextMenu?: (e: MouseEvent<HTMLSpanElement>) => void; small?: boolean; hollow?: boolean }) => (
    <span
      key={key}
      title={title}
      className={`cam-mesh-dot${extra?.small ? ' cam-mesh-dot--small' : ''}${extra?.hollow ? ' cam-mesh-dot--hollow' : ''}`}
      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: extra?.hollow ? 'transparent' : color, borderColor: extra?.hollow ? color : undefined }}
      onPointerDown={(e) => startDrag(e, d)}
      onContextMenu={extra?.onContextMenu}
    />
  )

  return (
    <section className="cam-line">
      <div className="cam-line-head">
        <h2>Shop Areas</h2>
        {mode === 'view' && (
          <div className="cam-line-actions">
            {cal && (
              <button type="button" className="cam-toggle" disabled={saving} onClick={resetCalibration}>
                Reset 3D floor
              </button>
            )}
            <button type="button" className="cam-toggle" onClick={startCalibrate}>
              Adjust 3D floor
            </button>
            <button type="button" className="cam-line-save" onClick={() => startArea()}>
              + Add area
            </button>
          </div>
        )}
        {mode === 'calibrate' && (
          <div className="cam-line-actions">
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="cam-line-save" disabled={!trial || saving} onClick={saveCalibration}>
              {saving ? 'Saving…' : 'Save 3D floor'}
            </button>
          </div>
        )}
        {mode === 'area' && draft && (
          <div className="cam-line-actions">
            <button
              type="button"
              className="cam-toggle"
              disabled={drawing.length === 0}
              onClick={() => setDraft(withTarget(draft, draft.target, drawing.slice(0, -1)))}
            >
              Undo dot
            </button>
            <button type="button" className="cam-toggle" disabled={drawing.length === 0} onClick={() => setDraft(withTarget(draft, draft.target, []))}>
              Redraw {draft.target < 0 ? 'outline' : 'blind spot'}
            </button>
            <button type="button" className="cam-toggle" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="cam-line-save"
              disabled={(draft.image.length < 3 && !draft.hidden.some((h) => h.length >= 3)) || saving}
              onClick={saveArea}
            >
              {saving ? 'Saving…' : 'Save area'}
            </button>
          </div>
        )}
      </div>

      <p className="cam-count-note">{note}</p>

      {mode === 'calibrate' && auto && (
        <>
          <div className="cam-areas-form">
            <label>
              Camera height (m)
              {/* measured from the floor to the camera lens; kept between 1.5 m and 6 m */}
              <DecimalInput value={auto.height ?? CAMERA_HEIGHT} onValue={(h) => setAuto((a) => a && { ...a, height: Math.min(Math.max(h, 1.5), 6) })} />
            </label>
            <label>
              Tilt down: {auto.tilt}°
              <input type="range" min={5} max={85} step={0.5} value={auto.tilt} onChange={(e) => setAuto({ ...auto, tilt: Number(e.target.value) })} />
            </label>
            <label>
              Lens width (centre): {auto.hfov}°
              <input type="range" min={40} max={120} step={0.1} value={auto.hfov} onChange={(e) => setAuto({ ...auto, hfov: Number(e.target.value) })} />
            </label>
            <label>
              Lens curve: {auto.k1.toFixed(2)}
              <input type="range" min={-0.8} max={0} step={0.01} value={auto.k1} onChange={(e) => setAuto({ ...auto, k1: Number(e.target.value) })} />
            </label>
            <label>
              {(() => {
                const a = lensAngles(aspect, auto.hfov, auto.k1)
                return `View: ${a.across}° across · ${a.upDown}° up-down · ${a.corner}° corners`
              })()}
              <button type="button" className="cam-toggle" onClick={() => setAuto({ ...auto, ...TAPO_C230 })}>
                Tapo C230 lens (75° · 41° · 88°)
              </button>
            </label>
            <label>
              Line spacing (m)
              <DecimalInput value={step} onValue={(v) => setStep(Math.min(Math.max(v, 0.3), 3))} />
            </label>
          </div>
          <div className="cam-line-actions cam-mesh-actions">
            <button type="button" className="cam-toggle" onClick={autoFitTilt}>
              Auto-fit tilt from people ({people?.current.length ?? 0})
            </button>
            <button type="button" className="cam-line-save" onClick={makeLines}>
              {mesh ? 'Make X / Y / Z lines again' : 'Make X / Y / Z lines'}
            </button>
            {mesh && trial && (
              <>
                <span className="cam-mesh-group" style={{ color: X_COLOR }}>
                  X lines {mesh.ys.length}
                  <button type="button" className="cam-toggle" onClick={() => setMesh(meshAddLine(trial, 'X'))}>+</button>
                  <button type="button" className="cam-toggle" disabled={mesh.ys.length <= 2} onClick={() => setMesh(meshRemoveLine(mesh, 'X'))}>−</button>
                </span>
                <span className="cam-mesh-group" style={{ color: Y_COLOR }}>
                  Y lines {mesh.xs.length}
                  <button type="button" className="cam-toggle" onClick={() => setMesh(meshAddLine(trial, 'Y'))}>+</button>
                  <button type="button" className="cam-toggle" disabled={mesh.xs.length <= 2} onClick={() => setMesh(meshRemoveLine(mesh, 'Y'))}>−</button>
                </span>
                <span className="cam-mesh-group" style={{ color: Z_COLOR }}>
                  Z poles {mesh.poles.length}
                  <button type="button" className="cam-toggle" onClick={() => setMesh({ ...mesh, poles: [...mesh.poles, meshNewPole(trial)] })}>+</button>
                  <button type="button" className="cam-toggle" disabled={mesh.poles.length <= 1} onClick={() => setMesh({ ...mesh, poles: mesh.poles.slice(0, -1) })}>−</button>
                </span>
                {!meshHasZ(trial) && <span className="cam-error">Z poles: the 1 m and 2 m dots must be ABOVE the floor dot.</span>}
              </>
            )}
          </div>
        </>
      )}

      {mode === 'area' && draft && (
        <div className="cam-areas-form">
          <label>
            Area name
            <input value={draft.name} placeholder="e.g. Counter, POP Display – Shoes" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Kind (saved as track region)
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as RegionKind })}>
              {REGION_KINDS.filter((k) => !(saved.inside_only && k === 'Traffic')).map((k) => (
                <option key={k} value={k}>
                  {k === 'Purchasing'
                    ? 'Purchasing (Point of Purchase display / shop floor) — In'
                    : k === 'Counter'
                      ? 'Counter — In'
                      : 'Traffic (walkway outside the shop) — Passed By'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Drawing now
            <span className="cam-mesh-targets">
              <button type="button" className={`cam-toggle${draft.target < 0 ? ' cam-toggle--on' : ''}`} onClick={() => setDraft({ ...draft, target: -1 })}>
                Floor you can see ({draft.image.length})
              </button>
              {draft.hidden.map((h, k) => (
                <button key={k} type="button" className={`cam-toggle cam-toggle--dotted${draft.target === k ? ' cam-toggle--on' : ''}`} onClick={() => setDraft({ ...draft, target: k })}>
                  Blind spot {k + 1} ({h.length})
                </button>
              ))}
              <button type="button" className="cam-toggle" onClick={() => setDraft({ ...draft, hidden: [...draft.hidden, []], target: draft.hidden.length })}>
                + Blind spot
              </button>
              {draft.target >= 0 && (
                <button
                  type="button"
                  className="cam-toggle"
                  onClick={() => setDraft({ ...draft, hidden: draft.hidden.filter((_, k) => k !== draft.target), target: -1 })}
                >
                  Delete blind spot {draft.target + 1}
                </button>
              )}
            </span>
          </label>
        </div>
      )}

      {background && (
        <div
          ref={canvasRef}
          className={`cam-line-canvas${editing ? ' cam-line-canvas--editing' : ''}`}
          onClick={handleClick}
          onPointerMove={(e) => {
            const p = pointOf(e.clientX, e.clientY)
            if (drag) moveDrag(p)
            else if (editing) setHover(p)
          }}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => !drag && setHover(null)}
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
            {mode !== 'calibrate' && !saved.inside_only && shown.regions.length > 0 && (
              // Out of Range: everything outside the drawn areas (seen floor and blind spots)
              <path
                d={`M0,0 L1,0 L1,1 L0,1 Z ${shown.regions
                  .flatMap((r) => [r.image, ...(r.hidden ?? [])])
                  .filter((p) => p.length >= 3)
                  .map((p) => `${pathD([p])} Z`)
                  .join(' ')}`}
                fillRule="evenodd"
                className="cam-areas-oor"
              />
            )}
            {lines.grid.length > 0 && <path d={pathD(lines.grid)} className="cam-areas-grid" />}
            {lines.axes.map((a) => (
              <path key={a.name} d={pathD(a.line)} className="cam-areas-axis" style={{ stroke: a.color }} />
            ))}
            {mode === 'calibrate' && mesh && (
              <g>
                {meshRows.map((row, i) => (
                  <polyline key={`x${i}`} points={polyPoints(row)} className="cam-mesh-line" style={{ stroke: X_COLOR }} />
                ))}
                {meshCols.map((col, j) => (
                  <polyline key={`y${j}`} points={polyPoints(col)} className="cam-mesh-line" style={{ stroke: Y_COLOR }} />
                ))}
                {mesh.poles.map((pole, k) => (
                  <polyline key={`z${k}`} points={polyPoints([pole.base, ...pole.marks])} className="cam-mesh-pole" style={{ stroke: Z_COLOR }} />
                ))}
              </g>
            )}
            {lines.regions.map(({ region, bottom, top, sides, hidden }) => (
              <g key={region.id} style={{ stroke: REGION_COLORS[region.kind], fill: REGION_COLORS[region.kind] }}>
                {bottom.map((p, i) => (
                  <polygon key={i} points={polyPoints(p)} className="cam-areas-floor" />
                ))}
                {hidden.map((p, i) => (
                  <polygon key={`h${i}`} points={polyPoints(p)} className="cam-areas-hidden" />
                ))}
                {top.length > 0 && <path d={pathD(top)} className="cam-areas-edge" />}
                {sides.length > 0 && <path d={pathD(sides)} className="cam-areas-side" />}
              </g>
            ))}
            {mode === 'area' && draft && drawing.length > 0 && (
              <polyline points={polyPoints(hover && !drag ? [...drawing, hover] : drawing)} className={draft.target < 0 ? 'cam-line-next' : 'cam-line-next cam-line-next--hidden'} />
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
          {mode !== 'calibrate' &&
            lines.regions.map(
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
          {mode === 'calibrate' && mesh && (
            <>
              {mesh.ys.map((Y, i) => (
                <span key={`yl${i}`} className="cam-mesh-label" style={{ left: `${mesh.nodes[i][0].x * 100}%`, top: `${mesh.nodes[i][0].y * 100}%`, color: X_COLOR }}>
                  Y {Y} m
                </span>
              ))}
              {mesh.xs.map((X, j) => (
                <span key={`xl${j}`} className="cam-mesh-label cam-mesh-label--below" style={{ left: `${mesh.nodes[0][j].x * 100}%`, top: `${mesh.nodes[0][j].y * 100}%`, color: Y_COLOR }}>
                  X {X} m
                </span>
              ))}
              {mesh.nodes.flatMap((row, i) =>
                row.map((p, j) => dot(`n${i}-${j}`, p, '#facc15', { kind: 'node', i, j }, `Floor point X ${mesh.xs[j]} m, Y ${mesh.ys[i]} m`)),
              )}
              {mesh.poles.flatMap((pole, k) => [
                dot(`p${k}`, pole.base, Z_COLOR, { kind: 'pole', k, m: -1 }, `Z pole ${k + 1}: floor (drag to move the whole pole)`),
                ...pole.marks.map((q, n) =>
                  dot(`p${k}-${n}`, q, Z_COLOR, { kind: 'pole', k, m: n }, `Z pole ${k + 1}: ${n + 1} m above the floor`, { small: true, hollow: true }),
                ),
              ])}
            </>
          )}
          {mode === 'area' &&
            draft &&
            [draft.image, ...draft.hidden].flatMap((poly, n) => {
              const target = n - 1
              const color = target < 0 ? '#facc15' : '#ffffff'
              return poly.map((p, idx) =>
                dot(`v${n}-${idx}`, p, color, { kind: 'vertex', target, idx }, `${target < 0 ? 'Seen floor' : `Blind spot ${target + 1}`}: drag to move, right-click to remove`, {
                  small: target !== draft.target,
                  hollow: target >= 0,
                  onContextMenu: (e) => removeVertex(e, target, idx),
                }),
              )
            })}
        </div>
      )}

      {mode === 'view' && saved.regions.length > 0 && (
        <ul className="cam-area-list">
          {saved.regions.map((r) => (
            <li key={r.id}>
              <span className="cam-areas-chip" style={{ background: REGION_COLORS[r.kind] }} />
              <strong>{r.name}</strong>
              <span className="cam-area-kind">{r.kind}</span>
              <span className="cam-area-kind">{r.kind === 'Traffic' ? 'Passed By (outside the shop)' : 'In (inside the shop)'}</span>
              {(r.hidden?.length ?? 0) > 0 && <span className="cam-area-kind">{r.hidden!.length} blind spot(s)</span>}
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
          {saved.inside_only
            ? 'Inside only, no areas: everyone this camera sees is In (Purchasing). Add a Counter area if this camera sees the counter.'
            : 'No areas yet, so this camera is not counting. Add the Counter, Purchasing (shop floor / Point of Purchase displays) and Traffic (walkway outside the shop) areas this camera sees.'}
        </p>
      )}

      {message && <p className={message.startsWith('Could') ? 'cam-error' : 'cam-count-note'}>{message}</p>}
    </section>
  )
}
