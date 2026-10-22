import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent } from 'react'
import { supabase } from './lib/supabase'
import { TABLES } from './Usetable'
import type { Camera, Point } from './types'
import type { LiveFrame } from './Livevideo'
import {
  AUTO_FLOOR,
  REGION_COLORS,
  autoCalibration,
  floorOf,
  obstacleFootprint,
  readFloorAreas,
  toPicture,
  trimArea,
  type Calibration,
  type FloorAreas,
  type Obstacle,
  type Region,
  type RegionKind,
} from './space3d'

// ---------- Shop Floor Map ----------
// The shop seen from above, in metres, with every camera of this edge box:
// where it hangs, which way it looks, and the shop areas drawn on its picture
// (Purchasing / Counter / Traffic) laid onto the floor. So you can check that
// the areas of the 4 cameras land where they really are in the shop, and fix
// them: move / turn a camera, or drag the corners of its areas on the map
// (the corner moves on the camera picture too). Things the edge box found
// standing on the floor (tables, the counter, mannequins) show as obstacles;
// saved obstacles let the box keep the floor spot of people whose legs are
// hidden behind them.
// Plan axes: X along the bottom wall (ABT-04 → ABT-03), Y up the left wall
// (ABT-04 → ABT-01), so a camera's Facing (0° = +Y) works like on the edge box.

type Plan = {
  title: string
  shop: Point[] // shop walls
  walkway: Point[] // mall walkway in front of the glass shop front (Traffic)
  areas: { kind: RegionKind; name: string; pts: Point[] }[] // areas as marked on the drawing
  furniture: { name: string; pts: Point[] }[]
  cameras: Record<string, { x: number; y: number; yaw: number }> // suggested places, from the drawing
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]

// JackStudio @ Aeon Bukit Tinggi: furniture plan layout (1:35), 7314 mm along the
// back wall, 5890 mm deep, 4208 mm along the front wall, glass front on the diagonal
const BUKIT_TINGGI: Plan = {
  title: 'Furniture plan layout – JackStudio @ Aeon Bukit Tinggi',
  shop: [
    { x: 0, y: 0 },
    { x: 4.208, y: 0 },
    { x: 7.314, y: 5.89 },
    { x: 0, y: 5.89 },
  ],
  walkway: [
    { x: 4.208, y: 0 },
    { x: 7.314, y: 5.89 },
    { x: 10.2, y: 4.35 },
    { x: 7.05, y: -1.8 },
  ],
  areas: [
    {
      kind: 'Counter',
      name: 'Counter',
      pts: [
        { x: 1.04, y: 0 },
        { x: 4.208, y: 0 },
        { x: 5.17, y: 1.82 },
        { x: 4.24, y: 2.43 },
        { x: 1.04, y: 2.43 },
      ],
    },
    {
      kind: 'Purchasing',
      name: 'Purchasing',
      pts: [
        { x: 0, y: 0 },
        { x: 1.04, y: 0 },
        { x: 1.04, y: 2.43 },
        { x: 4.24, y: 2.43 },
        { x: 5.17, y: 1.82 },
        { x: 7.314, y: 5.89 },
        { x: 0, y: 5.89 },
      ],
    },
  ],
  furniture: [
    { name: 'Bag display wall cabinet', pts: rect(0.5, 5.39, 6.9, 5.89) },
    { name: 'Wall cabinet', pts: rect(0, 1.6, 0.45, 5.39) },
    { name: 'Product display table', pts: rect(1.56, 3.13, 2.81, 4.04) },
    { name: 'Product display table set', pts: rect(4.4, 3.0, 5.86, 4.1) },
    { name: 'Cashier counter', pts: rect(1.87, 1.3, 3.99, 2.31) },
  ],
  cameras: {
    'ABT-01': { x: 0.25, y: 5.54, yaw: 125 },
    'ABT-02': { x: 7.0, y: 5.54, yaw: 215 },
    'ABT-03': { x: 3.89, y: 0.16, yaw: 330 },
    'ABT-04': { x: 0.25, y: 0.16, yaw: 30 },
  },
}

const planFor = (branchName: string | null | undefined, cameraName: string) =>
  /bukit\s*tinggi/i.test(branchName ?? '') || /^ABT-/i.test(cameraName) ? BUKIT_TINGGI : null

const REACH = 14 // metres: areas further from the camera than this are cut at this distance on the map
const LIVE_REFRESH_MS = 500
const OBSTACLE_COLOR = '#7c3aed'

type MapCamera = Pick<Camera, 'camera_id' | 'camera_name' | 'floor_areas'>
type Place = { x: number; y: number; yaw: number }
type Draft = { place: Place; tilt: number; regions: Region[] }

// Picture outline → outline on the shop floor (metres). Edges are followed in
// small steps (the round lens bends them); far-away parts are cut at REACH.
function floorOutline(cal: Calibration, image: Point[]): Point[] {
  const cam = cal.place ?? { x: 0, y: 0, yaw: 0 }
  const yaw = ((cal.place?.yaw ?? 0) * Math.PI) / 180
  const facing = { x: Math.sin(yaw), y: Math.cos(yaw) }
  const out: Point[] = []
  for (let i = 0; i < image.length; i++) {
    const [a, b] = [image[i], image[(i + 1) % image.length]]
    for (let s = 0; s < 10; s++) {
      const t = s / 10
      const p = floorOf(cal, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      if (!p) continue
      let vx = p.x - cam.x
      let vy = p.y - cam.y
      if (vx * facing.x + vy * facing.y <= 0) {
        // above the horizon: the floor maths lands behind the camera, so it is far away in front
        vx = -vx
        vy = -vy
      }
      const d = Math.hypot(vx, vy)
      const k = d > REACH || vx * facing.x + vy * facing.y <= 0 ? REACH / Math.max(d, 1e-6) : 1
      out.push({ x: cam.x + vx * k, y: cam.y + vy * k })
    }
  }
  return out
}

const pts = (list: Point[]) => list.map((p) => `${p.x.toFixed(3)},${(-p.y).toFixed(3)}`).join(' ')

// The calibration shown on the map for a camera: its saved floor when it is
// placed on the plan; otherwise the same floor put at the suggested place.
function mapCalibration(fa: FloorAreas, suggested: Place | undefined, draft?: Draft | null): Calibration | null {
  const cal = fa.calibration
  const aspect = cal?.aspect ?? 16 / 9
  const lens = { hfov: cal?.hfov ?? AUTO_FLOOR.hfov, k1: cal?.k1 ?? AUTO_FLOOR.k1 }
  if (draft) return autoCalibration(aspect, { tilt: draft.tilt, ...lens, placed: true, place: draft.place })
  if (cal && cal.placed) return cal
  if (cal && cal.mode !== 'auto') return null // hand calibration not on the plan: cannot be moved here
  if (!suggested) return null
  return autoCalibration(aspect, { tilt: cal?.tilt ?? AUTO_FLOOR.tilt, ...lens, placed: true, place: suggested })
}

export function FloorMap({
  camera,
  branchName,
  areas,
  live,
  onSaved,
}: {
  camera: Camera
  branchName?: string | null
  areas: FloorAreas // this camera's saved floor + areas (newest)
  live: MutableRefObject<LiveFrame | null> // newest live picture of this camera (people, obstacles)
  onSaved: (fa: FloorAreas) => void
}) {
  const plan = planFor(branchName, camera.camera_name)
  const [others, setOthers] = useState<MapCamera[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [, setTick] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ kind: 'camera' } | { kind: 'corner'; region: string; index: number } | null>(null)

  // The other cameras of this edge box (their areas are shown too)
  useEffect(() => {
    if (!camera.edge_device_id) return
    let cancelled = false
    supabase
      .from(TABLES.camera)
      .select('camera_id, camera_name, floor_areas')
      .eq('edge_device_id', camera.edge_device_id)
      .order('camera_name')
      .then(({ data }) => {
        if (!cancelled) setOthers(((data ?? []) as MapCamera[]).filter((c) => c.camera_id !== camera.camera_id))
      })
    return () => {
      cancelled = true
    }
  }, [camera.edge_device_id, camera.camera_id])

  // People and obstacles on the live video: redraw twice a second
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), LIVE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const suggested = plan?.cameras[camera.camera_name.toUpperCase()]
  const cal = useMemo(() => mapCalibration(areas, suggested, draft), [areas, suggested, draft])
  const regions = draft?.regions ?? areas.regions
  const placedNow = !!areas.calibration?.placed

  const otherLayers = others.map((c) => {
    const fa = readFloorAreas(c.floor_areas)
    const oc = mapCalibration(fa, plan?.cameras[c.camera_name.toUpperCase()])
    return { camera: c, fa, cal: oc }
  })

  const frame = live.current
  const liveObstacles = (frame?.obstacles ?? []) as Obstacle[]
  const savedObstacles = areas.obstacles ?? []

  // Live people of this camera on the map, and how many stand in each kind of area now
  const people = (frame?.boxes ?? [])
    .filter((b) => b.visit || b.full)
    .map((b) => {
      let spot: Point | null = null
      if (b.xyz && placedNow && !draft) spot = { x: b.xyz[0], y: b.xyz[1] }
      else if (cal && !b.est) spot = floorOf(cal, { x: (b.b[0] + b.b[2]) / 2, y: b.b[3] })
      return { box: b, spot }
    })
  const occupancy = { Purchasing: 0, Counter: 0, Traffic: 0 } as Record<RegionKind, number>
  for (const p of people) if (p.box.kind && p.box.kind in occupancy) occupancy[p.box.kind as RegionKind]++

  // Map bounds: the plan, the cameras and the areas (metres), 0.6 m margin
  const view = useMemo(() => {
    const all: Point[] = [...(plan ? [...plan.shop, ...plan.walkway] : [])]
    if (cal?.place) all.push(cal.place)
    for (const l of otherLayers) if (l.cal?.place) all.push(l.cal.place)
    if (!plan && cal) for (const r of regions) all.push(...floorOutline(cal, r.image))
    if (!all.length) all.push({ x: -3, y: -3 }, { x: 3, y: 3 })
    const xs = all.map((p) => p.x)
    const ys = all.map((p) => p.y)
    const m = 0.6
    return { x0: Math.min(...xs) - m, x1: Math.max(...xs) + m, y0: Math.min(...ys) - m, y1: Math.max(...ys) + m }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, cal, others, regions])

  const toPlan = (e: PointerEvent<SVGElement>): Point | null => {
    const svg = svgRef.current
    const m = svg?.getScreenCTM()
    if (!svg || !m) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { x: p.x, y: -p.y }
  }

  const startEdit = () => {
    const c = areas.calibration
    setDraft({
      place: c?.placed && c.place ? { ...c.place } : { ...(suggested ?? { x: 0, y: 0, yaw: 0 }) },
      tilt: c?.tilt ?? AUTO_FLOOR.tilt,
      regions: areas.regions.map((r) => ({ ...r, image: [...r.image] })),
    })
    setMessage('Drag the camera (yellow) to move it, change Facing / Tilt, or drag the white corners of its areas.')
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d || !draft || !cal) return
    const p = toPlan(e)
    if (!p) return
    if (d.kind === 'camera') {
      setDraft({ ...draft, place: { ...draft.place, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 } })
      return
    }
    // a corner dragged on the floor = the same corner moved on the camera picture
    const img = toPicture(cal, p.x, p.y, 0)
    if (!img || img.x < -0.02 || img.x > 1.02 || img.y < -0.02 || img.y > 1.02) return
    const q = { x: Math.min(Math.max(Math.round(img.x * 10000) / 10000, 0), 1), y: Math.min(Math.max(Math.round(img.y * 10000) / 10000, 0), 1) }
    setDraft({
      ...draft,
      regions: draft.regions.map((r) =>
        r.id === d.region ? { ...r, image: r.image.map((pt, i) => (i === d.index ? q : pt)) } : r,
      ),
    })
  }

  const store = async (next: FloorAreas, done: string) => {
    setSaving(true)
    setMessage('')
    const value: FloorAreas = {
      version: 3,
      calibration: next.calibration,
      regions: next.regions.map((r) => ({ ...r, floor: null })), // flat: the edge box checks the feet on the picture
      inside_only: next.inside_only === true,
      ...(next.obstacles?.length ? { obstacles: next.obstacles } : {}),
    }
    const { error } = await supabase.from(TABLES.camera).update({ floor_areas: value }).eq('camera_id', camera.camera_id)
    setSaving(false)
    if (error) {
      setMessage(`Could not save: ${error.message}`)
      return
    }
    onSaved(value)
    setDraft(null)
    setMessage(done)
  }

  const saveDraft = () => {
    if (!draft || !cal) return
    const aspect = cal.aspect
    // areas must not overlap: a moved corner that runs onto another area is cut back
    const fixed: Region[] = []
    for (const r of draft.regions) {
      const others = draft.regions.filter((o) => o.id !== r.id).map((o) => o.image)
      const cut = trimArea(r.image, others, aspect)
      if (!cut) {
        setMessage(`Could not save: area "${r.name}" now lies almost all on another area. Move its corners back.`)
        return
      }
      fixed.push({ ...r, image: cut.image })
    }
    store(
      { ...areas, calibration: cal, regions: fixed },
      `${camera.camera_name} placed on the shop plan at X ${draft.place.x.toFixed(2)} m, Y ${draft.place.y.toFixed(2)} m, facing ${draft.place.yaw}°, tilt ${draft.tilt}°. The edge box uses it within a minute.`,
    )
  }

  const saveObstacles = () =>
    store(
      { ...areas, obstacles: liveObstacles.map((o, i) => ({ id: `o${i + 1}`, label: o.label, b: o.b })) },
      `${liveObstacles.length} obstacle(s) saved. People whose legs are hidden behind them keep their floor spot.`,
    )

  const clearObstacles = () => {
    if (!window.confirm(`Remove the ${savedObstacles.length} saved obstacle(s) of ${camera.camera_name}?`)) return
    store({ ...areas, obstacles: [] }, 'Saved obstacles removed.')
  }

  const vb = `${view.x0} ${-view.y1} ${view.x1 - view.x0} ${view.y1 - view.y0}`
  const stroke = Math.max(view.x1 - view.x0, view.y1 - view.y0) / 320 // ~1 px
  const font = stroke * 11
  const grid: number[][] = []
  for (let x = Math.ceil(view.x0); x <= view.x1; x++) grid.push([x, view.y0, x, view.y1])
  for (let y = Math.ceil(view.y0); y <= view.y1; y++) grid.push([view.x0, y, view.x1, y])

  const cameraMark = (place: Place, name: string, mine: boolean) => {
    const yaw = (place.yaw * Math.PI) / 180
    const len = 0.9
    const spread = 0.5
    const tip = (a: number) => ({ x: place.x + Math.sin(yaw + a) * len, y: place.y + Math.cos(yaw + a) * len })
    return (
      <g key={name} className={mine && draft ? 'fm-camera fm-camera--drag' : 'fm-camera'}>
        <polygon points={pts([place, tip(-spread), tip(spread)])} fill={mine ? '#facc15' : '#cbd5e1'} opacity={0.45} />
        <circle
          cx={place.x}
          cy={-place.y}
          r={stroke * 6}
          fill={mine ? '#facc15' : '#94a3b8'}
          stroke="#0f172a"
          strokeWidth={stroke}
          onPointerDown={(e) => {
            if (!mine || !draft) return
            ;(e.target as Element).setPointerCapture?.(e.pointerId)
            drag.current = { kind: 'camera' }
          }}
        />
        <text x={place.x + stroke * 8} y={-place.y - stroke * 8} fontSize={font} fontWeight={700} fill="#0f172a">
          {name}
        </text>
      </g>
    )
  }

  const regionShape = (c: Calibration, r: Region, mine: boolean, key: string) => {
    const outline = floorOutline(c, r.image)
    if (outline.length < 3) return null
    const color = REGION_COLORS[r.kind]
    const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length
    const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length
    return (
      <g key={key}>
        <polygon
          points={pts(outline)}
          fill={color}
          fillOpacity={mine ? 0.28 : 0.1}
          stroke={color}
          strokeWidth={stroke * (mine ? 2 : 1)}
          strokeDasharray={mine ? undefined : `${stroke * 4} ${stroke * 3}`}
        />
        {mine && (
          <text x={cx} y={-cy} fontSize={font} textAnchor="middle" fill={color} fontWeight={700}>
            {r.name}
          </text>
        )}
        {mine &&
          draft &&
          r.image.map((pt, i) => {
            const f = floorOutline(c, [pt])[0]
            return f ? (
              <circle
                key={i}
                className="fm-corner"
                cx={f.x}
                cy={-f.y}
                r={stroke * 5}
                fill="#fff"
                stroke={color}
                strokeWidth={stroke * 2}
                onPointerDown={(e) => {
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  drag.current = { kind: 'corner', region: r.id, index: i }
                }}
              />
            ) : null
          })}
      </g>
    )
  }

  const obstacleShape = (c: Calibration, o: Obstacle, saved: boolean, key: string) => {
    const f = obstacleFootprint(c, o)
    if (!f) return null
    return (
      <polygon
        key={key}
        points={pts(f)}
        fill={OBSTACLE_COLOR}
        fillOpacity={saved ? 0.45 : 0.15}
        stroke={OBSTACLE_COLOR}
        strokeWidth={stroke * 1.5}
        strokeDasharray={saved ? undefined : `${stroke * 3} ${stroke * 2}`}
      >
        <title>{`${o.label}${saved ? ' (saved obstacle)' : ' (found now, not saved)'}`}</title>
      </polygon>
    )
  }

  return (
    <section className="cam-line fm">
      <div className="cam-line-head">
        <h2>Shop Floor Map</h2>
        <div className="cam-line-actions">
          {draft ? (
            <>
              <button type="button" className="cam-toggle" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="cam-line-save" onClick={saveDraft} disabled={saving || !cal}>
                {saving ? 'Saving…' : 'Save to camera'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="cam-toggle"
                onClick={saveObstacles}
                disabled={saving || !liveObstacles.length}
                title="Obstacles the edge box found on this camera right now"
              >
                Save {liveObstacles.length} found obstacle{liveObstacles.length === 1 ? '' : 's'}
              </button>
              {savedObstacles.length > 0 && (
                <button type="button" className="cam-toggle" onClick={clearObstacles} disabled={saving}>
                  Clear saved obstacles
                </button>
              )}
              <button
                type="button"
                className="cam-line-save"
                onClick={startEdit}
                disabled={saving || (!!areas.calibration && areas.calibration.mode !== 'auto' && !areas.calibration.placed)}
              >
                Adjust on map
              </button>
            </>
          )}
        </div>
      </div>
      <p className="cam-count-note">
        Top view of {plan ? plan.title : 'the shop floor'}. Coloured shapes are the areas drawn on {camera.camera_name}
        's picture, laid onto the floor; dashed shapes are the other cameras' areas
        {plan ? ', thin grey outlines the areas marked on the drawing' : ''}. Purple: obstacles (dashed = found now,
        solid = saved).
        {!placedNow && cal && !draft && ' This camera is not placed on the shop plan yet: it is shown at its place on the drawing. Check it, then "Adjust on map" → Save.'}
      </p>
      {message && <p className="cam-count-note fm-message">{message}</p>}

      {draft && (
        <div className="fm-controls">
          {(
            [
              ['X (m)', draft.place.x, (v: number) => setDraft({ ...draft, place: { ...draft.place, x: v } }), 0.05],
              ['Y (m)', draft.place.y, (v: number) => setDraft({ ...draft, place: { ...draft.place, y: v } }), 0.05],
              ['Facing (°)', draft.place.yaw, (v: number) => setDraft({ ...draft, place: { ...draft.place, yaw: v } }), 1],
              ['Tilt (°)', draft.tilt, (v: number) => setDraft({ ...draft, tilt: v }), 0.5],
            ] as [string, number, (v: number) => void, number][]
          ).map(([label, value, set, step]) => (
            <label key={label}>
              {label}
              <input
                type="number"
                step={step}
                value={value}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) set(v)
                }}
              />
            </label>
          ))}
          <label className="fm-slider">
            Facing
            <input
              type="range"
              min={0}
              max={359}
              value={((draft.place.yaw % 360) + 360) % 360}
              onChange={(e) => setDraft({ ...draft, place: { ...draft.place, yaw: Number(e.target.value) } })}
            />
          </label>
          {suggested && (
            <button type="button" className="cam-toggle" onClick={() => setDraft({ ...draft, place: { ...suggested } })}>
              Use place from drawing
            </button>
          )}
        </div>
      )}

      <div className="fm-wrap">
        <svg
          ref={svgRef}
          className="fm-svg"
          viewBox={vb}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
          role="img"
          aria-label={`Shop floor map with ${camera.camera_name}'s areas`}
        >
          <rect x={view.x0} y={-view.y1} width={view.x1 - view.x0} height={view.y1 - view.y0} fill="#f8fafc" />
          {grid.map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={-y1} x2={x2} y2={-y2} stroke="#e2e8f0" strokeWidth={stroke} />
          ))}
          {plan && (
            <g>
              <polygon points={pts(plan.walkway)} fill="#fff7ed" stroke="#fdba74" strokeWidth={stroke} />
              <polygon points={pts(plan.shop)} fill="#fff" stroke="#334155" strokeWidth={stroke * 3} />
              {plan.furniture.map((f) => (
                <polygon key={f.name} points={pts(f.pts)} fill="#e2e8f0" stroke="#94a3b8" strokeWidth={stroke}>
                  <title>{f.name}</title>
                </polygon>
              ))}
              {plan.areas.map((a) => (
                <polygon
                  key={a.name}
                  points={pts(a.pts)}
                  fill="none"
                  stroke="#64748b"
                  strokeWidth={stroke}
                  strokeDasharray={`${stroke * 2} ${stroke * 2}`}
                />
              ))}
              <text x={8.3} y={-2.2} fontSize={font * 1.2} fill="#c2410c" fontWeight={700} textAnchor="middle">
                Traffic
              </text>
            </g>
          )}
          {otherLayers.map(
            (l) => l.cal && l.fa.regions.map((r) => regionShape(l.cal!, r, false, `${l.camera.camera_id}-${r.id}`)),
          )}
          {otherLayers.map(
            (l) => l.cal && (l.fa.obstacles ?? []).map((o) => obstacleShape(l.cal!, o, true, `${l.camera.camera_id}-${o.id}`)),
          )}
          {cal && regions.map((r) => regionShape(cal, r, true, r.id))}
          {cal && savedObstacles.map((o) => obstacleShape(cal, o, true, `s-${o.id}`))}
          {cal && !draft && liveObstacles.map((o, i) => obstacleShape(cal, o, false, `l-${i}`))}
          {otherLayers.map((l) => l.cal?.place && cameraMark(l.cal.place, l.camera.camera_name, false))}
          {cal?.place && cameraMark(cal.place, camera.camera_name, true)}
          {people.map(
            ({ box, spot }) =>
              spot && (
                <g key={box.track}>
                  <circle
                    cx={spot.x}
                    cy={-spot.y}
                    r={stroke * 5}
                    fill={box.kind && box.kind in REGION_COLORS ? REGION_COLORS[box.kind as RegionKind] : '#16a34a'}
                    stroke="#fff"
                    strokeWidth={stroke}
                  />
                  <text x={spot.x + stroke * 6} y={-spot.y + stroke * 3} fontSize={font * 0.9} fill="#0f172a">
                    {box.track.split('-').pop()}
                  </text>
                </g>
              ),
          )}
        </svg>
      </div>
      <p className="cam-count-note fm-occupancy">
        Now on {camera.camera_name}: Purchasing {occupancy.Purchasing} · Counter (queue) {occupancy.Counter} · Traffic{' '}
        {occupancy.Traffic}
      </p>
    </section>
  )
}
