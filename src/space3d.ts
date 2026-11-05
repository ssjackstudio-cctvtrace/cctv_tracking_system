import type { Point } from './types'

// 3D floor space of one camera, saved in camera.floor_areas and read by the
// edge box (edge/edge/space3d.py). Same shape on both sides:
//
// {version: 3,
//  calibration: {aspect, image_points: [4 × {x,y} 0–1], floor_points: [4 × {x,y} metres],
//                img_to_floor: [9], projection: [12], camera_height,
//                mesh?: {xs, ys, nodes, poles}},   // the floor dragged by hand (wins when present)
//  regions: [{id, name, kind, image: [{x,y} 0–1], hidden?: [[{x,y} 0–1]], floor: null, z_min, z_max}]}
//
// Each camera has its OWN floor: there is no shared shop plan any more. Areas
// are drawn straight on the picture, so where a person stands never depends on a
// guessed camera height or lens.
//
// FLOOR MESH ("Adjust 3D floor"): polylines the admin drags onto the real floor
//   X lines (red)   — floor lines along X, one per Y mark (a row of dots)
//   Y lines (green) — floor lines along Y, one per X mark (a column of dots)
//   Z poles (blue)  — a dot on the floor, and dots 1 m and 2 m above it
// Picture → floor goes through the dragged cells (the round lens and a wrong
// height / tilt no longer matter); the Z poles tell how tall 1 m looks at each
// spot, which turns the top of the head into a floor spot when the feet are
// hidden behind the counter. Same maths as FloorMesh in edge/edge/space3d.py.
//
// BLIND SPOTS (region.hidden, drawn dotted): floor of an area hidden behind the
// counter / tables where people still walk or stand. A box ending there ends on
// the furniture, so the edge box works out the feet from the head instead.
//
// The floor is made AUTOMATICALLY (autoCalibration): each camera's height above
// the floor (measured, default CAMERA_HEIGHT 3.25 m); the camera's tilt is worked out
// from people walking past (fitTilt), and the Tapo lens width and lens curve
// are known. The Tapo lens is wide and round, so a flat floor looks bent at the
// sides of the picture: the lens curve (k1) is removed before measuring, and
// added back when drawing. From that the box knows where on the floor each
// person stands (X, Y) and how tall they are (Z), and the website draws the
// floor grid and areas as 3D boxes on the picture.
//
// Picture units: u = x * aspect, v = y (square pixels).

// Purchasing / Counter = inside the shop (direction In); Traffic = the walkway
// outside the shop (direction Passed By). Anywhere not inside a drawn area is
// Out of Range (outside the shop) — except on an inside-only camera, where the
// whole picture is inside (no area there = Purchasing).
export type RegionKind = 'Counter' | 'Purchasing' | 'Traffic'
export const REGION_KINDS: RegionKind[] = ['Purchasing', 'Counter', 'Traffic']
export type TrackRegion = RegionKind | 'Out of Range' // cctv_event.track_region
const OLD_KINDS: Record<string, RegionKind> = { 'Outside Shop': 'Traffic' } // saved before Traffic replaced it

export type Region = {
  id: string
  name: string // free text, e.g. "Counter", "POP Display – Shoes"
  kind: RegionKind // written to cctv_event.track_region
  image: Point[] // outline of the floor you can see in the picture (0–1)
  hidden?: Point[][] // blind spots of this area (picture outlines 0–1, drawn dotted)
  floor: Point[] | null // the same outline on the shop floor (metres), when calibrated
  z_min: number // metres
  z_max: number // metres
}

export type Calibration = {
  aspect: number
  image_points: Point[]
  floor_points: Point[]
  img_to_floor: number[] // 3×3, row by row (picture with the lens curve removed → floor)
  projection: number[] // 3×4, row by row (floor 3D → picture before the lens curve)
  camera_height: number // metres
  // Automatic floor (autoCalibration)
  mode?: 'auto'
  tilt?: number // degrees down from level
  hfov?: number // lens width, degrees
  k1?: number // lens curve (negative = round / barrel lens)
  focal?: number // focal length in picture units
  place?: { x: number; y: number; yaw: number } // camera position on its own floor (metres) and facing
  mesh?: FloorMesh // the floor dragged by hand: wins over the automatic floor
}

// The floor dragged by hand (see the top of this file)
export type Pole = { base: Point; marks: Point[] } // marks[k] = picture point (k + 1) metres above base
export type FloorMesh = {
  xs: number[] // metres of the Y lines (ascending)
  ys: number[] // metres of the X lines (ascending)
  nodes: Point[][] // nodes[i][j] = picture (0–1) of floor point (xs[j], ys[i])
  poles: Pole[]
}

// ---------- automatic floor ----------
export const CAMERA_HEIGHT = 3.25 // metres, default camera height (each camera can set its own, measured)
// Tapo C230 lens (spec: 75° across, 41° up-down, 88° corner to corner). As a
// straight-lens width at the centre + lens curve, these give the same angles
// (within 0.2°): 63.6° wide at the centre, curve -0.52.
export const TAPO_C230 = { hfov: 63.6, k1: -0.52 }
export const AUTO_FLOOR = { tilt: 25, ...TAPO_C230 } // tilt: until it is worked out from people

// Real view angles of a lens setting (degrees): across, up-down, corner to corner
export function lensAngles(aspect: number, hfov: number, k1: number) {
  const f = aspect / 2 / Math.tan((hfov * Math.PI) / 360)
  const angle = (r: number) => {
    const n = r / f
    const s = Math.max(1 + k1 * n * n, 0.05)
    return Math.round(((2 * Math.atan(n / s) * 180) / Math.PI) * 10) / 10
  }
  return { across: angle(aspect / 2), upDown: angle(0.5), corner: angle(Math.hypot(aspect / 2, 0.5)) }
}
const PERSON_HEIGHT = 1.65 // metres, average shopper (top of the head)

export type AutoFloor = {
  height?: number // metres from the floor to the camera lens (default CAMERA_HEIGHT)
  tilt: number
  hfov: number
  k1: number
  place?: { x: number; y: number; yaw: number } // default: over (0, 0), facing +Y
}

// Lens curve (division model: straight = picture / (1 + k1·r²), k1 < 0 for a
// round lens). It never folds back: far-away floor bends smoothly towards the
// lens rim, like the wide Tapo picture. Same maths as edge/edge/space3d.py.
// Picture point (0–1) → where a straight lens would show it
function straighten(cal: Pick<Calibration, 'aspect' | 'k1' | 'focal'>, p: Point): Point {
  const { k1 = 0, focal = 0, aspect } = cal
  if (!k1 || !focal) return p
  const cx = aspect / 2
  const nx = (p.x * aspect - cx) / focal
  const ny = (p.y - 0.5) / focal
  const s = Math.max(1 + k1 * (nx * nx + ny * ny), 0.05)
  return { x: (cx + (focal * nx) / s) / aspect, y: 0.5 + (focal * ny) / s }
}

// Straight-lens point → where the round Tapo lens shows it
function bend(cal: Pick<Calibration, 'aspect' | 'k1' | 'focal'>, p: Point): Point {
  const { k1 = 0, focal = 0, aspect } = cal
  if (!k1 || !focal) return p
  const cx = aspect / 2
  const ux = (p.x * aspect - cx) / focal
  const uy = (p.y - 0.5) / focal
  const ru = Math.hypot(ux, uy)
  if (ru < 1e-9) return p
  const rd = (1 - Math.sqrt(1 - 4 * k1 * ru * ru)) / (2 * k1 * ru)
  const s = rd / ru
  return { x: (cx + focal * ux * s) / aspect, y: 0.5 + focal * uy * s }
}

// The whole 3D floor of a camera from its fixed height, tilt and lens.
// Same maths as auto_matrices() on the edge box (edge/edge/space3d.py).
export function autoCalibration(aspect: number, a: AutoFloor, height = a.height ?? CAMERA_HEIGHT): Calibration {
  const f = aspect / 2 / Math.tan((a.hfov * Math.PI) / 360)
  const th = (a.tilt * Math.PI) / 180
  const place = a.place ?? { x: 0, y: 0, yaw: 0 }
  const yaw = (place.yaw * Math.PI) / 180
  const facing = [Math.sin(yaw), Math.cos(yaw), 0]
  const right = [Math.cos(yaw), -Math.sin(yaw), 0]
  const fwd = [Math.cos(th) * facing[0], Math.cos(th) * facing[1], -Math.sin(th)]
  const down = cross(fwd, right)
  const R = [right, down, fwd]
  const C = [place.x, place.y, height]
  const t = R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]))
  const K = [
    [f, 0, aspect / 2],
    [0, f, 0.5],
    [0, 0, 1],
  ]
  const P: M34 = []
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 4; j++) {
      const col = (k: number) => (j < 3 ? R[k][j] : t[k])
      P.push(K[i][0] * col(0) + K[i][1] * col(1) + K[i][2] * col(2))
    }
  const H = [P[0], P[1], P[3], P[4], P[5], P[7], P[8], P[9], P[11]]
  const Hinv = invert3(H) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  const cal: Calibration = {
    aspect: r6(aspect),
    image_points: [],
    floor_points: [],
    img_to_floor: Hinv.map(r6),
    projection: P.map(r6),
    camera_height: height,
    mode: 'auto',
    tilt: a.tilt,
    hfov: a.hfov,
    k1: a.k1,
    focal: r6(f),
    place,
  }
  // 4 floor points in the lower part of the picture (they set where the 1 m grid is drawn)
  for (const top of [0.62, 0.72, 0.82]) {
    const img = [
      { x: 0.2, y: 0.95 },
      { x: 0.8, y: 0.95 },
      { x: 0.8, y: top },
      { x: 0.2, y: top },
    ]
    const floor = img.map((p) => floorOf(cal, p))
    if (floor.every((p) => p && Math.hypot(p.x - place.x, p.y - place.y) < 40)) {
      cal.image_points = img
      cal.floor_points = (floor as Point[]).map((p) => ({ x: r6(p.x), y: r6(p.y) }))
      break
    }
  }
  return cal
}

// The calibration to use: the saved one, or the automatic floor
export function floorOrAuto(cal: Calibration | null, aspect = 16 / 9): Calibration {
  return cal ?? autoCalibration(aspect, { ...AUTO_FLOOR })
}

// Tilt (degrees) that best fits people walking past: their feet are on the
// floor and their heads PERSON_HEIGHT above it, seen from the camera's height.
// samples: feet and top-of-head points (0–1) of full-body people.
export function fitTilt(
  samples: { foot: Point; head: Point }[],
  aspect: number,
  hfov: number,
  k1: number,
  height = CAMERA_HEIGHT,
): number | null {
  const f = aspect / 2 / Math.tan((hfov * Math.PI) / 360)
  const lens = { aspect, k1, focal: f }
  const pts = samples.map((s) => ({ foot: straighten(lens, s.foot), head: straighten(lens, s.head) }))
  if (pts.length < 8) return null
  const h = height
  const top = h - PERSON_HEIGHT
  let best: number | null = null
  let bestErr = Infinity
  for (let deg = 5; deg <= 85; deg += 0.5) {
    const th = (deg * Math.PI) / 180
    const [c, s] = [Math.cos(th), Math.sin(th)]
    const errs: number[] = []
    for (const p of pts) {
      const a = (p.foot.y - 0.5) / f
      const den = a * c + s
      if (den <= 1e-6) continue
      const Y = (h * (c - a * s)) / den // distance along the floor, in front of the camera
      if (Y < 0.3) continue
      const vHead = (top * c - Y * s) / (Y * c + top * s)
      errs.push(Math.abs(vHead - (p.head.y - 0.5) / f))
    }
    if (errs.length < pts.length * 0.6) continue
    errs.sort((x, y) => x - y)
    const med = errs[Math.floor(errs.length / 2)]
    if (med < bestErr) {
      bestErr = med
      best = deg
    }
  }
  return best
}

// inside_only: the whole picture is inside the shop (a camera that never sees the
// walkway, e.g. ABT-03): no Traffic / Out of Range, only In
// Something standing on the floor that hides people's legs (display table, counter,
// mannequin): its box on this camera's picture (0–1). Found by the edge box, saved
// before (the Floor map is gone: draw blind spots instead); the edge box works out the floor spot of a person whose
// legs are hidden behind it from the top of their head.
export type Obstacle = { id: string; label: string; b: [number, number, number, number] }

export type FloorAreas = {
  version: 3
  calibration: Calibration | null
  regions: Region[]
  inside_only?: boolean
  obstacles?: Obstacle[]
}

type M3 = number[] // 9, row by row
type M34 = number[] // 12, row by row

// ---------- small linear algebra ----------
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-12) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

// Homography H (src → dst) from 4 point pairs
export function homography(src: Point[], dst: Point[]): M3 | null {
  if (src.length !== 4 || dst.length !== 4) return null
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(A, b)
  return h ? [...h, 1] : null
}

function invert3(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-15) return null
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2])

// Twice the signed area: 4 points in a row are useless for calibration
function spread(points: Point[]) {
  let best = 0
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      for (let k = j + 1; k < 4; k++) {
        const [a, b, c] = [points[i], points[j], points[k]]
        best = Math.max(best, Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)))
      }
  return best
}

// ---------- calibration ----------
// 4 floor marks: where they are in the picture (0–1) and on the shop floor (metres).
export function calibrate(
  imagePoints: Point[],
  floorPoints: Point[],
  aspect: number,
): { calibration: Calibration } | { error: string } {
  if (imagePoints.length !== 4 || floorPoints.length !== 4) return { error: 'Click exactly 4 floor marks.' }
  if (spread(imagePoints) < 0.002) return { error: 'The 4 marks in the picture are too close together or in one line.' }
  if (spread(floorPoints) < 0.05) return { error: 'The 4 floor positions (metres) are too close together or in one line.' }
  const img = imagePoints.map((p) => ({ x: p.x * aspect, y: p.y }))
  const H = homography(floorPoints, img) // floor (X, Y) → picture (u, v)
  const Hinv = H && invert3(H)
  if (!H || !Hinv) return { error: 'These 4 marks do not make a floor. Check the metres you typed.' }

  // Lens (focal length f) from the floor's right angle: the two floor axes are
  // perpendicular and equally long in 3D. Principal point = picture centre.
  const cx = aspect / 2
  const cy = 0.5
  const col = (j: number) => [H[j] - cx * H[6 + j], H[3 + j] - cy * H[6 + j], H[6 + j]]
  const a = col(0)
  const b = col(1)
  const c = col(2)
  const fOrtho = -(a[0] * b[0] + a[1] * b[1]) / (a[2] * b[2])
  const fNorm = (a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2) / (b[2] ** 2 - a[2] ** 2)
  const ok = (f2: number) => Number.isFinite(f2) && f2 > (0.2 * aspect) ** 2 && f2 < (6 * aspect) ** 2
  const f = Math.sqrt(ok(fOrtho) ? fOrtho : ok(fNorm) ? fNorm : (0.45 * aspect) ** 2) // last: ~100° wide lens

  const kinv = (v: number[]) => [v[0] / f, v[1] / f, v[2]]
  let r1 = kinv(a)
  let r2 = kinv(b)
  let t = kinv(c)
  let lambda = 2 / (norm(r1) + norm(r2))
  if (t[2] * lambda < 0) lambda = -lambda // the floor is in front of the camera
  r1 = r1.map((v) => v * lambda)
  r2 = r2.map((v) => v * lambda)
  t = t.map((v) => v * lambda)
  let r3 = cross(r1, r2)
  const n3 = norm(r3) || 1
  r3 = r3.map((v) => v / n3)
  // camera centre C = -Rᵀ t; Z (height) must point up, towards the camera
  const camZ = () => -(r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2])
  if (camZ() < 0) r3 = r3.map((v) => -v)
  const height = camZ()
  if (!(height > 0.3 && height < 15))
    return { error: `The marks give a camera height of ${height.toFixed(2)} m, which is not possible. Check the 4 marks and metres.` }

  // P = K [r1 r2 r3 t]
  const K = [
    [f, 0, cx],
    [0, f, cy],
    [0, 0, 1],
  ]
  const Rt = [0, 1, 2].map((i) => [r1[i], r2[i], r3[i], t[i]])
  const P: M34 = []
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) P.push(K[i][0] * Rt[0][j] + K[i][1] * Rt[1][j] + K[i][2] * Rt[2][j])

  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  return {
    calibration: {
      aspect: r6(aspect),
      image_points: imagePoints,
      floor_points: floorPoints,
      img_to_floor: Hinv.map(r6),
      projection: P.map(r6),
      camera_height: Math.round(height * 100) / 100,
    },
  }
}

// ---------- using a calibration ----------
// Floor spot (metres) under a picture point that touches the floor
export function floorOf(cal: Calibration, picture: Point): Point | null {
  if (cal.mesh) return meshInverse(cal, picture)
  const m = cal.img_to_floor
  const p = straighten(cal, picture) // remove the lens curve first
  const u = p.x * cal.aspect
  const X = m[0] * u + m[1] * p.y + m[2]
  const Y = m[3] * u + m[4] * p.y + m[5]
  const W = m[6] * u + m[7] * p.y + m[8]
  return Math.abs(W) < 1e-12 ? null : { x: X / W, y: Y / W }
}

// Picture point (0–1) of a 3D point (metres; Z up). null = behind the camera.
export function toPicture(cal: Calibration, X: number, Y: number, Z: number): Point | null {
  if (cal.mesh) {
    const base = meshForward(cal, X, Y)
    return Z === 0 ? base : meshUp(cal, base, Z)
  }
  const P = cal.projection
  const u = P[0] * X + P[1] * Y + P[2] * Z + P[3]
  const v = P[4] * X + P[5] * Y + P[6] * Z + P[7]
  const w = P[8] * X + P[9] * Y + P[10] * Z + P[11]
  return w <= 1e-9 ? null : bend(cal, { x: u / w / cal.aspect, y: v / w }) // add the lens curve
}

// ---------- reading camera.floor_areas ----------
const isPoint = (p: unknown): p is Point =>
  !!p && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number'

export function readFloorAreas(value: unknown): FloorAreas {
  const empty: FloorAreas = { version: 3, calibration: null, regions: [] }
  if (!value || typeof value !== 'object') return empty
  const v = value as Partial<FloorAreas>
  if (v.version !== 3) return empty // saved in an older layout: set the 3D floor and areas again
  const c = v.calibration
  const calibration =
    c && Array.isArray(c.img_to_floor) && c.img_to_floor.length === 9 && Array.isArray(c.projection) && c.projection.length === 12
      ? (() => {
          const { mesh, placed: _placed, ...rest } = c as Calibration & { placed?: unknown } // no shop plan any more
          const ok = readMesh(mesh)
          return ok ? { ...rest, mesh: ok } : rest
        })()
      : null
  const regions = (Array.isArray(v.regions) ? v.regions : [])
    .filter((r) => r && Array.isArray(r.image) && (r.image.length >= 3 || (r.hidden?.length ?? 0) > 0) && r.image.every(isPoint))
    .map((r) => ({ ...r, kind: (OLD_KINDS[r.kind] ?? r.kind) as RegionKind }))
    .map((r, i) => ({
      id: r.id || `r${i + 1}`,
      name: r.name || r.kind || 'Area',
      kind: (REGION_KINDS.includes(r.kind) ? r.kind : 'Purchasing') as RegionKind,
      image: r.image,
      hidden: (Array.isArray(r.hidden) ? r.hidden : []).filter((h) => Array.isArray(h) && h.length >= 3 && h.every(isPoint)),
      floor: Array.isArray(r.floor) && r.floor.length >= 3 ? r.floor : null,
      z_min: Number(r.z_min ?? 0) || 0,
      z_max: Number(r.z_max ?? 2.2) || 2.2,
    }))
  const obstacles = (Array.isArray(v.obstacles) ? v.obstacles : [])
    .filter((o) => o && Array.isArray(o.b) && o.b.length === 4 && o.b.every((n) => typeof n === 'number'))
    .map((o, i) => ({ id: o.id || `o${i + 1}`, label: o.label || 'obstacle', b: o.b }))
  return {
    version: 3,
    calibration,
    regions,
    inside_only: v.inside_only === true,
    ...(obstacles.length ? { obstacles } : {}),
  }
}

// Where an obstacle stands on the floor (metres): the bottom edge of its box is
// its front on the floor; it is drawn depth metres deep, away from the camera.
export function obstacleFootprint(cal: Calibration, o: Obstacle, depth = 0.5): Point[] | null {
  const [x1, , x2, y2] = o.b
  const a = floorOf(cal, { x: x1, y: y2 })
  const b = floorOf(cal, { x: x2, y: y2 })
  const cam = cal.place ?? { x: 0, y: 0 }
  if (!a || !b) return null
  const mx = (a.x + b.x) / 2 - cam.x
  const my = (a.y + b.y) / 2 - cam.y
  const n = Math.hypot(mx, my)
  if (n < 1e-6 || n > 25) return null
  const [dx, dy] = [(mx / n) * depth, (my / n) * depth]
  return [a, b, { x: b.x + dx, y: b.y + dy }, { x: a.x + dx, y: a.y + dy }]
}

// ---------- areas must not overlap ----------
function pointInPolygon(poly: Point[], p: Point) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

// A dot clicked close to a corner or an edge of another area lands exactly on
// it, so two areas can share a border without overlapping. reach = how close,
// as a share of the picture width.
export function snapPoint(p: Point, others: Point[][], aspect: number, reach = 0.015): Point {
  const d = (a: Point, b: Point) => Math.hypot((a.x - b.x) * aspect, a.y - b.y)
  const lim = reach * aspect
  let best: Point | null = null
  let bestD = lim
  for (const poly of others)
    for (const c of poly) {
      const dc = d(p, c)
      if (dc < bestD) [best, bestD] = [c, dc]
    }
  if (best) return { ...best } // corner first
  bestD = lim * 0.7
  for (const poly of others)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const ax = a.x * aspect
      const bx = b.x * aspect
      const len2 = (bx - ax) ** 2 + (b.y - a.y) ** 2
      if (len2 < 1e-12) continue
      const t = Math.min(1, Math.max(0, ((p.x * aspect - ax) * (bx - ax) + (p.y - a.y) * (b.y - a.y)) / len2))
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const dq = d(p, q)
      if (dq < bestD) [best, bestD] = [q, dq]
    }
  return best ? { x: Math.round(best.x * 10000) / 10000, y: Math.round(best.y * 10000) / 10000 } : p
}

// Simplify a closed outline (Douglas–Peucker), tolerance in the same units
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 4) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    const [ax, ay] = pts[i]
    const [bx, by] = pts[j]
    const len = Math.hypot(bx - ax, by - ay) || 1
    let far = -1
    let farD = tol
    for (let k = i + 1; k < j; k++) {
      const dd = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / len
      if (dd > farD) [far, farD] = [k, dd]
    }
    if (far >= 0) {
      keep[far] = 1
      stack.push([i, far], [far, j])
    }
  }
  return pts.filter((_, k) => keep[k])
}

// The drawn area with every part that lies on another area cut off, so areas
// never overlap. Returns the outline unchanged when it does not overlap, the
// trimmed outline when it does (the biggest piece left), or null when almost
// nothing is left (the area is inside other areas).
// Works on a fine grid over the picture (about 480 × 270 cells).
export function trimArea(
  poly: Point[],
  others: Point[][],
  aspect: number,
): { image: Point[]; trimmed: boolean } | null {
  if (poly.length < 3) return null
  const W = 480
  const H = Math.max(120, Math.round(W / aspect))
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  const x0 = Math.max(0, Math.floor(Math.min(...xs) * W) - 1)
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs) * W) + 1)
  const y0 = Math.max(0, Math.floor(Math.min(...ys) * H) - 1)
  const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys) * H) + 1)
  const near = others.filter((o) => o.length >= 3)
  const mask = new Uint8Array(W * H)
  let cut = 0
  let total = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const c = { x: (x + 0.5) / W, y: (y + 0.5) / H }
      if (!pointInPolygon(poly, c)) continue
      total++
      if (near.some((o) => pointInPolygon(o, c))) cut++
      else mask[y * W + x] = 1
    }
  if (total === 0) return null
  if (cut === 0) return { image: poly, trimmed: false }

  // Biggest connected piece left
  const label = new Int32Array(W * H)
  let bestLabel = 0
  let bestSize = 0
  let next = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i0 = y * W + x
      if (!mask[i0] || label[i0]) continue
      next++
      let size = 0
      const queue = [i0]
      label[i0] = next
      while (queue.length) {
        const i = queue.pop()!
        size++
        const cx = i % W
        const cy = (i - cx) / W
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue
          const j = ny * W + nx
          if (mask[j] && !label[j]) {
            label[j] = next
            queue.push(j)
          }
        }
      }
      if (size > bestSize) [bestSize, bestLabel] = [size, next]
    }
  if (bestSize < 30) return null

  // Outline of that piece (Moore neighbour tracing over the cells)
  const on = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && label[y * W + x] === bestLabel
  let sx = -1
  let sy = -1
  for (let y = y0; y <= y1 && sx < 0; y++)
    for (let x = x0; x <= x1; x++)
      if (on(x, y)) {
        sx = x
        sy = y
        break
      }
  const dirs: [number, number][] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]
  const path: [number, number][] = [[sx, sy]]
  let [cx, cy] = [sx, sy]
  let back = 0 // the cell to the west of the start is empty
  let first: [number, number] | null = null
  for (let guard = 0; guard < 400000; guard++) {
    let found = -1
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8
      if (on(cx + dirs[d][0], cy + dirs[d][1])) {
        found = d
        break
      }
    }
    if (found < 0) break // a single cell
    const [nx, ny] = [cx + dirs[found][0], cy + dirs[found][1]]
    // the empty cell checked just before, seen from the new cell
    const [px, py] = [cx + dirs[(found + 7) % 8][0], cy + dirs[(found + 7) % 8][1]]
    back = dirs.findIndex(([dx, dy]) => nx + dx === px && ny + dy === py)
    if (back < 0) back = (found + 4) % 8
    if (cx === sx && cy === sy) {
      if (first && first[0] === nx && first[1] === ny) break // back at the start, same way round
      if (!first) first = [nx, ny]
    }
    ;[cx, cy] = [nx, ny]
    path.push([cx, cy])
  }
  if (path.length > 1 && path[path.length - 1][0] === sx && path[path.length - 1][1] === sy) path.pop()
  if (path.length < 3) return null
  // closed outline: simplify the two halves between the start and the cell farthest from it
  let far = 0
  for (let k = 1; k < path.length; k++)
    if (Math.hypot(path[k][0] - sx, path[k][1] - sy) > Math.hypot(path[far][0] - sx, path[far][1] - sy)) far = k
  const outline = [...simplify(path.slice(0, far + 1), 0.9).slice(0, -1), ...simplify([...path.slice(far), path[0]], 0.9).slice(0, -1)]
  if (outline.length < 3) return null
  const r = (v: number) => Math.round(v * 10000) / 10000
  return { image: outline.map(([x, y]) => ({ x: r((x + 0.5) / W), y: r((y + 0.5) / H) })), trimmed: true }
}

// Region outline in metres from its picture outline (needs a calibration)
export function regionFloor(cal: Calibration | null, image: Point[]): Point[] | null {
  if (!cal) return null
  const pts = image.map((p) => floorOf(cal, p))
  if (pts.some((p) => !p)) return null
  return (pts as Point[]).map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }))
}

export const REGION_COLORS: Record<RegionKind, string> = {
  Counter: '#e11d48',
  Purchasing: '#2563eb',
  Traffic: '#f97316',
}

// ---------- floor mesh (the floor dragged by hand) ----------
// Same maths as FloorMesh in edge/edge/space3d.py. Square picture units: u = x * aspect.
type Sq = [number, number]

function readMesh(value: unknown): FloorMesh | undefined {
  if (!value || typeof value !== 'object') return undefined
  const m = value as Partial<FloorMesh>
  const xs = Array.isArray(m.xs) ? m.xs.map(Number) : []
  const ys = Array.isArray(m.ys) ? m.ys.map(Number) : []
  const nodes = Array.isArray(m.nodes) ? m.nodes : []
  const asc = (a: number[]) => a.every((v, i) => Number.isFinite(v) && (i === 0 || v > a[i - 1]))
  if (xs.length < 2 || ys.length < 2 || !asc(xs) || !asc(ys)) return undefined
  if (nodes.length !== ys.length || !nodes.every((r) => Array.isArray(r) && r.length === xs.length && r.every(isPoint)))
    return undefined
  const poles = (Array.isArray(m.poles) ? m.poles : []).filter(
    (p) => p && isPoint(p.base) && Array.isArray(p.marks) && p.marks.length > 0 && p.marks.every(isPoint),
  )
  return { xs, ys, nodes, poles }
}

// Lens curve in square units (the Z model works with it removed, like the edge box)
function stSq(cal: Calibration, q: Sq): Sq {
  const p = straighten(cal, { x: q[0] / cal.aspect, y: q[1] })
  return [p.x * cal.aspect, p.y]
}
function bdSq(cal: Calibration, q: Sq): Sq {
  const p = bend(cal, { x: q[0] / cal.aspect, y: q[1] })
  return [p.x * cal.aspect, p.y]
}

function cellOf(marks: number[], v: number): [number, number] {
  let k = 0
  while (k < marks.length - 2 && v > marks[k + 1]) k++
  return [k, (v - marks[k]) / (marks[k + 1] - marks[k])]
}

function sqNode(cal: Calibration, i: number, j: number): Sq {
  const p = cal.mesh!.nodes[i][j]
  return [p.x * cal.aspect, p.y]
}

function bilinear(cal: Calibration, i: number, j: number, s: number, t: number): Sq {
  const A = sqNode(cal, i, j)
  const B = sqNode(cal, i, j + 1)
  const D = sqNode(cal, i + 1, j)
  const C = sqNode(cal, i + 1, j + 1)
  return [0, 1].map(
    (k) => (1 - s) * (1 - t) * A[k] + s * (1 - t) * B[k] + s * t * C[k] + (1 - s) * t * D[k],
  ) as Sq
}

function forwardSq(cal: Calibration, X: number, Y: number): Sq {
  const m = cal.mesh!
  const [j, s] = cellOf(m.xs, X)
  const [i, t] = cellOf(m.ys, Y)
  return bilinear(cal, i, j, s, t)
}

// Floor spot (metres) → picture (0–1) on the mesh
export function meshForward(cal: Calibration, X: number, Y: number): Point {
  const [u, v] = forwardSq(cal, X, Y)
  return { x: u / cal.aspect, y: v }
}

function solveCell(cal: Calibration, i: number, j: number, q: Sq): [number, number] | null {
  let s = 0.5
  let t = 0.5
  const A = sqNode(cal, i, j)
  const B = sqNode(cal, i, j + 1)
  const D = sqNode(cal, i + 1, j)
  const C = sqNode(cal, i + 1, j + 1)
  for (let n = 0; n < 20; n++) {
    const [px, py] = bilinear(cal, i, j, s, t)
    const fx = px - q[0]
    const fy = py - q[1]
    const dsx = (1 - t) * (B[0] - A[0]) + t * (C[0] - D[0])
    const dsy = (1 - t) * (B[1] - A[1]) + t * (C[1] - D[1])
    const dtx = (1 - s) * (D[0] - A[0]) + s * (C[0] - B[0])
    const dty = (1 - s) * (D[1] - A[1]) + s * (C[1] - B[1])
    const det = dsx * dty - dsy * dtx
    if (Math.abs(det) < 1e-12) return null
    const ds = (fx * dty - fy * dtx) / det
    const dt = (dsx * fy - dsy * fx) / det
    s -= ds
    t -= dt
    if (Math.abs(ds) < 1e-9 && Math.abs(dt) < 1e-9) break
    if (Math.abs(s) > 50 || Math.abs(t) > 50) return null
  }
  return [s, t]
}

function inverseSq(cal: Calibration, q: Sq): Sq | null {
  const m = cal.mesh!
  let best: [number, number, number, number, number] | null = null
  outer: for (let i = 0; i < m.ys.length - 1; i++)
    for (let j = 0; j < m.xs.length - 1; j++) {
      const st = solveCell(cal, i, j, q)
      if (!st) continue
      const [s, t] = st
      const out = Math.max(0, -s, s - 1) + Math.max(0, -t, t - 1)
      if (!best || out < best[0]) best = [out, i, j, s, t]
      if (out <= 1e-9) break outer
    }
  if (!best) return null
  const [, i, j] = best
  const s = Math.min(Math.max(best[3], -3), 4) // far outside the mesh: not further than 3 cells
  const t = Math.min(Math.max(best[4], -3), 4)
  return [m.xs[j] + s * (m.xs[j + 1] - m.xs[j]), m.ys[i] + t * (m.ys[i + 1] - m.ys[i])]
}

// Picture point (0–1) on the floor → floor spot (metres) on the mesh
export function meshInverse(cal: Calibration, p: Point): Point | null {
  const f = inverseSq(cal, [p.x * cal.aspect, p.y])
  return f ? { x: f[0], y: f[1] } : null
}

// Least squares (normal equations), small systems only
function leastSquares(A: number[][], b: number[]): number[] | null {
  const n = A[0]?.length ?? 0
  if (!n || A.length < n) return null
  const AtA = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => A.reduce((s, row) => s + row[r] * row[c], 0)))
  const Atb = Array.from({ length: n }, (_, r) => A.reduce((s, row, k) => s + row[r] * b[k], 0))
  return solve(AtA, Atb)
}

type MeshModel = { smooth: number[] | null; vertical: [number, number, number] | null }
const models = new WeakMap<FloorMesh, MeshModel>()

// Smooth floor + the vertical model of a mesh (worked out once per mesh)
function meshModel(cal: Calibration): MeshModel {
  const mesh = cal.mesh!
  const known = models.get(mesh)
  if (known) return known
  // Homography floor → picture without the lens curve, fitted to ALL dots: only used for how big
  // 1 m looks at a spot, so a dot a few pixels off does not make the Z sizes jump between cells
  const A: number[][] = []
  const b: number[] = []
  mesh.ys.forEach((Y, i) =>
    mesh.xs.forEach((X, j) => {
      const [u, v] = stSq(cal, sqNode(cal, i, j))
      A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y])
      b.push(u)
      A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y])
      b.push(v)
    }),
  )
  const h = leastSquares(A, b)
  const model: MeshModel = { smooth: h && h.every(Number.isFinite) ? [...h, 1] : null, vertical: null }
  models.set(mesh, model)
  // Vertical lines all point at one spot and shrink with distance like a 1 m step across the
  // floor (s): the top of a z-metre pole on picture point b is p(z) = (b + z·s·G) / (1 + z·s·g).
  // Each pole mark gives 2 equations, linear in (Gx, Gy, g).
  const V: number[][] = []
  const r: number[] = []
  for (const pole of mesh.poles) {
    const bq: Sq = [pole.base.x * cal.aspect, pole.base.y]
    const s = scaleSq(cal, inverseSq(cal, bq))
    if (s <= 1e-9) continue
    const bs = stSq(cal, bq)
    pole.marks.forEach((m, k) => {
      const z = k + 1
      const p = stSq(cal, [m.x * cal.aspect, m.y])
      V.push([z * s, 0, -z * s * p[0]])
      r.push(p[0] - bs[0])
      V.push([0, z * s, -z * s * p[1]])
      r.push(p[1] - bs[1])
    })
  }
  const g = V.length >= 3 ? leastSquares(V, r) : null
  model.vertical = g && g.every(Number.isFinite) && g[1] < 0 ? [g[0], g[1], g[2]] : null
  return model
}

function smoothForward(cal: Calibration, X: number, Y: number): Sq {
  const H = models.get(cal.mesh!)?.smooth
  if (H) {
    const w = H[6] * X + H[7] * Y + H[8]
    if (Math.abs(w) > 1e-12) return [(H[0] * X + H[1] * Y + H[2]) / w, (H[3] * X + H[4] * Y + H[5]) / w]
  }
  return stSq(cal, forwardSq(cal, X, Y))
}

// Picture length (square units, lens curve removed) of 1 m across the picture at floor spot f
function scaleSq(cal: Calibration, f: Sq | null): number {
  if (!f) return 0
  const [X, Y] = f
  const e = 0.5 // over 1 m: smooth across the cells
  const ax = smoothForward(cal, X - e, Y)
  const bx = smoothForward(cal, X + e, Y)
  const ay = smoothForward(cal, X, Y - e)
  const by = smoothForward(cal, X, Y + e)
  const jxx = (bx[0] - ax[0]) / (2 * e)
  const jyx = (bx[1] - ax[1]) / (2 * e)
  const jxy = (by[0] - ay[0]) / (2 * e)
  const jyy = (by[1] - ay[1]) / (2 * e)
  let wx = jyy
  let wy = -jyx // floor direction whose picture is level
  const n = Math.hypot(wx, wy)
  if (n < 1e-12) return 0
  wx /= n
  wy /= n
  return Math.abs(jxx * wx + jxy * wy)
}

// Picture point (0–1) z metres above the floor point base (0–1); null when the mesh has no usable Z pole
export function meshUp(cal: Calibration, base: Point, z: number): Point | null {
  const v = meshModel(cal).vertical
  if (!v) return null
  const bq: Sq = [base.x * cal.aspect, base.y]
  const s = scaleSq(cal, inverseSq(cal, bq))
  if (s <= 1e-9) return null
  const den = 1 + z * s * v[2]
  if (den <= 1e-6) return null
  const b = stSq(cal, bq)
  const q = bdSq(cal, [(b[0] + z * s * v[0]) / den, (b[1] + z * s * v[1]) / den])
  return { x: q[0] / cal.aspect, y: q[1] }
}

// The mesh has a working Z (at least one pole that points up)
export function meshHasZ(cal: Calibration): boolean {
  return !!cal.mesh && !!meshModel(cal).vertical
}

// First mesh: the automatic floor (sliders) laid out as X / Y lines and 3 Z poles, for
// the admin to drag onto the real floor. step = metres between two lines.
export function initialMesh(cal: Calibration, step = 1): FloorMesh {
  const base = { ...cal, mesh: undefined }
  const fl = (x: number, y: number) => floorOf(base, { x, y })
  // the floor between the bottom of the picture and a little above its middle
  const near = [fl(0.1, 0.95), fl(0.5, 0.95), fl(0.9, 0.95)].filter(Boolean) as Point[]
  const far = [fl(0.1, 0.5), fl(0.5, 0.5), fl(0.9, 0.5)].filter(Boolean) as Point[]
  const mid = [fl(0.05, 0.72), fl(0.95, 0.72)].filter(Boolean) as Point[]
  const yLo = near.length ? Math.min(...near.map((p) => p.y)) : 1
  const yHi = far.length ? Math.max(...far.map((p) => p.y)) : yLo + 6
  const xLo = mid.length ? Math.min(...mid.map((p) => p.x)) : -3
  const xHi = mid.length ? Math.max(...mid.map((p) => p.x)) : 3
  const span = (lo: number, hi: number, max: number) => {
    const n = Math.max(2, Math.min(max, Math.floor((hi - lo) / step) + 1))
    // centred on the floor seen, on whole multiples of the spacing (0, 1, 2 m … for 1 m lines)
    const start = Math.round(((lo + hi) / 2 - ((n - 1) * step) / 2) / step) * step
    return Array.from({ length: n }, (_, k) => Math.round((start + k * step) * 100) / 100)
  }
  const xs = span(xLo, xHi, 7)
  const ys = span(yLo, Math.min(yHi, yLo + 7 * step), 7)
  const r4 = (p: Point) => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 })
  const pic = (X: number, Y: number, Z = 0) => toPicture(base, X, Y, Z) ?? { x: 0.5, y: 0.5 }
  const nodes = ys.map((Y) => xs.map((X) => r4(pic(X, Y))))
  const at = (fx: number, fy: number) => ({
    X: xs[0] + (xs[xs.length - 1] - xs[0]) * fx,
    Y: ys[0] + (ys[ys.length - 1] - ys[0]) * fy,
  })
  const poles = [at(0.2, 0.3), at(0.8, 0.3), at(0.5, 0.75)].map(({ X, Y }) => ({
    base: r4(pic(X, Y)),
    marks: [r4(pic(X, Y, 1)), r4(pic(X, Y, 2))],
  }))
  return { xs, ys, nodes, poles }
}

// A mesh with one more / one less X line (row, at the far end) or Y line (column, at the right)
export function meshAddLine(cal: Calibration, axis: 'X' | 'Y'): FloorMesh {
  const m = cal.mesh!
  const r4 = (p: Point) => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 })
  if (axis === 'X') {
    const step = m.ys[m.ys.length - 1] - m.ys[m.ys.length - 2]
    const Y = Math.round((m.ys[m.ys.length - 1] + step) * 100) / 100
    return { ...m, ys: [...m.ys, Y], nodes: [...m.nodes, m.xs.map((X) => r4(meshForward(cal, X, Y)))] }
  }
  const step = m.xs[m.xs.length - 1] - m.xs[m.xs.length - 2]
  const X = Math.round((m.xs[m.xs.length - 1] + step) * 100) / 100
  return { ...m, xs: [...m.xs, X], nodes: m.nodes.map((row, i) => [...row, r4(meshForward(cal, X, m.ys[i]))]) }
}

export function meshRemoveLine(m: FloorMesh, axis: 'X' | 'Y'): FloorMesh {
  if (axis === 'X') return m.ys.length <= 2 ? m : { ...m, ys: m.ys.slice(0, -1), nodes: m.nodes.slice(0, -1) }
  return m.xs.length <= 2 ? m : { ...m, xs: m.xs.slice(0, -1), nodes: m.nodes.map((r) => r.slice(0, -1)) }
}

// A new Z pole in the middle of the mesh (marks from the current Z model, or straight up)
export function meshNewPole(cal: Calibration): Pole {
  const m = cal.mesh!
  const X = (m.xs[0] + m.xs[m.xs.length - 1]) / 2
  const Y = (m.ys[0] + m.ys[m.ys.length - 1]) / 2
  const base = meshForward(cal, X, Y)
  const up = (z: number) => meshUp(cal, base, z) ?? { x: base.x, y: base.y - 0.12 * z }
  return { base, marks: [up(1), up(2)] }
}
