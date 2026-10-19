import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Camera, Point } from './types'
import {
  AUTO_FLOOR,
  CAMERA_HEIGHT,
  REGION_COLORS,
  autoCalibration,
  floorOf,
  readFloorAreas,
  regionFloor,
  toPicture,
  type Calibration,
  type FloorAreas,
  type Region,
} from './space3d'

// ---------- 3D shop floor map ----------
// All cameras of the branch on ONE shop floor plan (metres, seen in 3D or from
// the top). Each camera is placed at its X / Y on the plan, facing a direction,
// 3.25 m high. The map then shows:
//  - the floor each camera sees (coloured), and where 2 or more cameras see the
//    SAME floor (red): a person standing there is seen twice, and the edge box
//    counts them once because both cameras give the same floor spot;
//  - each camera's latest picture laid flat on the floor, so the 4 pictures
//    join into one picture of the shop: when a camera is placed right, the
//    floor tiles, shelves' feet and the counter line up with the other cameras;
//  - the shop areas (Counter, Purchasing, Outside Shop) of every camera as 3D boxes.
// Drag a camera to move it, set its facing / tilt on the right, then Save.
// Saved in camera.floor_areas (calibration.placed = true, place = {x, y, yaw}),
// the shop size in branch.floor_plan (supabase/branch_floor_plan.sql).

type ShopPlan = { width: number; depth: number }
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
  regions: Region[]
  dirty: boolean
}
type View = { mode: '3d' | 'top'; yaw: number; pitch: number; dist: number; target: [number, number] }
type P3 = [number, number, number]

const DEFAULT_PLAN: ShopPlan = { width: 10, depth: 8 }
const COLORS = ['#2563eb', '#16a34a', '#f97316', '#9333ea', '#0891b2', '#ca8a04']
const OVERLAP_COLOR = '#dc2626'
const RANGE = 12 // metres: farther floor is too small in the picture to track people on
const CELL = 0.25 // metres, coverage grid
const MARGIN = 2 // metres around the shop that are drawn
const FOV = (45 * Math.PI) / 180
const r2 = (v: number) => Math.round(v * 100) / 100

// Camera position suggested before a camera is placed: one per shop corner, facing the middle
function suggestedPlace(i: number, plan: ShopPlan) {
  const corners = [
    { x: 0.4, y: 0.4, yaw: 45 },
    { x: plan.width - 0.4, y: 0.4, yaw: 315 },
    { x: plan.width - 0.4, y: plan.depth - 0.4, yaw: 225 },
    { x: 0.4, y: plan.depth - 0.4, yaw: 135 },
  ]
  return corners[i % corners.length]
}

function calOf(d: Draft): Calibration {
  return autoCalibration(d.aspect, { tilt: d.tilt, hfov: d.hfov, k1: d.k1, placed: true, place: d.place }, CAMERA_HEIGHT)
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
  const x0 = -MARGIN
  const y0 = -MARGIN
  const nx = Math.ceil((plan.width + 2 * MARGIN) / CELL)
  const ny = Math.ceil((plan.depth + 2 * MARGIN) / CELL)
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
function drawPictureOnFloor(ctx: CanvasRenderingContext2D, pr: Projector, img: HTMLImageElement, d: Draft, alpha: number) {
  const cal = calOf(d)
  const nx = 18
  const ny = 12
  const grid: ({ s: [number, number]; d: [number, number] } | null)[][] = []
  for (let j = 0; j <= ny; j++) {
    const row: ({ s: [number, number]; d: [number, number] } | null)[] = []
    for (let i = 0; i <= nx; i++) {
      const pic: Point = { x: i / nx, y: j / ny }
      const f = floorOf(cal, pic)
      const ok = f && Math.hypot(f.x - d.place.x, f.y - d.place.y) <= RANGE && toPicture(cal, f.x, f.y, 0)
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
}: {
  camera: Camera
  onSaved?: (cameraId: string, value: FloorAreas) => void
}) {
  const [branch, setBranch] = useState<{ id: string; name: string } | null>(null)
  const [plan, setPlan] = useState<ShopPlan>(DEFAULT_PLAN)
  const [planSaved, setPlanSaved] = useState<ShopPlan>(DEFAULT_PLAN)
  const [planColumn, setPlanColumn] = useState(true) // branch.floor_plan exists (SQL run)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [selected, setSelected] = useState<string>(camera.camera_id)
  const [view, setView] = useState<View>({ mode: '3d', yaw: 25, pitch: 48, dist: 17, target: [5, 4] })
  const [layers, setLayers] = useState({ pictures: true, coverage: true, areas: true })
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
      setBranch({ id: row.branch_id, name: row.branch?.branch_name ?? 'Shop' })

      let shop = DEFAULT_PLAN
      const fp = await supabase.from(TABLES.branch).select('floor_plan').eq('branch_id', row.branch_id).maybeSingle()
      if (cancelled) return
      if (fp.error) setPlanColumn(false)
      else {
        setPlanColumn(true)
        const v = (fp.data as { floor_plan: Partial<ShopPlan> | null } | null)?.floor_plan
        if (v && Number(v.width) > 0 && Number(v.depth) > 0) shop = { width: Number(v.width), depth: Number(v.depth) }
      }
      setPlan(shop)
      setPlanSaved(shop)

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
          return {
            id: c.camera_id,
            name: c.camera_name,
            snapshot: c.last_snapshot_url,
            aspect: cal?.aspect || 16 / 9,
            tilt: auto ? (cal!.tilt ?? AUTO_FLOOR.tilt) : AUTO_FLOOR.tilt,
            hfov: auto ? (cal!.hfov ?? AUTO_FLOOR.hfov) : AUTO_FLOOR.hfov,
            k1: auto ? (cal!.k1 ?? AUTO_FLOOR.k1) : AUTO_FLOOR.k1,
            placed: !!(auto && cal!.placed),
            manual: !!cal && !auto,
            place: auto && cal!.placed && cal!.place ? cal!.place : suggestedPlace(i, shop),
            regions: fa.regions,
            dirty: false,
          }
        }),
      )
      setView((v) => ({ ...v, target: [shop.width / 2, shop.depth / 2], dist: Math.max(shop.width, shop.depth) * 1.7 + 4 }))
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

  // Floor seen by 2+ cameras, per pair (m²)
  const overlaps = useMemo(() => {
    const out: { a: string; b: string; m2: number }[] = []
    for (let i = 0; i < drafts.length; i++)
      for (let j = i + 1; j < drafts.length; j++) {
        let n = 0
        for (let k = 0; k < cov.count.length; k++) if (cov.seen[i][k] && cov.seen[j][k]) n++
        if (n) out.push({ a: drafts[i].name, b: drafts[j].name, m2: n * CELL * CELL })
      }
    let any = 0
    for (let k = 0; k < cov.count.length; k++) if (cov.count[k] >= 2) any++
    return { pairs: out, total: any * CELL * CELL }
  }, [cov, drafts])

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

    // Shop floor
    ctx.fillStyle = '#1e293b'
    if (line(ctx, pr, [[0, 0, 0], [plan.width, 0, 0], [plan.width, plan.depth, 0], [0, plan.depth, 0]], true)) ctx.fill()

    // Cameras' pictures on the floor, then the floor each camera sees and the overlaps
    if (layers.pictures)
      drafts.forEach((d) => {
        const img = images[d.id]
        if (img) drawPictureOnFloor(ctx, pr, img, d, 0.85)
      })
    if (layers.coverage && coverLayers) {
      coverLayers.each.forEach((img) => drawFloorImage(ctx, pr, img, cov, layers.pictures ? 0.16 : 0.32))
      drawFloorImage(ctx, pr, coverLayers.overlap, cov, layers.pictures ? 0.35 : 0.5)
    }

    // 1 m grid and the shop walls
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'
    for (let x = 0; x <= plan.width + 1e-6; x++) if (line(ctx, pr, [[x, 0, 0], [x, plan.depth, 0]])) ctx.stroke()
    for (let y = 0; y <= plan.depth + 1e-6; y++) if (line(ctx, pr, [[0, y, 0], [plan.width, y, 0]])) ctx.stroke()
    ctx.strokeStyle = 'rgba(226,232,240,0.85)'
    ctx.lineWidth = 2
    if (line(ctx, pr, [[0, 0, 0], [plan.width, 0, 0], [plan.width, plan.depth, 0], [0, plan.depth, 0]], true)) ctx.stroke()
    if (view.mode === '3d') {
      ctx.strokeStyle = 'rgba(226,232,240,0.25)'
      ctx.lineWidth = 1
      for (const [x, y] of [[0, 0], [plan.width, 0], [plan.width, plan.depth], [0, plan.depth]] as const)
        if (line(ctx, pr, [[x, y, 0], [x, y, CAMERA_HEIGHT]])) ctx.stroke()
    }
    const o = pr.at(0, 0, 0)
    if (o) {
      ctx.font = '600 11px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(226,232,240,0.8)'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText('0,0', o[0] + 4, o[1] + 4)
    }
    const xEnd = pr.at(plan.width, 0, 0)
    if (xEnd) label(ctx, `X ${plan.width} m`, xEnd[0], xEnd[1] + 14, '#ef4444')
    const yEnd = pr.at(0, plan.depth, 0)
    if (yEnd) label(ctx, `Y ${plan.depth} m`, yEnd[0], yEnd[1] - 14, '#22c55e')

    // Shop areas of every camera (3D boxes); the same area drawn by 2 cameras should land on the same floor
    if (layers.areas)
      drafts.forEach((d) => {
        const cal = calOf(d)
        for (const r of d.regions) {
          const fl = regionFloor(cal, r.image)
          if (!fl) continue
          const color = REGION_COLORS[r.kind]
          ctx.strokeStyle = color
          ctx.fillStyle = color
          ctx.lineWidth = 2
          const bottom: P3[] = fl.map((p) => [p.x, p.y, r.z_min])
          const top: P3[] = fl.map((p) => [p.x, p.y, Math.min(r.z_max, 2.4)])
          ctx.globalAlpha = 0.25
          if (line(ctx, pr, bottom, true)) ctx.fill()
          ctx.globalAlpha = 1
          if (line(ctx, pr, bottom, true)) ctx.stroke()
          if (view.mode === '3d') {
            ctx.globalAlpha = 0.6
            if (line(ctx, pr, top, true)) ctx.stroke()
            bottom.forEach((b, i) => line(ctx, pr, [b, top[i]]) && ctx.stroke())
            ctx.globalAlpha = 1
          }
          const c = fl.reduce((s, p) => ({ x: s.x + p.x / fl.length, y: s.y + p.y / fl.length }), { x: 0, y: 0 })
          const at = pr.at(c.x, c.y, view.mode === '3d' ? Math.min(r.z_max, 2.4) : 0)
          if (at) label(ctx, `${r.name} · ${d.name}`, at[0], at[1], color)
        }
      })

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
  }, [pr, size, plan, drafts, images, layers, cov, coverLayers, selected, view.mode])

  // ---------- mouse: drag a camera to move it, drag elsewhere to turn (3D) / move (top) the view ----------
  const drag = useRef<
    | { kind: 'camera'; id: string; dx: number; dy: number }
    | { kind: 'orbit'; x: number; y: number; view: View }
    | { kind: 'pan'; start: [number, number]; view: View }
    | null
  >(null)

  const screenPoint = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return [e.clientX - box.left, e.clientY - box.top] as const
  }

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
    if (view.mode === '3d' && !e.shiftKey) drag.current = { kind: 'orbit', x: sx, y: sy, view }
    else {
      const g = pr.ray(sx, sy, 0)
      drag.current = g ? { kind: 'pan', start: g, view } : null
    }
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

  const setMode = (mode: View['mode']) =>
    setView((v) =>
      mode === 'top'
        ? { ...v, mode, yaw: 0, pitch: 89.5, target: [plan.width / 2, plan.depth / 2] }
        : { ...v, mode, yaw: 25, pitch: 48 },
    )

  // ---------- save ----------
  const changed = drafts.filter((d) => d.dirty)
  const planChanged = plan.width !== planSaved.width || plan.depth !== planSaved.depth

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
    if (planChanged && branch) {
      const { error } = await supabase.from(TABLES.branch).update({ floor_plan: plan }).eq('branch_id', branch.id)
      if (error) errors.push(`Shop size: ${error.message} (run supabase/branch_floor_plan.sql once)`)
      else setPlanSaved(plan)
    }
    setSaving(false)
    setMessage(
      errors.length
        ? `Could not save: ${errors.join('; ')}`
        : 'Saved. The cameras now share one shop floor: the edge box uses it within a minute, so a person seen by 2 cameras at the same floor spot is one person.',
    )
  }

  const sel = drafts.find((d) => d.id === selected) ?? drafts[0]
  const selIndex = sel ? drafts.indexOf(sel) : 0

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
          <button
            type="button"
            className="cam-toggle"
            disabled={saving}
            onClick={() => {
              setMessage('')
              setReloadKey((k) => k + 1)
            }}
          >
            Undo changes
          </button>
          <button type="button" className="cam-line-save" disabled={saving || (!changed.length && !planChanged)} onClick={save}>
            {saving ? 'Saving…' : `Save placement${changed.length ? ` (${changed.length})` : ''}`}
          </button>
        </div>
      </div>

      <p className="cam-count-note">
        All cameras of this shop on one floor plan. Drag a camera to move it (3D: drag the floor to turn the view, Shift +
        drag to move it; Top view: drag to move; wheel to zoom). Each camera&apos;s latest picture is laid flat on the
        floor: when a camera is placed right, its floor tiles, shelves and counter line up with the other cameras&apos;
        pictures. <strong className="shop-map-red">Red</strong> floor is seen by 2 or more cameras: a person standing
        there is one person on the same floor spot, so the edge box counts them once.
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
            aria-label="3D floor map of the shop with its cameras"
          />
          <div className="shop-map-layers">
            {(
              [
                ['pictures', 'Camera pictures on the floor'],
                ['coverage', 'Floor each camera sees'],
                ['areas', 'Shop areas'],
              ] as const
            ).map(([key, text]) => (
              <label key={key}>
                <input type="checkbox" checked={layers[key]} onChange={(e) => setLayers({ ...layers, [key]: e.target.checked })} />
                {text}
              </label>
            ))}
          </div>
        </div>

        <div className="shop-map-side">
          <h3>Shop size</h3>
          <div className="cam-areas-form">
            <label>
              Width X (m)
              <input
                type="number"
                min={1}
                max={100}
                step={0.1}
                value={plan.width}
                onChange={(e) => setPlan({ ...plan, width: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <label>
              Depth Y (m)
              <input
                type="number"
                min={1}
                max={100}
                step={0.1}
                value={plan.depth}
                onChange={(e) => setPlan({ ...plan, depth: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
          </div>
          {!planColumn && (
            <p className="cam-count-note">Run supabase/branch_floor_plan.sql once to save the shop size.</p>
          )}

          <h3>Cameras</h3>
          <ul className="shop-map-cams">
            {drafts.map((d, n) => (
              <li key={d.id}>
                <button
                  type="button"
                  className={d.id === sel?.id ? 'active' : ''}
                  onClick={() => setSelected(d.id)}
                >
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
                Height {CAMERA_HEIGHT} m (fixed). Lens and tilt come from &quot;Adjust 3D floor&quot; on each camera.
                {sel.manual && ' This camera uses a hand-measured floor: saving here switches it to the automatic floor at this place.'}
              </p>
              <span className="shop-map-chip" style={{ borderColor: COLORS[selIndex % COLORS.length] }}>
                Selected: {sel.name}
              </span>
            </div>
          )}

          <h3>Same floor seen by 2 cameras</h3>
          {overlaps.pairs.length ? (
            <ul className="shop-map-overlaps">
              {overlaps.pairs.map((o) => (
                <li key={`${o.a}|${o.b}`}>
                  {o.a} &amp; {o.b}: <strong>{o.m2.toFixed(1)} m²</strong>
                </li>
              ))}
              <li>
                Total floor seen twice or more: <strong>{overlaps.total.toFixed(1)} m²</strong>
              </li>
            </ul>
          ) : (
            <p className="cam-count-note">No camera views overlap with the cameras where they are now.</p>
          )}
        </div>
      </div>

      {message && <p className={message.startsWith('Could') ? 'cam-error' : 'cam-count-note'}>{message}</p>}
    </section>
  )
}
