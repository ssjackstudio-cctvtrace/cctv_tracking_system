import type { CountLine, Point } from './types'

// Count line made of many dots. The line is stretched straight out at both
// ends to the picture border, which cuts the picture into two areas; the admin
// labels one of them "In". Same steps as edge/edge/line_counter.py on the box,
// so the website shows exactly the areas the box counts with.
// All points are 0–1 fractions of the picture width / height.

function exitPoint(p: Point, d: Point): Point {
  let best: number | null = null
  for (const axis of ['x', 'y'] as const) {
    let s: number | null = null
    if (d[axis] > 1e-12) s = (1 - p[axis]) / d[axis]
    else if (d[axis] < -1e-12) s = -p[axis] / d[axis]
    if (s !== null && (best === null || s < best)) best = s
  }
  if (best === null) return p
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1)
  return { x: clamp(p.x + best * d.x), y: clamp(p.y + best * d.y) }
}

// Position along the picture border, clockwise from the top-left corner (0–4)
function perimeterPos({ x, y }: Point) {
  const eps = 1e-6
  if (y <= eps) return x
  if (x >= 1 - eps) return 1 + y
  if (y >= 1 - eps) return 2 + (1 - x)
  return 3 + (1 - y)
}

const CORNERS: Point[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: 0, y: 0 },
]
const mod4 = (v: number) => ((v % 4) + 4) % 4

function walkBorder(a: Point, b: Point, clockwise: boolean): Point[] {
  const ta = perimeterPos(a)
  const tb = perimeterPos(b)
  const span = clockwise ? mod4(tb - ta) : mod4(ta - tb)
  return CORNERS.map((corner, i) => ({ corner, dist: clockwise ? mod4(i + 1 - ta) : mod4(ta - (i + 1)) }))
    .filter(({ dist }) => dist > 0 && dist < span)
    .sort((p, q) => p.dist - q.dist)
    .map(({ corner }) => corner)
}

// The drawn line, stretched to the picture border at both ends
export function extendedLine(points: Point[]): Point[] {
  if (points.length < 2) return points
  const [p0, p1] = points
  const pn = points[points.length - 1]
  const pm = points[points.length - 2]
  return [
    exitPoint(p0, { x: p0.x - p1.x, y: p0.y - p1.y }),
    ...points,
    exitPoint(pn, { x: pn.x - pm.x, y: pn.y - pm.y }),
  ]
}

// The two areas (polygons) the stretched line cuts the picture into
export function splitAreas(points: Point[]): [Point[], Point[]] {
  const path = extendedLine(points)
  const start = path[0]
  const end = path[path.length - 1]
  return [[...path, ...walkBorder(end, start, true)], [...path, ...walkBorder(end, start, false)]]
}

export function inside(poly: Point[], { x, y }: Point) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

// In area = the area that contains the point the admin clicked as "In"
export function areasFor(points: Point[], inPoint: Point): { inZone: Point[]; outZone: Point[] } {
  const [a, b] = splitAreas(points)
  return inside(a, inPoint) ? { inZone: a, outZone: b } : { inZone: b, outZone: a }
}

// Middle of a polygon (for the IN / OUT labels)
export function centroid(poly: Point[]): Point {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y
    area += f
    cx += (poly[j].x + poly[i].x) * f
    cy += (poly[j].y + poly[i].y) * f
  }
  if (Math.abs(area) < 1e-9) {
    const n = poly.length || 1
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n }
  }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}

// A point well inside the area (centroid, or a nearby point when the centroid
// falls outside an odd-shaped area)
export function pointInside(poly: Point[]): Point {
  const c = centroid(poly)
  if (inside(poly, c)) return c
  for (let r = 0.05; r <= 0.5; r += 0.05)
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const p = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }
      if (p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1 && inside(poly, p)) return p
    }
  return c
}

export type CountAreas = { points: Point[]; inPoint: Point; inZone: Point[]; outZone: Point[] }

// camera.count_line → dots + In / Out areas. Also reads the older two-point
// line ({start, end}), whose In side was the side the green arrow pointed to.
export function readCountLine(line: CountLine | null | undefined): CountAreas | null {
  if (!line) return null
  if ('points' in line) {
    if (!line.points || line.points.length < 2 || !line.in_point) return null
    return { points: line.points, inPoint: line.in_point, ...areasFor(line.points, line.in_point) }
  }
  if (!line.start || !line.end) return null
  const { start: s, end: e } = line
  const len = Math.hypot(e.x - s.x, e.y - s.y)
  if (len === 0) return null
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1)
  const inPoint = {
    x: clamp((s.x + e.x) / 2 + ((e.y - s.y) / len) * 0.05),
    y: clamp((s.y + e.y) / 2 - ((e.x - s.x) / len) * 0.05),
  }
  return { points: [s, e], inPoint, ...areasFor([s, e], inPoint) }
}
