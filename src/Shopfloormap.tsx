import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Camera, Point } from './types'
import {
  AUTO_FLOOR,
  CAMERA_HEIGHT,
  REGION_COLORS,
  REGION_KINDS,
  autoCalibration,
  floorOf,
  readFloorAreas,
  regionFloor,
  toPicture,
  type Calibration,
  type FloorAreas,
  type Region,
  type RegionKind,
} from './space3d'
import { layoutFor, type ShopLayout, type ShopRegion } from './shopLayouts'

// ---------- 3D shop floor map ----------
// All cameras of the branch on ONE shop floor plan (metres, seen in 3D or from
// the top): the shop outline (walls + shop front), the shop areas (Counter,
// Purchasing, Outside Shop) and the 4 cameras, each at its X / Y, facing a
// direction, 3.25 m high. The map shows:
//  - the floor each camera sees, and where 2 or more cameras see the SAME
//    floor (red), also per shop area: a person standing there is seen twice,
//    and the edge box counts them once because both cameras give the same
//    floor spot;
//  - each camera's latest picture laid flat on the floor, so the 4 pictures
//    join into one picture of the shop: when a camera is placed right, the
//    floor tiles, shelves' feet and the counter line up with the other cameras.
// Drag a camera to move it; with "Edit corners & areas", drag the corners of
// the shop and of its areas. Save stores the plan in branch.floor_plan (read
// by the edge box: same areas and In / Out for all cameras) and each camera's
// place in camera.floor_areas (calibration.placed = true, place = {x, y, yaw}).
// The JackStudio @ Aeon Bukit Tinggi drawing (shopLayouts.ts) is the start.

type ShopPlan = { outline: Point[]; regions: ShopRegion[] }
type Draft = {
  id: string
  name: string
  snapshot: string | null
  aspect: number
  tilt: number
  hfov: number
  k1: number
  placed: boolean // saved as placed on the shop plan
  manual: boolean // saved with 4 hand-measured floor marks (not the automatic floor)
  place: { x: number; y: number; yaw: number }
  regions: Region[] // this camera's own areas (drawn on its picture)
  dirty: boolean
}
type View = { mode: '3d' | 'top'; yaw: number; pitch: number; dist: number; target: [number, number] }
type P3 = [number, number, number]
// a corner being dragged: the outline (-1) or a shop area (index), and the corner's index
type CornerRef = { shape: number; i: number }

const rectPlan = (w: number, d: number): ShopPlan => ({
  outline: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: d },
    { x: 0, y: d },
  ],
  regions: [],
})
const COLORS = ['#2563eb', '#16a34a', '#f97316', '#9333ea', '#0891b2', '#ca8a04']
const OVERLAP_COLOR = '#dc2626'
const RANGE = 12 // metres: farther floor is too small in the picture to track people on
const CELL = 0.25 // metres, coverage grid
const MARGIN = 2 // metres around the shop that are drawn
const FOV = (45 * Math.PI) / 180
const r2 = (v: number) => Math.round(v * 100) / 100
const r3 = (v: number) => Math.round(v * 1000) / 1000

function bounds(plan: ShopPlan) {
  const xs = plan.outline.map((p) => p.x)
  const ys = plan.outline.map((p) => p.y)
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

function inPoly(poly: Point[], x: number, y: number) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

// Camera position suggested before a camera is placed: from the shop drawing, or one per corner
function suggestedPlace(i: number, name: string, plan: ShopPlan, layout: ShopLayout | null) {
  const fromDrawing = layout?.cameras[name]
  if (fromDrawing) return { x: fromDrawing.x, y: fromDrawing.y, yaw: fromDrawing.yaw }
  const b = bounds(plan)
  const corners = [
    { x: b.x0 + 0.4, y: b.y0 + 0.4, yaw: 45 },
    { x: b.x1 - 0.4, y: b.y0 + 0.4, yaw: 315 },
    { x: b.x1 - 0.4, y: b.y1 - 0.4, yaw: 225 },
    { x: b.x0 + 0.4, y: b.y1 - 0.4, yaw: 135 },
  ]
  return corners[i % corners.length]
}

function calOf(d: Draft): Calibration {
  return autoCalibration(d.aspect, { tilt: d.tilt, hfov: d.hfov, k1: d.k1, placed: true, place: d.place }, CAMERA_HEIGHT)
}

// ---------- fit a camera from matched corners ----------
// A corner of the shop plan (metres) and where it is in the camera's picture (0–1)
type Pair = { floor: Point; pic: Point; name: string }

// Nelder–Mead: the smallest value of f near the start
function minimize(f: (v: number[]) => number, start: number[], step: number[], iterations = 400) {
  const n = start.length
  let pts = [start, ...step.map((s, i) => start.map((v, j) => (i === j ? v + s : v)))]
  let vals = pts.map(f)
  for (let it = 0; it < iterations; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b])
    pts = order.map((i) => pts[i])
    vals = order.map((i) => vals[i])
    const centre = start.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p[j], 0) / n)
    const towards = (k: number) => centre.map((c, j) => c + k * (pts[n][j] - c))
    const refl = towards(-1)
    const fr = f(refl)
    if (fr < vals[0]) {
      const exp = towards(-2)
      const fe = f(exp)
      ;[pts[n], vals[n]] = fe < fr ? [exp, fe] : [refl, fr]
    } else if (fr < vals[n - 1]) {
      ;[pts[n], vals[n]] = [refl, fr]
    } else {
      const con = towards(0.5)
      const fc = f(con)
      if (fc < vals[n]) [pts[n], vals[n]] = [con, fc]
      else
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]))
          vals[i] = f(pts[i])
        }
    }
  }
  const best = vals.indexOf(Math.min(...vals))
  return { v: pts[best], f: vals[best] }
}

// Camera place (X, Y), facing and tilt that put the plan's corners where they
// are in the picture (height 3.25 m and the Tapo lens are fixed). The camera
// is kept near where it was put on the plan (it hangs in that corner).
function fitCamera(d: Draft, pairs: Pair[], aspect: number) {
  const cost = (v: number[]) => {
    const [x, y, yaw, tilt] = v
    if (tilt < 3 || tilt > 88) return 1e9
    const cal = autoCalibration(
      aspect,
      { tilt, hfov: d.hfov, k1: d.k1, placed: true, place: { x, y, yaw: ((yaw % 360) + 360) % 360 } },
      CAMERA_HEIGHT,
    )
    let e = 0
    for (const p of pairs) {
      const q = toPicture(cal, p.floor.x, p.floor.y, 0)
      if (!q) return 1e6
      e += ((q.x - p.pic.x) * aspect) ** 2 + (q.y - p.pic.y) ** 2
    }
    // the camera hangs in its corner: it may move a little from its place on the plan, not more than ~1 m
    const moved = Math.hypot(x - d.place.x, y - d.place.y)
    return e / pairs.length + 0.0002 * moved ** 2 + (moved > 1 ? (moved - 1) ** 2 : 0)
  }
  let best: { v: number[]; f: number } | null = null
  const starts: number[][] = [[d.place.x, d.place.y, d.place.yaw, d.tilt]]
  for (let yaw = 0; yaw < 360; yaw += 45) for (const tilt of [20, 40, 60]) starts.push([d.place.x, d.place.y, yaw, tilt])
  for (const st of starts) {
    const r = minimize(cost, st, [0.3, 0.3, 15, 8], 300)
    if (!best || r.f < best.f) best = r
  }
  const r = minimize(cost, best!.v, [0.05, 0.05, 2, 1], 400) // fine-tune
  const v = r.f < best!.f ? r.v : best!.v
  // average miss in the picture, as a share of its height
  const cal = autoCalibration(aspect, { tilt: v[3], hfov: d.hfov, k1: d.k1, placed: true, place: { x: v[0], y: v[1], yaw: ((v[2] % 360) + 360) % 360 } }, CAMERA_HEIGHT)
  const miss = Math.sqrt(
    pairs.reduce((s, p) => {
      const q = toPicture(cal, p.floor.x, p.floor.y, 0)
      return s + (q ? ((q.x - p.pic.x) * aspect) ** 2 + (q.y - p.pic.y) ** 2 : 1)
    }, 0) / pairs.length,
  )
  return {
    place: { x: r2(v[0]), y: r2(v[1]), yaw: Math.round((((v[2] % 360) + 360) % 360) * 10) / 10 },
    tilt: Math.round(v[3] * 2) / 2,
    miss,
  }
}

// ---------- view (orbit camera) ----------
function viewBasis(v: View) {
  const yaw = (v.yaw * Math.PI) / 180
  const pitch = (v.pitch * Math.PI) / 180
  const eye: P3 = [
    v.target[0] + v.dist * Math.cos(pitch) * Math.sin(yaw),
    v.target[1] - v.dist * Math.cos(pitch) * Math.cos(yaw),
    v.dist * Math.sin(pitch),
  ]
  const f = norm([v.target[0] - eye[0], v.target[1] - eye[1], -eye[2]])
  // at the top view "up" on the screen is the facing direction of the orbit
  const helper: P3 = Math.abs(f[2]) > 0.999 ? [Math.sin(yaw), Math.cos(yaw), 0] : [0, 0, 1]
  const r = norm(cross(f, helper))
  const u = cross(r, f)
  return { eye, f, r, u }
}
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: P3): P3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

type Projector = {
  W: number
  H: number
  at: (X: number, Y: number, Z: number) => [number, number] | null
  ray: (sx: number, sy: number, z: number) => [number, number] | null
}

function projector(v: View, W: number, H: number): Projector {
  if (v.mode === 'top') {
    // Top view: a flat plan (no perspective), so the cameras stand right over their floor spot
    const scale = H / (2 * v.dist * Math.tan(FOV / 2))
    const [tx, ty] = v.target
    return {
      W,
      H,
      at: (X, Y) => [W / 2 + (X - tx) * scale, H / 2 - (Y - ty) * scale],
      ray: (sx, sy) => [tx + (sx - W / 2) / scale, ty - (sy - H / 2) / scale],
    }
  }
  const { eye, f, r, u } = viewBasis(v)
  const focal = H / 2 / Math.tan(FOV / 2)
  return {
    W,
    H,
    at: (X, Y, Z) => {
      const p: P3 = [X - eye[0], Y - eye[1], Z - eye[2]]
      const z = dot(p, f)
      if (z < 0.05) return null
      return [W / 2 + (focal * dot(p, r)) / z, H / 2 - (focal * dot(p, u)) / z]
    },
    // screen point → where it touches the horizontal plane at height z
    ray: (sx, sy, z) => {
      const dx = (sx - W / 2) / focal
      const dy = -(sy - H / 2) / focal
      const d: P3 = [f[0] + dx * r[0] + dy * u[0], f[1] + dx * r[1] + dy * u[1], f[2] + dx * r[2] + dy * u[2]]
      if (Math.abs(d[2]) < 1e-6) return null
      const t = (z - eye[2]) / d[2]
      if (t <= 0) return null
      return [eye[0] + d[0] * t, eye[1] + d[1] * t]
    },
  }
}

// ---------- coverage: which floor each camera sees ----------
type Coverage = {
  x0: number
  y0: number
  nx: number
  ny: number
  seen: Uint8Array[] // per camera: 1 = this cell of floor is in the picture
  count: Uint8Array // cameras that see each cell
}

function coverage(drafts: Draft[], plan: ShopPlan): Coverage {
  const b = bounds(plan)
  const x0 = b.x0 - MARGIN
  const y0 = b.y0 - MARGIN
  const nx = Math.ceil((b.x1 - b.x0 + 2 * MARGIN) / CELL)
  const ny = Math.ceil((b.y1 - b.y0 + 2 * MARGIN) / CELL)
  const count = new Uint8Array(nx * ny)
  const seen = drafts.map((d) => {
    const cal = calOf(d)
    const out = new Uint8Array(nx * ny)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const X = x0 + (i + 0.5) * CELL
        const Y = y0 + (j + 0.5) * CELL
        if (Math.hypot(X - d.place.x, Y - d.place.y) > RANGE) continue
        const p = toPicture(cal, X, Y, 0)
        if (!p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue
        out[j * nx + i] = 1
        count[j * nx + i] += 1
      }
    return out
  })
  return { x0, y0, nx, ny, seen, count }
}

// A small picture (one pixel per cell) of a coverage layer, to lay on the floor
function cellsImage(cov: Coverage, paint: (k: number) => string | null): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = cov.nx
  c.height = cov.ny
  const ctx = c.getContext('2d')!
  for (let j = 0; j < cov.ny; j++)
    for (let i = 0; i < cov.nx; i++) {
      const color = paint(j * cov.nx + i)
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(i, j, 1, 1)
    }
  return c
}

// ---------- drawing ----------
// One picture triangle (src, picture pixels) drawn onto a screen triangle (dst)
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  s: [number, number][],
  d: [number, number][],
) {
  const [[sx0, sy0], [sx1, sy1], [sx2, sy2]] = s
  const [[dx0, dy0], [dx1, dy1], [dx2, dy2]] = d
  const den = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0)
  if (Math.abs(den) < 1e-9) return
  const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / den
  const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / den
  const c = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / den
  const e = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / den
  const tx = dx0 - a * sx0 - c * sy0
  const ty = dy0 - b * sx0 - e * sy0
  // grow the clip a little so neighbouring triangles leave no gaps
  const cx = (dx0 + dx1 + dx2) / 3
  const cy = (dy0 + dy1 + dy2) / 3
  const grow = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x - cx, y - cy) || 1
    return [x + ((x - cx) / l) * 0.7, y + ((y - cy) / l) * 0.7]
  }
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(...grow(dx0, dy0))
  ctx.lineTo(...grow(dx1, dy1))
  ctx.lineTo(...grow(dx2, dy2))
  ctx.closePath()
  ctx.clip()
  ctx.transform(a, b, c, e, tx, ty)
  ctx.drawImage(img, 0, 0)
  ctx.restore()
}

// A floor-plan picture (cells) laid on the floor rectangle
function drawFloorImage(ctx: CanvasRenderingContext2D, pr: Projector, img: HTMLCanvasElement, cov: Coverage, alpha: number) {
  const steps = 14
  const w = cov.nx * CELL
  const h = cov.ny * CELL
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.imageSmoothingEnabled = false
  for (let j = 0; j < steps; j++)
    for (let i = 0; i < steps; i++) {
      const corner = (a: number, b: number) => {
        const X = cov.x0 + (w * a) / steps
        const Y = cov.y0 + (h * b) / steps
        return { s: [(img.width * a) / steps, (img.height * b) / steps] as [number, number], d: pr.at(X, Y, 0) }
      }
      const q = [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)]
      if (q.some((c) => !c.d)) continue
      drawTriangle(ctx, img, [q[0].s, q[1].s, q[2].s], [q[0].d!, q[1].d!, q[2].d!])
      drawTriangle(ctx, img, [q[0].s, q[2].s, q[3].s], [q[0].d!, q[2].d!, q[3].d!])
    }
  ctx.restore()
}

// A camera's picture laid flat on the floor (the lens curve is taken out first)
// Only the FLOOR is in the right place: anything standing up (walls, shelves,
// people) is stretched away from the camera like a long shadow.
// range: floor farther than this from the camera is left out (metres).
function drawPictureOnFloor(
  ctx: CanvasRenderingContext2D,
  pr: Projector,
  img: HTMLImageElement,
  d: Draft,
  alpha: number,
  range = RANGE,
) {
  const cal = calOf(d)
  const nx = 24
  const ny = 18
  const grid: ({ s: [number, number]; d: [number, number] } | null)[][] = []
  for (let j = 0; j <= ny; j++) {
    const row: ({ s: [number, number]; d: [number, number] } | null)[] = []
    for (let i = 0; i <= nx; i++) {
      const pic: Point = { x: i / nx, y: j / ny }
      const f = floorOf(cal, pic)
      const ok = f && Math.hypot(f.x - d.place.x, f.y - d.place.y) <= range && toPicture(cal, f.x, f.y, 0)
      const scr = ok ? pr.at(f!.x, f!.y, 0) : null
      row.push(scr ? { s: [pic.x * img.naturalWidth, pic.y * img.naturalHeight], d: scr } : null)
    }
    grid.push(row)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const [a, b, c, e] = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]]
      if (a && b && c) drawTriangle(ctx, img, [a.s, b.s, c.s], [a.d, b.d, c.d])
      if (a && c && e) drawTriangle(ctx, img, [a.s, c.s, e.s], [a.d, c.d, e.d])
    }
  ctx.restore()
}

function line(ctx: CanvasRenderingContext2D, pr: Projector, pts: P3[], closed = false) {
  const scr = pts.map((p) => pr.at(...p))
  if (scr.some((s) => !s)) return false
  ctx.beginPath()
  scr.forEach((s, i) => (i ? ctx.lineTo(s![0], s![1]) : ctx.moveTo(s![0], s![1])))
  if (closed) ctx.closePath()
  return true
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string) {
  ctx.font = '600 12px system-ui, sans-serif'
  const w = ctx.measureText(text).width + 10
  ctx.fillStyle = bg
  ctx.fillRect(x - w / 2, y - 9, w, 18)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

// ---------- the component ----------
export default function ShopFloorMap({
  camera,
  onSaved,
  onPlan,
}: {
  camera: Camera
  onSaved?: (cameraId: string, value: FloorAreas) => void
  // the shop areas shared by all cameras (also while being edited, before Save)
  onPlan?: (regions: ShopRegion[]) => void
}) {
  const [branch, setBranch] = useState<{ id: string; name: string } | null>(null)
  const [layout, setLayout] = useState<ShopLayout | null>(null) // the shop drawing of this branch
  const [plan, setPlan] = useState<ShopPlan>(() => rectPlan(10, 8))
  const [planDirty, setPlanDirty] = useState(false)
  const [planColumn, setPlanColumn] = useState(true) // branch.floor_plan exists (SQL run)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [selected, setSelected] = useState<string>(camera.camera_id)
  const [view, setView] = useState<View>({ mode: '3d', yaw: 25, pitch: 48, dist: 17, target: [5, 4] })
  const [layers, setLayers] = useState({ pictures: true, coverage: true, areas: true, cameraAreas: false })
  // Camera pictures on the floor: the selected camera only (clear), or all 4 at once
  const [pictureOf, setPictureOf] = useState<'selected' | 'all'>('selected')
  const [editCorners, setEditCorners] = useState(false)
  const [corner, setCorner] = useState<CornerRef | null>(null) // corner picked (its X / Y can be typed)
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // Branch of this camera (from its edge box), its shop plan and all its cameras
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      if (!camera.edge_device_id) {
        setLoading(false)
        setMessage('This camera has no edge box, so it has no branch: link it to an edge box first.')
        return
      }
      const ed = await supabase
        .from(TABLES.edgeDevice)
        .select('branch_id, branch(branch_name)')
        .eq('edge_device_id', camera.edge_device_id)
        .maybeSingle()
      if (cancelled) return
      const row = ed.data as { branch_id: string; branch: { branch_name: string } | null } | null
      if (ed.error || !row) {
        setLoading(false)
        setMessage(`Could not load the branch: ${ed.error?.message ?? 'edge box not found'}`)
        return
      }
      const name = row.branch?.branch_name ?? 'Shop'
      const drawing = layoutFor(name)
      setBranch({ id: row.branch_id, name })
      setLayout(drawing)

      // Saved plan → the shop drawing → a 10 × 8 m rectangle
      let shop: ShopPlan | null = null
      const fp = await supabase.from(TABLES.branch).select('floor_plan').eq('branch_id', row.branch_id).maybeSingle()
      if (cancelled) return
      if (fp.error) setPlanColumn(false)
      else {
        setPlanColumn(true)
        const v = (fp.data as { floor_plan: Partial<ShopPlan & { width: number; depth: number }> | null } | null)?.floor_plan
        if (v && Array.isArray(v.outline) && v.outline.length >= 3)
          shop = { outline: v.outline, regions: Array.isArray(v.regions) ? v.regions : [] }
        else if (v && Number(v.width) > 0 && Number(v.depth) > 0) shop = rectPlan(Number(v.width), Number(v.depth))
      }
      const fromDrawing = !shop && !!drawing
      if (!shop) shop = drawing ? { outline: drawing.outline, regions: drawing.regions } : rectPlan(10, 8)
      setPlan(shop)
      setPlanDirty(fromDrawing) // the drawing is not saved yet: Save stores it

      const cams = await supabase
        .from(TABLES.camera)
        .select('camera_id, camera_name, floor_areas, last_snapshot_url, edge_device!inner(branch_id)')
        .eq('edge_device.branch_id', row.branch_id)
        .order('camera_name', { ascending: true })
      if (cancelled) return
      setLoading(false)
      if (cams.error) {
        setMessage(`Could not load the cameras: ${cams.error.message}`)
        return
      }
      const list = (cams.data ?? []) as unknown as Pick<Camera, 'camera_id' | 'camera_name' | 'floor_areas' | 'last_snapshot_url'>[]
      setDrafts(
        list.map((c, i) => {
          const fa = readFloorAreas(c.floor_areas)
          const cal = fa.calibration
          const auto = cal?.mode === 'auto'
          const placed = !!(auto && cal!.placed && cal!.place)
          const fromDrawingCam = drawing?.cameras[c.camera_name]
          return {
            id: c.camera_id,
            name: c.camera_name,
            snapshot: c.last_snapshot_url,
            aspect: cal?.aspect || 16 / 9,
            // tilt worked out on "Adjust 3D floor" is kept; otherwise the drawing's / usual tilt
            tilt: auto ? (cal!.tilt ?? AUTO_FLOOR.tilt) : (fromDrawingCam?.tilt ?? AUTO_FLOOR.tilt),
            hfov: auto ? (cal!.hfov ?? AUTO_FLOOR.hfov) : AUTO_FLOOR.hfov,
            k1: auto ? (cal!.k1 ?? AUTO_FLOOR.k1) : AUTO_FLOOR.k1,
            placed,
            manual: !!cal && !auto,
            place: placed ? cal!.place! : suggestedPlace(i, c.camera_name, shop!, drawing),
            regions: fa.regions,
            dirty: !placed && !!fromDrawingCam, // placed from the drawing: Save stores it
          }
        }),
      )
      const b = bounds(shop)
      setView((v) => ({
        ...v,
        target: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2],
        dist: Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.7 + 4,
      }))
    }
    load()
    return () => {
      cancelled = true
    }
  }, [camera.edge_device_id, reloadKey])

  // Latest picture of each camera (laid on the floor), loaded once per picture address
  const requested = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const d of drafts) {
      if (!d.snapshot || requested.current[d.id] === d.snapshot) continue
      requested.current[d.id] = d.snapshot
      const img = new Image()
      img.onload = () => setImages((cur) => ({ ...cur, [d.id]: img }))
      img.src = d.snapshot
    }
  }, [drafts])

  const cov = useMemo(() => coverage(drafts, plan), [drafts, plan])
  const coverLayers = useMemo(() => {
    if (!drafts.length) return null
    const each = drafts.map((_, n) => cellsImage(cov, (k) => (cov.seen[n][k] ? COLORS[n % COLORS.length] : null)))
    const overlap = cellsImage(cov, (k) => (cov.count[k] >= 2 ? OVERLAP_COLOR : null))
    return { each, overlap }
  }, [cov, drafts])

  // Floor seen by 2+ cameras: per pair of cameras, and per shop area (m²)
  const overlaps = useMemo(() => {
    const pairs: { a: string; b: string; m2: number }[] = []
    for (let i = 0; i < drafts.length; i++)
      for (let j = i + 1; j < drafts.length; j++) {
        let n = 0
        for (let k = 0; k < cov.count.length; k++) if (cov.seen[i][k] && cov.seen[j][k]) n++
        if (n) pairs.push({ a: drafts[i].name, b: drafts[j].name, m2: n * CELL * CELL })
      }
    const cell = CELL * CELL
    const areas = plan.regions.map((r) => {
      let total = 0
      let twice = 0
      let none = 0
      const by = drafts.map(() => 0)
      for (let j = 0; j < cov.ny; j++)
        for (let i = 0; i < cov.nx; i++) {
          const X = cov.x0 + (i + 0.5) * CELL
          const Y = cov.y0 + (j + 0.5) * CELL
          if (!inPoly(r.floor, X, Y)) continue
          // an area outside the shop counts only outside the walls, an area inside only inside them
          if ((r.kind === 'Outside Shop') === inPoly(plan.outline, X, Y)) continue
          const k = j * cov.nx + i
          total++
          if (cov.count[k] >= 2) twice++
          if (!cov.count[k]) none++
          drafts.forEach((_, n) => cov.seen[n][k] && (by[n] += 1))
        }
      return {
        region: r,
        m2: total * cell,
        twice: twice * cell,
        none: none * cell,
        cameras: drafts.filter((_, n) => by[n] > 0).map((d) => d.name),
      }
    })
    return { pairs, areas }
  }, [cov, drafts, plan])

  // ---------- canvas ----------
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 450 })
  // Follow the width of the map's box (callback ref: the box appears after loading)
  const observer = useRef<ResizeObserver | null>(null)
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w > 0) setSize({ w, h: Math.max(300, Math.round(w * 0.56)) })
    })
    ro.observe(el)
    observer.current = ro
  }, [])

  const pr = useMemo(() => projector(view, size.w, size.h), [view, size])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, size.w, size.h)
    const walls: P3[] = plan.outline.map((p) => [p.x, p.y, 0])
    const b = bounds(plan)

    // Shop floor
    ctx.fillStyle = '#1e293b'
    if (line(ctx, pr, walls, true)) ctx.fill()

    // Cameras' pictures on the floor, then the floor each camera sees and the overlaps
    if (layers.pictures) {
      // Only the shop floor and the walkway in front of it (Outside Shop areas), and no
      // floor farther away than the far end of the shop: walls and the mall are not floor
      const outsideAreas = plan.regions.filter((r) => r.kind === 'Outside Shop').map((r) => r.floor.map((p) => [p.x, p.y, 0] as P3))
      const shown = pictureOf === 'all' ? drafts : drafts.filter((d) => d.id === selected)
      for (const clip of [walls, ...outsideAreas]) {
        ctx.save()
        if (!line(ctx, pr, clip, true)) {
          ctx.restore()
          continue
        }
        ctx.clip()
        shown.forEach((d) => {
          const img = images[d.id]
          if (!img) return
          const far = Math.max(...[...plan.outline, ...plan.regions.flatMap((r) => r.floor)].map((p) => Math.hypot(p.x - d.place.x, p.y - d.place.y)))
          drawPictureOnFloor(ctx, pr, img, d, pictureOf === 'all' ? 0.6 : 0.95, Math.min(RANGE, far + 0.5))
        })
        ctx.restore()
      }
    }
    if (layers.coverage && coverLayers) {
      coverLayers.each.forEach((img) => drawFloorImage(ctx, pr, img, cov, layers.pictures ? 0.06 : 0.3))
      drawFloorImage(ctx, pr, coverLayers.overlap, cov, layers.pictures ? 0.14 : 0.45)
    }

    // Shop areas (Counter / Purchasing / Outside Shop): the same for every camera
    if (layers.areas)
      plan.regions.forEach((r) => {
        const color = REGION_COLORS[r.kind]
        const pts: P3[] = r.floor.map((p) => [p.x, p.y, 0])
        ctx.save()
        ctx.fillStyle = color
        ctx.globalAlpha = 0.16
        if (line(ctx, pr, pts, true)) ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = color
        ctx.lineWidth = 2.5
        if (line(ctx, pr, pts, true)) ctx.stroke()
        ctx.restore()
        // label in the middle of the part inside (or, for Outside Shop, outside) the walls
        let sx = 0
        let sy = 0
        let n = 0
        for (let y = Math.floor(b.y0 - 1); y <= b.y1 + 1; y += 0.25)
          for (let x = Math.floor(b.x0 - 1); x <= b.x1 + 3; x += 0.25)
            if (inPoly(r.floor, x, y) && (r.kind === 'Outside Shop') !== inPoly(plan.outline, x, y)) {
              sx += x
              sy += y
              n++
            }
        const at = n ? pr.at(sx / n, sy / n, 0) : null
        if (at) label(ctx, r.name, at[0], at[1], color)
      })

    // 1 m grid inside the shop, and the walls with their lengths
    ctx.save()
    if (line(ctx, pr, walls, true)) ctx.clip()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'
    for (let x = Math.floor(b.x0); x <= b.x1 + 1e-6; x++) if (line(ctx, pr, [[x, b.y0, 0], [x, b.y1, 0]])) ctx.stroke()
    for (let y = Math.floor(b.y0); y <= b.y1 + 1e-6; y++) if (line(ctx, pr, [[b.x0, y, 0], [b.x1, y, 0]])) ctx.stroke()
    ctx.restore()
    ctx.strokeStyle = 'rgba(226,232,240,0.9)'
    ctx.lineWidth = 3
    if (line(ctx, pr, walls, true)) ctx.stroke()
    plan.outline.forEach((p, i) => {
      const q = plan.outline[(i + 1) % plan.outline.length]
      const mid = pr.at((p.x + q.x) / 2, (p.y + q.y) / 2, 0)
      if (mid) label(ctx, `${Math.hypot(q.x - p.x, q.y - p.y).toFixed(2)} m`, mid[0], mid[1], 'rgba(15,23,42,0.85)')
      if (view.mode === '3d') {
        ctx.strokeStyle = 'rgba(226,232,240,0.25)'
        ctx.lineWidth = 1
        if (line(ctx, pr, [[p.x, p.y, 0], [p.x, p.y, CAMERA_HEIGHT]])) ctx.stroke()
      }
    })
    const o = pr.at(0, 0, 0)
    if (o) {
      ctx.font = '600 11px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(226,232,240,0.8)'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText('0,0', o[0] + 4, o[1] + 4)
    }

    // Each camera's own areas (drawn on its picture), placed on the plan with its floor
    if (layers.cameraAreas)
      drafts.forEach((d) => {
        const cal = calOf(d)
        for (const r of d.regions) {
          const fl = regionFloor(cal, r.image)
          if (!fl) continue
          ctx.strokeStyle = REGION_COLORS[r.kind]
          ctx.lineWidth = 1.5
          ctx.setLineDash([4, 4])
          if (line(ctx, pr, fl.map((p) => [p.x, p.y, 0] as P3), true)) ctx.stroke()
          ctx.setLineDash([])
          const c = fl.reduce((s, p) => ({ x: s.x + p.x / fl.length, y: s.y + p.y / fl.length }), { x: 0, y: 0 })
          const at = pr.at(c.x, c.y, 0)
          if (at) label(ctx, `${r.name} · ${d.name}`, at[0], at[1], REGION_COLORS[r.kind])
        }
      })

    // Corners that can be dragged
    if (editCorners) {
      const shapes = [plan.outline, ...plan.regions.map((r) => r.floor)]
      shapes.forEach((pts, s) =>
        pts.forEach((p, i) => {
          const at = pr.at(p.x, p.y, 0)
          if (!at) return
          const sel = corner && corner.shape === s - 1 && corner.i === i
          ctx.fillStyle = sel ? '#facc15' : '#fff'
          ctx.strokeStyle = s === 0 ? '#0f172a' : REGION_COLORS[plan.regions[s - 1].kind]
          ctx.lineWidth = 2
          ctx.fillRect(at[0] - 5, at[1] - 5, 10, 10)
          ctx.strokeRect(at[0] - 5, at[1] - 5, 10, 10)
        }),
      )
    }

    // Cameras: pole, body, view direction, name
    drafts.forEach((d, n) => {
      const color = COLORS[n % COLORS.length]
      const { x, y, yaw } = d.place
      const body = pr.at(x, y, CAMERA_HEIGHT)
      const foot = pr.at(x, y, 0)
      if (!body || !foot) return
      const sel = d.id === selected
      ctx.strokeStyle = color
      ctx.lineWidth = sel ? 3 : 2
      ctx.setLineDash(d.placed || d.dirty ? [] : [5, 4])
      ctx.beginPath()
      ctx.moveTo(foot[0], foot[1])
      ctx.lineTo(body[0], body[1])
      ctx.stroke()
      // where the camera looks: the middle of the picture on the floor
      const mid = floorOf(calOf(d), { x: 0.5, y: 0.5 })
      const aim = mid && Math.hypot(mid.x - x, mid.y - y) < RANGE ? pr.at(mid.x, mid.y, 0) : null
      const rad = (yaw * Math.PI) / 180
      const dir = aim ?? pr.at(x + Math.sin(rad) * 2, y + Math.cos(rad) * 2, 0)
      if (dir) {
        ctx.beginPath()
        ctx.moveTo(body[0], body[1])
        ctx.lineTo(dir[0], dir[1])
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(dir[0], dir[1], 4, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(body[0], body[1], sel ? 10 : 8, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = sel ? '#facc15' : '#fff'
      ctx.stroke()
      label(ctx, `${d.name}${d.placed || d.dirty ? '' : ' (not placed)'}`, body[0], body[1] - 20, color)
    })
  }, [pr, size, plan, drafts, images, layers, cov, coverLayers, selected, view.mode, editCorners, corner, pictureOf])

  // ---------- mouse ----------
  // drag a camera to move it; with "Edit corners & areas" drag a corner;
  // elsewhere drag to turn (3D) / move (top) the view
  const drag = useRef<
    | { kind: 'camera'; id: string; dx: number; dy: number }
    | { kind: 'corner'; refs: CornerRef[] }
    | { kind: 'orbit'; x: number; y: number; view: View }
    | { kind: 'pan'; start: [number, number]; view: View }
    | null
  >(null)

  const screenPoint = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return [e.clientX - box.left, e.clientY - box.top] as const
  }

  const shapePoints = (p: ShopPlan, s: number) => (s < 0 ? p.outline : p.regions[s].floor)

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = screenPoint(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    // nearest camera body under the pointer
    let hit: Draft | null = null
    let best = 16
    for (const d of drafts) {
      const p = pr.at(d.place.x, d.place.y, CAMERA_HEIGHT)
      if (!p) continue
      const dd = Math.hypot(p[0] - sx, p[1] - sy)
      if (dd < best) {
        best = dd
        hit = d
      }
    }
    if (hit) {
      setSelected(hit.id)
      const g = pr.ray(sx, sy, CAMERA_HEIGHT)
      drag.current = { kind: 'camera', id: hit.id, dx: g ? hit.place.x - g[0] : 0, dy: g ? hit.place.y - g[1] : 0 }
      return
    }
    if (editCorners) {
      // nearest corner; corners at the same spot (shared by the walls and areas) move together
      let near: { s: number; i: number; p: Point } | null = null
      let bestC = 12
      for (let s = -1; s < plan.regions.length; s++)
        shapePoints(plan, s).forEach((p, i) => {
          const at = pr.at(p.x, p.y, 0)
          const dd = at ? Math.hypot(at[0] - sx, at[1] - sy) : Infinity
          if (dd < bestC) {
            bestC = dd
            near = { s, i, p }
          }
        })
      if (near) {
        const n = near as { s: number; i: number; p: Point }
        const refs: CornerRef[] = []
        for (let s = -1; s < plan.regions.length; s++)
          shapePoints(plan, s).forEach((p, i) => {
            if (Math.hypot(p.x - n.p.x, p.y - n.p.y) < 0.02) refs.push({ shape: s, i })
          })
        setCorner({ shape: n.s, i: n.i })
        drag.current = { kind: 'corner', refs }
        return
      }
    }
    if (view.mode === '3d' && !e.shiftKey) drag.current = { kind: 'orbit', x: sx, y: sy, view }
    else {
      const g = pr.ray(sx, sy, 0)
      drag.current = g ? { kind: 'pan', start: g, view } : null
    }
  }

  const moveCorners = (refs: CornerRef[], x: number, y: number) => {
    setPlan((p) => {
      const next: ShopPlan = { outline: [...p.outline], regions: p.regions.map((r) => ({ ...r, floor: [...r.floor] })) }
      for (const ref of refs) {
        const pts = ref.shape < 0 ? next.outline : next.regions[ref.shape].floor
        pts[ref.i] = { x: r3(x), y: r3(y) }
      }
      return next
    })
    setPlanDirty(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    const [sx, sy] = screenPoint(e)
    if (d.kind === 'camera') {
      const g = pr.ray(sx, sy, CAMERA_HEIGHT)
      if (!g) return
      const x = Math.round((g[0] + d.dx) * 20) / 20
      const y = Math.round((g[1] + d.dy) * 20) / 20
      updateDraft(d.id, (c) => ({ ...c, place: { ...c.place, x, y } }))
    } else if (d.kind === 'corner') {
      const g = pr.ray(sx, sy, 0)
      if (g) moveCorners(d.refs, Math.round(g[0] * 20) / 20, Math.round(g[1] * 20) / 20)
    } else if (d.kind === 'orbit') {
      setView({
        ...d.view,
        yaw: (d.view.yaw + (sx - d.x) * 0.4 + 360) % 360,
        pitch: Math.min(89.5, Math.max(12, d.view.pitch + (sy - d.y) * 0.3)),
      })
    } else {
      const start = projector(d.view, size.w, size.h)
      const g = start.ray(sx, sy, 0)
      if (!g) return
      setView({ ...d.view, target: [d.view.target[0] - (g[0] - d.start[0]), d.view.target[1] - (g[1] - d.start[1])] })
    }
  }

  const onPointerUp = () => {
    drag.current = null
  }

  // The live video of this camera draws the shared shop areas too
  useEffect(() => {
    if (!loading) onPlan?.(plan.regions)
  }, [plan, loading, onPlan])

  // All corners (walls + areas) at the same floor spot: they move / go together
  const cornersAt = (p: ShopPlan, at: Point) => {
    const refs: CornerRef[] = []
    for (let s = -1; s < p.regions.length; s++)
      shapePoints(p, s).forEach((q, i) => Math.hypot(q.x - at.x, q.y - at.y) < 0.02 && refs.push({ shape: s, i }))
    return refs
  }

  // Add a corner in the middle of an edge (a → b): in every shape that has this edge
  const addCornerOnEdge = (a: Point, b: Point, at: Point) => {
    const same = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) < 0.02
    setPlan((p) => {
      const insert = (pts: Point[]) => {
        for (let i = 0; i < pts.length; i++) {
          const [u, v] = [pts[i], pts[(i + 1) % pts.length]]
          if ((same(u, a) && same(v, b)) || (same(u, b) && same(v, a))) {
            const out = [...pts]
            out.splice(i + 1, 0, { x: r3(at.x), y: r3(at.y) })
            return out
          }
        }
        return pts
      }
      return { outline: insert(p.outline), regions: p.regions.map((r) => ({ ...r, floor: insert(r.floor) })) }
    })
    setPlanDirty(true)
  }

  // Delete the picked corner (from every shape that has a corner there; a shape keeps at least 3)
  const deleteCorner = () => {
    if (!corner) return
    const at = shapePoints(plan, corner.shape)[corner.i]
    if (!at) return
    const refs = cornersAt(plan, at)
    if (refs.some((r) => shapePoints(plan, r.shape).length <= 3)) {
      setMessage('Could not delete: an area or the shop needs at least 3 corners.')
      return
    }
    setPlan((p) => {
      const drop = (pts: Point[], s: number) => pts.filter((_, i) => !refs.some((r) => r.shape === s && r.i === i))
      return { outline: drop(p.outline, -1), regions: p.regions.map((r, s) => ({ ...r, floor: drop(r.floor, s) })) }
    })
    setPlanDirty(true)
    setCorner(null)
  }

  // Double-click on an edge (Edit corners & areas): a new corner there
  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!editCorners) return
    const box = e.currentTarget.getBoundingClientRect()
    const [sx, sy] = [e.clientX - box.left, e.clientY - box.top]
    let best: { a: Point; b: Point; d: number } | null = null
    for (let s = -1; s < plan.regions.length; s++) {
      const pts = shapePoints(plan, s)
      pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length]
        const [pa, pb] = [pr.at(a.x, a.y, 0), pr.at(b.x, b.y, 0)]
        if (!pa || !pb) return
        const [dx, dy] = [pb[0] - pa[0], pb[1] - pa[1]]
        const t = Math.max(0, Math.min(1, ((sx - pa[0]) * dx + (sy - pa[1]) * dy) / (dx * dx + dy * dy || 1)))
        const d = Math.hypot(pa[0] + dx * t - sx, pa[1] + dy * t - sy)
        if (d < 10 && (!best || d < best.d)) best = { a, b, d }
      })
    }
    const g = pr.ray(sx, sy, 0)
    const hit = best as { a: Point; b: Point; d: number } | null
    if (hit && g) addCornerOnEdge(hit.a, hit.b, { x: g[0], y: g[1] })
  }

  // ---------- the 4 camera pictures: the shared areas drawn on each, corners dragged on any ----------
  const picDrag = useRef<{ draft: Draft; refs: CornerRef[]; pick: CornerRef } | null>(null)
  const startPictureDrag = (e: ReactPointerEvent<HTMLElement>, d: Draft, at: Point, s: number, i: number) => {
    e.stopPropagation()
    ;(e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId)
    // the corner is picked when the drag ends: picking it now would open its X / Y boxes
    // and move the pictures under the pointer while dragging
    picDrag.current = { draft: d, refs: cornersAt(plan, at), pick: { shape: s, i } }
  }
  const endPictureDrag = () => {
    if (picDrag.current) setCorner(picDrag.current.pick)
    picDrag.current = null
  }

  // ---------- "Match corners": work out a camera's real place, facing and tilt ----------
  // Every corner of the plan (walls and areas), once each
  const planCorners = useMemo(() => {
    const out: { p: Point; name: string }[] = []
    const add = (p: Point, name: string) => {
      const same = out.find((c) => Math.hypot(c.p.x - p.x, c.p.y - p.y) < 0.02)
      if (same) same.name += ` / ${name}`
      else out.push({ p, name })
    }
    plan.outline.forEach((p, i) => add(p, `Shop corner ${i + 1}`))
    plan.regions.forEach((r) => r.floor.forEach((p, i) => add(p, `${r.name} ${i + 1}`)))
    return out
  }, [plan])
  const [match, setMatch] = useState<{ id: string; pairs: Pair[]; pick: number } | null>(null)
  const startMatch = (d: Draft) => {
    setMatch({ id: d.id, pairs: [], pick: 0 })
    setSelected(d.id)
    setMessage('')
  }
  const clickToMatch = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!match) return
    const c = planCorners[match.pick]
    if (!c) return
    const box = e.currentTarget.getBoundingClientRect()
    const pic = { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height }
    const pairs = [...match.pairs.filter((p) => p.name !== c.name), { floor: c.p, pic, name: c.name }]
    // next corner not matched yet
    let pick = match.pick
    for (let k = 1; k <= planCorners.length; k++) {
      const j = (match.pick + k) % planCorners.length
      if (!pairs.some((p) => p.name === planCorners[j].name)) {
        pick = j
        break
      }
    }
    setMatch({ ...match, pairs, pick })
  }
  const runFit = (d: Draft) => {
    if (!match || match.pairs.length < 3) return
    const img = images[d.id]
    const aspect = img && img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : d.aspect
    const fit = fitCamera({ ...d, aspect }, match.pairs, aspect)
    const pct = fit.miss * 100
    if (pct > 5) {
      setMessage(
        `Could not work out ${d.name}: the clicked corners do not agree (lines would miss them by ${pct.toFixed(1)}% of the picture). ` +
          'Check that each click is on the FLOOR at the right corner, and that the camera is in the right corner of the plan, then try again.',
      )
      return
    }
    updateDraft(d.id, (c) => ({ ...c, aspect, place: fit.place, tilt: fit.tilt }))
    setMessage(
      `${d.name} worked out from ${match.pairs.length} corners: X ${fit.place.x} m, Y ${fit.place.y} m, facing ${fit.place.yaw}°, tilt ${fit.tilt}° ` +
        `(lines miss the clicked spots by ${pct.toFixed(1)}% of the picture on average${pct > 2.5 ? ' — adding more corners makes it surer' : ''}). ` +
        'Check the lines on its picture, then Save.',
    )
    setMatch(null)
  }
  const movePictureDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = picDrag.current
    if (!g) return
    const box = e.currentTarget.getBoundingClientRect()
    const pic = {
      x: Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((e.clientY - box.top) / box.height, 0), 1),
    }
    const f = floorOf(calOf(g.draft), pic) // where that point of the picture is on the shop floor
    if (f && Math.hypot(f.x - g.draft.place.x, f.y - g.draft.place.y) <= RANGE) moveCorners(g.refs, r3(f.x), r3(f.y))
  }

  // Zoom with the mouse wheel (not a passive listener, so the page does not scroll)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setView((v) => ({ ...v, dist: Math.min(80, Math.max(4, v.dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1))) }))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [loading]) // the canvas appears once loading is done

  const updateDraft = useCallback((id: string, change: (d: Draft) => Draft) => {
    setDrafts((list) => list.map((d) => (d.id === id ? { ...change(d), dirty: true } : d)))
  }, [])

  const setMode = (mode: View['mode']) => {
    const b = bounds(plan)
    setView((v) =>
      mode === 'top'
        ? { ...v, mode, yaw: 0, pitch: 89.5, target: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] }
        : { ...v, mode, yaw: 25, pitch: 48 },
    )
  }

  // Put back the shop drawing: walls, areas and the 4 camera places (tilt is kept)
  const useDrawing = () => {
    if (!layout) return
    setPlan({ outline: layout.outline, regions: layout.regions })
    setPlanDirty(true)
    setCorner(null)
    setDrafts((list) =>
      list.map((d) => {
        const c = layout.cameras[d.name]
        return c ? { ...d, place: { x: c.x, y: c.y, yaw: c.yaw }, dirty: true } : d
      }),
    )
    setMessage('Shop drawing put back: walls, Counter / Purchasing / Outside Shop and the camera places. Click Save to keep it.')
  }

  const addArea = (kind: RegionKind) => {
    const b = bounds(plan)
    const cx = (b.x0 + b.x1) / 2
    const cy = (b.y0 + b.y1) / 2
    setPlan((p) => ({
      ...p,
      regions: [
        ...p.regions,
        {
          id: `a${Date.now().toString(36)}`,
          name: kind,
          kind,
          floor: [
            { x: r3(cx - 0.75), y: r3(cy - 0.75) },
            { x: r3(cx + 0.75), y: r3(cy - 0.75) },
            { x: r3(cx + 0.75), y: r3(cy + 0.75) },
            { x: r3(cx - 0.75), y: r3(cy + 0.75) },
          ],
          z_min: 0,
          z_max: kind === 'Outside Shop' ? 2.5 : 2.2,
        },
      ],
    }))
    setPlanDirty(true)
    setEditCorners(true)
  }

  // ---------- save ----------
  const changed = drafts.filter((d) => d.dirty)

  const save = async () => {
    setSaving(true)
    setMessage('')
    const errors: string[] = []
    for (const d of changed) {
      const calibration = calOf(d)
      const value: FloorAreas = {
        version: 3,
        calibration,
        regions: d.regions.map((r) => ({ ...r, floor: regionFloor(calibration, r.image) })),
      }
      const { error } = await supabase.from(TABLES.camera).update({ floor_areas: value }).eq('camera_id', d.id)
      if (error) errors.push(`${d.name}: ${error.message}`)
      else {
        setDrafts((list) => list.map((x) => (x.id === d.id ? { ...x, dirty: false, placed: true, manual: false } : x)))
        onSaved?.(d.id, value)
      }
    }
    if (planDirty && branch) {
      const b = bounds(plan)
      const value = { width: r3(b.x1 - b.x0), depth: r3(b.y1 - b.y0), outline: plan.outline, regions: plan.regions }
      const { error } = await supabase.from(TABLES.branch).update({ floor_plan: value }).eq('branch_id', branch.id)
      if (error) errors.push(`Shop plan: ${error.message} (run supabase/branch_floor_plan.sql once)`)
      else setPlanDirty(false)
    }
    setSaving(false)
    setMessage(
      errors.length
        ? `Could not save: ${errors.join('; ')}`
        : 'Saved. Within a minute the edge box uses this shop plan on every placed camera: the area (Counter / Purchasing / Outside Shop) and In / Out come from where the feet stand on it, and a person seen by 2 cameras at the same floor spot is one person.',
    )
  }

  const sel = drafts.find((d) => d.id === selected) ?? drafts[0]
  const selIndex = sel ? drafts.indexOf(sel) : 0
  const pickedPoints = corner ? shapePoints(plan, corner.shape) : null
  const picked = pickedPoints && corner ? pickedPoints[corner.i] : null
  const pickedName = corner ? (corner.shape < 0 ? 'Shop wall corner' : `${plan.regions[corner.shape]?.name} corner`) : ''

  if (loading && !drafts.length) {
    return (
      <section className="cam-line">
        <h2>3D shop floor map</h2>
        <p className="cam-count-note">Loading the shop and its cameras…</p>
      </section>
    )
  }

  return (
    <section className="cam-line shop-map">
      <div className="cam-line-head">
        <h2>3D shop floor map{branch ? ` — ${branch.name}` : ''}</h2>
        <div className="cam-line-actions">
          <div className="shop-map-switch" role="group" aria-label="View">
            <button type="button" className={view.mode === '3d' ? 'active' : ''} onClick={() => setMode('3d')}>
              3D
            </button>
            <button type="button" className={view.mode === 'top' ? 'active' : ''} onClick={() => setMode('top')}>
              Top view
            </button>
          </div>
          {layout && (
            <button type="button" className="cam-toggle" disabled={saving} onClick={useDrawing}>
              Use shop drawing
            </button>
          )}
          <button
            type="button"
            className="cam-toggle"
            disabled={saving}
            onClick={() => {
              setMessage('')
              setCorner(null)
              setReloadKey((k) => k + 1)
            }}
          >
            Undo changes
          </button>
          <button type="button" className="cam-line-save" disabled={saving || (!changed.length && !planDirty)} onClick={save}>
            {saving ? 'Saving…' : `Save${changed.length || planDirty ? ` (${changed.length + (planDirty ? 1 : 0)})` : ''}`}
          </button>
        </div>
      </div>

      <p className="cam-count-note">
        All cameras of this shop on one floor plan, with the shop areas shared by every camera. Drag a camera to move it
        (3D: drag the floor to turn the view, Shift + drag to move it; Top view: drag to move; wheel to zoom). Each
        camera&apos;s latest picture is laid flat on the floor: when a camera is placed right, its floor tiles, shelves
        and counter line up with the other cameras&apos; pictures. <strong className="shop-map-red">Red</strong> floor is
        seen by 2 or more cameras: a person standing there is one person on the same floor spot, so the edge box counts
        them once. A person&apos;s area and In / Out are only recorded where their feet are seen on the floor.
      </p>

      <div className="shop-map-body">
        <div className="shop-map-canvas" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ width: size.w, height: size.h }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            aria-label="3D floor map of the shop with its cameras and areas"
          />
          <div className="shop-map-layers">
            {(
              [
                ['pictures', 'Camera pictures on the floor'],
                ['coverage', 'Floor each camera sees'],
                ['areas', 'Shop areas'],
                ['cameraAreas', "Each camera's own areas"],
              ] as const
            ).map(([key, text]) => (
              <label key={key}>
                <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers({ ...layers, [key]: e.target.checked })} />
                {text}
              </label>
            ))}
            {layers.pictures && (
              <label>
                Pictures of
                <select aria-label="Camera pictures on the floor of" value={pictureOf} onChange={(e) => setPictureOf(e.target.value as 'selected' | 'all')}>
                  <option value="selected">the selected camera ({sel?.name ?? '—'})</option>
                  <option value="all">all cameras at once</option>
                </select>
              </label>
            )}
          </div>
          {layers.pictures && (
            <p className="cam-count-note">
              Only the floor lies right on the map: walls, shelves and people look stretched away from the camera like long
              shadows. To place a camera, look at its floor tiles, the foot of the counter and the shop front line: turn
              Facing and Tilt until they sit on the map&apos;s walls and areas.
            </p>
          )}
        </div>

        <div className="shop-map-side">
          <h3>Shop &amp; areas</h3>
          <label className="shop-map-check">
            <input
              type="checkbox"
              checked={editCorners}
              onChange={(e) => {
                setEditCorners(e.target.checked)
                setCorner(null)
              }}
            />
            Edit corners &amp; areas (drag the white squares; double-click an edge to add a corner)
          </label>
          {editCorners && picked && corner && (
            <div className="cam-areas-form">
              <label>
                {pickedName} X (m)
                <input
                  type="number"
                  step={0.01}
                  value={picked.x}
                  onChange={(e) => {
                    moveCorners(cornersAt(plan, picked), Number(e.target.value) || 0, picked.y)
                  }}
                />
              </label>
              <label>
                Y (m)
                <input
                  type="number"
                  step={0.01}
                  value={picked.y}
                  onChange={(e) => {
                    moveCorners(cornersAt(plan, picked), picked.x, Number(e.target.value) || 0)
                  }}
                />
              </label>
              <button type="button" className="cam-toggle shop-map-del" onClick={deleteCorner}>
                Delete corner
              </button>
            </div>
          )}
          <ul className="shop-map-areas">
            {plan.regions.map((r, i) => (
              <li key={r.id}>
                <span className="cam-areas-chip" style={{ background: REGION_COLORS[r.kind] }} />
                <input
                  aria-label="Area name"
                  value={r.name}
                  onChange={(e) => {
                    const name = e.target.value
                    setPlan((p) => ({ ...p, regions: p.regions.map((x, j) => (j === i ? { ...x, name } : x)) }))
                    setPlanDirty(true)
                  }}
                />
                <select
                  aria-label="Area kind"
                  value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value as RegionKind
                    setPlan((p) => ({ ...p, regions: p.regions.map((x, j) => (j === i ? { ...x, kind } : x)) }))
                    setPlanDirty(true)
                  }}
                >
                  {REGION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="cam-toggle"
                  aria-label={`Delete ${r.name}`}
                  onClick={() => {
                    setPlan((p) => ({ ...p, regions: p.regions.filter((_, j) => j !== i) }))
                    setPlanDirty(true)
                    setCorner(null)
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="shop-map-add">
            {REGION_KINDS.map((k) => (
              <button key={k} type="button" className="cam-toggle" onClick={() => addArea(k)}>
                + {k}
              </button>
            ))}
          </div>
          {!planColumn && (
            <p className="cam-count-note">Run supabase/branch_floor_plan.sql once to save the shop plan.</p>
          )}

          <h3>Cameras</h3>
          <ul className="shop-map-cams">
            {drafts.map((d, n) => (
              <li key={d.id}>
                <button type="button" className={d.id === sel?.id ? 'active' : ''} onClick={() => setSelected(d.id)}>
                  <span className="cam-areas-chip" style={{ background: COLORS[n % COLORS.length] }} />
                  {d.name}
                  <span className="cam-area-kind">{d.dirty ? 'changed' : d.placed ? 'placed' : 'not placed'}</span>
                </button>
              </li>
            ))}
          </ul>

          {sel && (
            <div className="cam-areas-form shop-map-form">
              <label>
                Camera X (m)
                <input
                  type="number"
                  step={0.05}
                  value={sel.place.x}
                  onChange={(e) => updateDraft(sel.id, (c) => ({ ...c, place: { ...c.place, x: r2(Number(e.target.value) || 0) } }))}
                />
              </label>
              <label>
                Camera Y (m)
                <input
                  type="number"
                  step={0.05}
                  value={sel.place.y}
                  onChange={(e) => updateDraft(sel.id, (c) => ({ ...c, place: { ...c.place, y: r2(Number(e.target.value) || 0) } }))}
                />
              </label>
              <label>
                Facing: {Math.round(sel.place.yaw)}° (0 = along Y, 90 = along X)
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={sel.place.yaw}
                  onChange={(e) => updateDraft(sel.id, (c) => ({ ...c, place: { ...c.place, yaw: Number(e.target.value) } }))}
                />
              </label>
              <label>
                Tilt down: {sel.tilt}°
                <input
                  type="range"
                  min={5}
                  max={85}
                  step={0.5}
                  value={sel.tilt}
                  onChange={(e) => updateDraft(sel.id, (c) => ({ ...c, tilt: Number(e.target.value) }))}
                />
              </label>
              <p className="cam-count-note">
                Height {CAMERA_HEIGHT} m (fixed). Lens and tilt also come from &quot;Adjust 3D floor&quot; on each camera.
                {sel.manual && ' This camera uses a hand-measured floor: saving here switches it to the automatic floor at this place.'}
              </p>
              <span className="shop-map-chip" style={{ borderColor: COLORS[selIndex % COLORS.length] }}>
                Selected: {sel.name}
              </span>
            </div>
          )}

          <h3>Which cameras see each area</h3>
          {overlaps.areas.length ? (
            <ul className="shop-map-overlaps">
              {overlaps.areas.map((a) => (
                <li key={a.region.id}>
                  <strong style={{ color: REGION_COLORS[a.region.kind] }}>{a.region.name}</strong> ({a.m2.toFixed(1)} m²):{' '}
                  {a.cameras.length ? a.cameras.join(', ') : 'no camera'}
                  {a.twice > 0 && <> · seen by 2+ cameras {a.twice.toFixed(1)} m²</>}
                  {a.none > 0.05 && <> · not seen {a.none.toFixed(1)} m²</>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="cam-count-note">No shop areas yet: add Counter, Purchasing and Outside Shop.</p>
          )}

          <h3>Same floor seen by 2 cameras</h3>
          {overlaps.pairs.length ? (
            <ul className="shop-map-overlaps">
              {overlaps.pairs.map((o) => (
                <li key={`${o.a}|${o.b}`}>
                  {o.a} &amp; {o.b}: <strong>{o.m2.toFixed(1)} m²</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cam-count-note">No camera views overlap with the cameras where they are now.</p>
          )}
        </div>
      </div>

      <h3 className="shop-map-pics-title">The shop areas on each camera</h3>
      <p className="cam-count-note">
        The same Counter / Purchasing / Outside Shop areas, drawn on the latest picture of every camera. If a camera&apos;s
        lines do not sit on its real floor, its place / facing / tilt is not right yet: click{' '}
        <strong>Match corners</strong>, then for 3–6 corners of the plan (shop corners where the walls meet the floor,
        corners of the counter) click where each one is on the floor in that picture, and{' '}
        <strong>Work out camera</strong>. When every camera&apos;s lines fit, drag a corner on ANY picture to fine-tune an
        area: it moves on the shop floor, so the map and all the other cameras change with it. Then Save once for all
        cameras.
      </p>
      <div className="shop-map-pics">
        {drafts.map((d, n) => {
          const cal = calOf(d)
          const img = images[d.id]
          const project = (pts: Point[]) => {
            // each edge in small steps: the round Tapo lens bends straight floor lines
            const paths: Point[][] = []
            let cur: Point[] = []
            pts.forEach((a, i) => {
              const b = pts[(i + 1) % pts.length]
              for (let k = 0; k <= 16; k++) {
                const q = toPicture(cal, a.x + ((b.x - a.x) * k) / 16, a.y + ((b.y - a.y) * k) / 16, 0)
                if (q && Math.abs(q.x) < 3 && Math.abs(q.y) < 3) cur.push(q)
                else if (cur.length) {
                  paths.push(cur)
                  cur = []
                }
              }
            })
            if (cur.length) paths.push(cur)
            return paths
          }
          const d2 = (paths: Point[][]) => paths.map((p) => p.map((q, i) => `${i ? 'L' : 'M'}${q.x},${q.y}`).join(' ')).join(' ')
          const shapes = [
            { s: -1, pts: plan.outline, color: '#ffffff', name: 'Shop walls' },
            ...plan.regions.map((r, s) => ({ s, pts: r.floor, color: REGION_COLORS[r.kind], name: r.name })),
          ]
          return (
            <figure className="shop-map-pic" key={d.id}>
              <figcaption>
                <span className="cam-areas-chip" style={{ background: COLORS[n % COLORS.length] }} />
                {d.name}
                {!d.placed && !d.dirty && <span className="cam-area-kind">not placed</span>}
                {match?.id !== d.id && (
                  <button type="button" className="cam-toggle shop-map-match" disabled={!img} onClick={() => startMatch(d)}>
                    Match corners
                  </button>
                )}
              </figcaption>
              {match?.id === d.id && (
                <div className="shop-map-matchbar">
                  <span>
                    {match.pairs.length < 3 ? 'Click where this corner is ON THE FLOOR in the picture:' : 'Next corner (optional):'}
                  </span>
                  <select
                    aria-label="Plan corner to click"
                    value={match.pick}
                    onChange={(e) => setMatch({ ...match, pick: Number(e.target.value) })}
                  >
                    {planCorners.map((c, k) => (
                      <option key={k} value={k}>
                        {match.pairs.some((p) => p.name === c.name) ? '✓ ' : ''}
                        {c.name} ({c.p.x.toFixed(2)}, {c.p.y.toFixed(2)} m)
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="cam-toggle"
                    disabled={!match.pairs.length}
                    onClick={() => setMatch({ ...match, pairs: match.pairs.slice(0, -1) })}
                  >
                    Undo
                  </button>
                  <button type="button" className="cam-toggle" onClick={() => setMatch(null)}>
                    Cancel
                  </button>
                  <button type="button" className="cam-line-save" disabled={match.pairs.length < 3} onClick={() => runFit(d)}>
                    Work out camera ({match.pairs.length})
                  </button>
                </div>
              )}
              <div
                className={`shop-map-pic-box${match?.id === d.id ? ' shop-map-pic-box--match' : ''}`}
                style={{ aspectRatio: String(img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : d.aspect) }}
                onClick={match?.id === d.id ? clickToMatch : undefined}
                onPointerMove={movePictureDrag}
                onPointerUp={endPictureDrag}
                onPointerCancel={endPictureDrag}
              >
                {img ? <img src={img.src} alt={`Latest picture from ${d.name}`} draggable={false} /> : <span>No picture yet</span>}
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                  {layers.areas &&
                    shapes.map((sh) => {
                      const paths = project(sh.pts)
                      return (
                        <g key={sh.s} style={{ stroke: sh.color, fill: sh.color }}>
                          {paths.length === 1 && sh.s >= 0 && <path d={`${d2(paths)} Z`} className="shop-map-pic-fill" />}
                          <path d={d2(paths)} className={sh.s < 0 ? 'shop-map-pic-wall' : 'shop-map-pic-edge'} />
                        </g>
                      )
                    })}
                </svg>
                {match?.id === d.id &&
                  match.pairs.map((p, k) => (
                    <span
                      key={p.name}
                      className="shop-map-pic-pin"
                      style={{ left: `${p.pic.x * 100}%`, top: `${p.pic.y * 100}%` }}
                      title={p.name}
                    >
                      {k + 1}
                    </span>
                  ))}
                {layers.areas &&
                  match?.id !== d.id &&
                  shapes.flatMap((sh) =>
                    sh.pts.map((p, i) => {
                      const q = toPicture(cal, p.x, p.y, 0)
                      if (!q || q.x < -0.01 || q.x > 1.01 || q.y < -0.01 || q.y > 1.01) return null
                      const sel = corner && corner.shape === sh.s && corner.i === i
                      return (
                        <span
                          key={`${sh.s}-${i}`}
                          className={`shop-map-pic-dot${sel ? ' shop-map-pic-dot--sel' : ''}`}
                          style={{ left: `${q.x * 100}%`, top: `${q.y * 100}%`, borderColor: sh.color }}
                          title={`${sh.name} corner (${p.x.toFixed(2)}, ${p.y.toFixed(2)} m)`}
                          onPointerDown={(e) => startPictureDrag(e, d, p, sh.s, i)}
                        />
                      )
                    }),
                  )}
              </div>
            </figure>
          )
        })}
      </div>

      {message && <p className={message.startsWith('Could') ? 'cam-error' : 'cam-count-note'}>{message}</p>}
    </section>
  )
}
