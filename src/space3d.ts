import type { Point } from './types'

// 3D floor space of one camera, saved in camera.floor_areas and read by the
// edge box (edge/edge/space3d.py). Same shape on both sides:
//
// {version: 3,
//  calibration: {aspect, image_points: [4 × {x,y} 0–1], floor_points: [4 × {x,y} metres],
//                img_to_floor: [9], projection: [12], camera_height},
//  regions: [{id, name, kind, image: [{x,y} 0–1], floor: [{x,y} metres] | null, z_min, z_max}]}
//
// The floor is made AUTOMATICALLY (autoCalibration): every camera hangs at the
// same fixed height (CAMERA_HEIGHT, 3.25 m); the camera's tilt is worked out
// from people walking past (fitTilt), and the Tapo lens width and lens curve
// are known. The Tapo lens is wide and round, so a flat floor looks bent at the
// sides of the picture: the lens curve (k1) is removed before measuring, and
// added back when drawing. From that the box knows where on the floor each
// person stands (X, Y) and how tall they are (Z), and the website draws the
// floor grid and areas as 3D boxes on the picture.
//
// Picture units: u = x * aspect, v = y (square pixels).

export type RegionKind = 'Counter' | 'Purchasing' | 'Outside Shop'
export const REGION_KINDS: RegionKind[] = ['Counter', 'Purchasing', 'Outside Shop']

export type Region = {
  id: string
  name: string // free text, e.g. "Counter", "POP Display – Shoes"
  kind: RegionKind // written to cctv_event.track_region
  image: Point[] // outline on the floor in the picture (0–1)
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
  placed?: boolean // camera placed on the shop plan: floor shared with the other cameras
  place?: { x: number; y: number; yaw: number } // camera position (metres) and facing (degrees, 0 = +Y)
}

// ---------- automatic floor ----------
export const CAMERA_HEIGHT = 3.25 // metres, every camera (fixed)
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
  tilt: number
  hfov: number
  k1: number
  placed: boolean
  place: { x: number; y: number; yaw: number }
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
export function autoCalibration(aspect: number, a: AutoFloor, height = CAMERA_HEIGHT): Calibration {
  const f = aspect / 2 / Math.tan((a.hfov * Math.PI) / 360)
  const th = (a.tilt * Math.PI) / 180
  const yaw = (a.place.yaw * Math.PI) / 180
  const facing = [Math.sin(yaw), Math.cos(yaw), 0]
  const right = [Math.cos(yaw), -Math.sin(yaw), 0]
  const fwd = [Math.cos(th) * facing[0], Math.cos(th) * facing[1], -Math.sin(th)]
  const down = cross(fwd, right)
  const R = [right, down, fwd]
  const C = [a.place.x, a.place.y, height]
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
    placed: a.placed,
    place: a.place,
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
    if (floor.every((p) => p && Math.hypot(p.x - a.place.x, p.y - a.place.y) < 40)) {
      cal.image_points = img
      cal.floor_points = (floor as Point[]).map((p) => ({ x: r6(p.x), y: r6(p.y) }))
      break
    }
  }
  return cal
}

// The calibration to use: the saved one, or the automatic floor
export function floorOrAuto(cal: Calibration | null, aspect = 16 / 9): Calibration {
  return cal ?? autoCalibration(aspect, { ...AUTO_FLOOR, placed: false, place: { x: 0, y: 0, yaw: 0 } })
}

// Tilt (degrees) that best fits people walking past: their feet are on the
// floor and their heads PERSON_HEIGHT above it, seen from CAMERA_HEIGHT.
// samples: feet and top-of-head points (0–1) of full-body people.
export function fitTilt(samples: { foot: Point; head: Point }[], aspect: number, hfov: number, k1: number): number | null {
  const f = aspect / 2 / Math.tan((hfov * Math.PI) / 360)
  const lens = { aspect, k1, focal: f }
  const pts = samples.map((s) => ({ foot: straighten(lens, s.foot), head: straighten(lens, s.head) }))
  if (pts.length < 8) return null
  const h = CAMERA_HEIGHT
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

export type FloorAreas = { version: 3; calibration: Calibration | null; regions: Region[] }

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
      ? c
      : null
  const regions = (Array.isArray(v.regions) ? v.regions : [])
    .filter((r) => r && Array.isArray(r.image) && r.image.length >= 3 && r.image.every(isPoint))
    .map((r, i) => ({
      id: r.id || `r${i + 1}`,
      name: r.name || r.kind || 'Area',
      kind: (REGION_KINDS.includes(r.kind) ? r.kind : 'Purchasing') as RegionKind,
      image: r.image,
      floor: Array.isArray(r.floor) && r.floor.length >= 3 ? r.floor : null,
      z_min: Number(r.z_min ?? 0) || 0,
      z_max: Number(r.z_max ?? 2.2) || 2.2,
    }))
  return { version: 3, calibration, regions }
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
  'Outside Shop': '#f97316',
}
