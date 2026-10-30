// Biometric photo check (Add Staff / Staff Details → PDPA consent → photos).
// Two models, run in the browser (the photo is not sent away to be checked;
// the libraries and models are loaded from their CDN the first time):
//   1. Person detector (EfficientDet-Lite0, COCO "person"): finds the person, also
//      in close-ups (only the head, from the side or the back).
//   2. Body landmarks (Pose Landmarker, 33 points): the direction the person faces,
//      body_view_angle in degrees, turning from the front to their left side:
//         0° (= 360°) Front    90° Left side    180° Back    270° Right side
//      and where each body PART is: Head, Upper body, Lower body, Feet (a box each).
//      ONE part is enough (e.g. a close-up of the head).
// The photo is NOT cropped: it is uploaded whole, with the box of each part
// (part_boxes); the edge box learns each part from inside its box. The admin can
// move / resize the boxes, add or remove parts and set the angle (Photoeditor.tsx),
// before the upload and afterwards (the edge box then learns the photo again).
// Nothing found automatically (no person, two people, angle not clear, checker not
// loaded): the photo is still kept, and the admin draws the boxes (status 'needs').
// supabase/body_view_angle_staff_track.sql

import type { BodyPart } from './types'
export type { BodyPart }

const MP_VERSION = '0.10.35'
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
const DETECTOR_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'

// Tuning
const PERSON_SCORE = 0.35 // the detector must be this sure the main person is a person
const OTHER_PERSON_SCORE = 0.5 // another person this sure ...
const OTHER_PERSON_AREA = 0.25 // ... and at least this big (share of the main person's box) = 2 people
const VISIBLE = 0.5 // a body point counts as seen at this visibility (0-1)
const MIN_PERSON_HEIGHT = 0.2 // smaller than this share of the photo height: the admin checks the boxes
const MAX_SIZE = 1600 // longest side used for the check and for the uploaded JPEG (whole photo, not cropped)
const MAX_FILE_MB = 15

export const BODY_PARTS: BodyPart[] = ['Head', 'Upper body', 'Lower body', 'Feet']
export type PartBoxes = Partial<Record<BodyPart, [number, number, number, number]>> // x1, y1, x2, y2 (0-1)

// 4 sides of the body; an angle belongs to the nearest one (±45°)
export const SIDES = [
  { name: 'Front', angle: 0 },
  { name: 'Left side', angle: 90 },
  { name: 'Back', angle: 180 },
  { name: 'Right side', angle: 270 },
] as const
export type SideName = (typeof SIDES)[number]['name']
export const sideOf = (angle: number): SideName => SIDES[Math.round((((angle % 360) + 360) % 360) / 90) % 4].name
// Angles the admin can pick (every 45°)
export const ANGLE_CHOICES: { angle: number; name: string }[] = [
  { angle: 0, name: 'Front' },
  { angle: 45, name: 'Front-left' },
  { angle: 90, name: 'Left side' },
  { angle: 135, name: 'Back-left' },
  { angle: 180, name: 'Back' },
  { angle: 225, name: 'Back-right' },
  { angle: 270, name: 'Right side' },
  { angle: 315, name: 'Front-right' },
]

// "Left side 95° · Head, Upper body" / "Whole body · Front 0°"
export function bodyLabel(angle: number | null, parts: BodyPart[]): string {
  const view = angle === null ? 'Angle not known' : `${sideOf(angle)} ${angle}°`
  if (parts.length === BODY_PARTS.length) return `Whole body · ${view}`
  return parts.length ? `${view} · ${parts.join(', ')}` : view
}

export type BodyCheck =
  | {
      ok: true
      needs: boolean // the admin must draw / check the boxes or pick the angle
      note?: string // why (shown on the photo)
      angle: number | null // detected body_view_angle (null: not known)
      parts: BodyPart[] // detected parts
      partBoxes: PartBoxes // where each part is in the photo (0-1)
      personBox: [number, number, number, number] // the person in the photo (0-1); whole photo when not found
      jpeg: Blob // the whole photo (not cropped)
      preview: string // object URL of jpeg
    }
  | { ok: false; reason: string }

// ---------------------------------------------------------------- models
type Landmark = { x: number; y: number; z: number; visibility?: number }
type Detection = { boundingBox?: { originX: number; originY: number; width: number; height: number }; categories: { score: number; categoryName: string }[] }
type Models = {
  pose: { detect(img: HTMLCanvasElement): { landmarks: Landmark[][]; worldLandmarks?: Landmark[][] } }
  detector: { detect(img: HTMLCanvasElement): { detections: Detection[] } }
}

let models: Promise<Models> | null = null
function loadModels(): Promise<Models> {
  models ??= (async () => {
    const mp = await import(/* @vite-ignore */ MP_BUNDLE)
    const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM)
    const withFallback = async <T,>(make: (delegate: 'GPU' | 'CPU') => Promise<T>) => {
      try {
        return await make('GPU')
      } catch {
        return await make('CPU')
      }
    }
    const [pose, detector] = await Promise.all([
      withFallback((delegate) =>
        mp.PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate },
          runningMode: 'IMAGE',
          numPoses: 1,
          minPoseDetectionConfidence: 0.3,
          minPosePresenceConfidence: 0.3,
        }),
      ),
      withFallback((delegate) =>
        mp.ObjectDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: DETECTOR_MODEL, delegate },
          runningMode: 'IMAGE',
          scoreThreshold: 0.25,
          maxResults: 6,
          categoryAllowlist: ['person'],
        }),
      ),
    ])
    return { pose, detector } as Models
  })().catch((e) => {
    models = null // try again next time
    throw e
  })
  return models
}

// ---------------------------------------------------------------- image helpers
function drawScaled(bitmap: ImageBitmap, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the photo'))), 'image/jpeg', 0.9),
  )

type Box = [number, number, number, number] // pixels x1, y1, x2, y2
const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
const iou = (a: Box, b: Box) => {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
  return i / Math.max(1, area(a) + area(b) - i)
}

// ---------------------------------------------------------------- angle and parts (exported for tests)
// MediaPipe body points
const NOSE = 0, L_EYE = 2, R_EYE = 5, L_EAR = 7, R_EAR = 8
const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26
const HEAD_POINTS = [NOSE, 1, L_EYE, 3, 4, R_EYE, 6, L_EAR, R_EAR, 9, 10]
const FEET_POINTS = [27, 28, 29, 30, 31, 32]

// Direction the person faces, degrees 0-359 (0 Front, 90 Left side, 180 Back, 270 Right side),
// from the 3D left→right shoulder line (or ear line for a close-up of the head), rounded to 5°.
// world = 3D body points in metres (z: smaller = nearer the camera). null when not clear.
export function facingAngle(lm: Landmark[], world: Landmark[] | undefined): number | null {
  const pts = world && world.length === lm.length ? world : lm
  const vis = (i: number) => lm[i]?.visibility ?? 0
  let a = -1, b = -1
  if (vis(L_SHOULDER) >= 0.3 && vis(R_SHOULDER) >= 0.3) [a, b] = [L_SHOULDER, R_SHOULDER]
  else if (vis(L_EAR) >= 0.2 || vis(R_EAR) >= 0.2) [a, b] = [L_EAR, R_EAR]
  if (a < 0) return null
  const sx = pts[a].x - pts[b].x
  const sz = pts[a].z - pts[b].z
  if (Math.hypot(sx, sz) < 1e-3) return null
  // Front: left shoulder on the right of the picture (sx > 0). Left side: left shoulder nearer (sz < 0).
  let angle = ((Math.atan2(-sz, sx) * 180) / Math.PI + 360) % 360
  // The 3D depth is weakest for front vs back: the face decides which half
  const face = (vis(NOSE) + vis(L_EYE) + vis(R_EYE)) / 3
  const frontHalf = angle < 90 || angle > 270
  const nearSide = Math.abs(angle - 90) < 25 || Math.abs(angle - 270) < 25
  if ((face >= 0.7 && !frontHalf) || (face < 0.15 && frontHalf && !nearSide)) angle = (540 - angle) % 360
  return (Math.round(angle / 5) * 5) % 360
}

// Parts in the photo and their boxes (pixels, inside the person's box). One part is enough.
export function findParts(lm: Landmark[] | null, person: Box, w: number, h: number): { parts: BodyPart[]; boxes: Partial<Record<BodyPart, Box>> } {
  const [bx1, by1, bx2, by2] = person
  const bh = by2 - by1
  const boxes: Partial<Record<BodyPart, Box>> = {}
  if (!lm) {
    // No landmarks: a guess from the box shape (the admin confirms): tall = more of the body
    const tall = bh / Math.max(1, bx2 - bx1)
    const parts: BodyPart[] = tall >= 2.2 ? ['Head', 'Upper body', 'Lower body'] : tall >= 1.2 ? ['Head', 'Upper body'] : ['Head']
    const share: Record<BodyPart, number> = { Head: 0.16, 'Upper body': 0.36, 'Lower body': 0.36, Feet: 0.12 }
    const total = parts.reduce((s, p) => s + share[p], 0)
    let y = by1
    for (const p of parts) {
      const ph = (share[p] / total) * bh
      boxes[p] = [bx1, y, bx2, y + ph]
      y += ph
    }
    return { parts, boxes }
  }
  const vis = (i: number) => lm[i]?.visibility ?? 0
  const inFrame = (i: number) => lm[i].x >= 0 && lm[i].x <= 1 && lm[i].y >= 0 && lm[i].y <= 1
  const seen = (i: number, v = VISIBLE) => vis(i) >= v && inFrame(i)
  const X = (i: number) => lm[i].x * w
  const Y = (i: number) => lm[i].y * h
  const meanY = (ids: number[], v = VISIBLE) => {
    const ys = ids.filter((i) => seen(i, v)).map(Y)
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null
  }
  const clampY = (y: number) => Math.min(by2, Math.max(by1, y))
  const shoulderY = meanY([L_SHOULDER, R_SHOULDER])
  const hipY = meanY([L_HIP, R_HIP])
  const kneeY = meanY([L_KNEE, R_KNEE])
  const feetYs = FEET_POINTS.filter((i) => seen(i)).map(Y)
  const parts: BodyPart[] = []

  // Head: face / ear points, or (from the back) room above the shoulders
  const headPts = HEAD_POINTS.filter((i) => seen(i, 0.3))
  const roomAbove = shoulderY !== null && shoulderY - by1 >= 0.08 * bh
  if (headPts.length || roomAbove) {
    const bottom = clampY(shoulderY ?? (headPts.length ? Math.max(...headPts.map(Y)) + 0.35 * bh : by2))
    const cx = headPts.length ? headPts.map(X).reduce((a, b) => a + b, 0) / headPts.length : (bx1 + bx2) / 2
    const r = Math.max(0.42 * (bottom - by1), 0.05 * w)
    if (bottom - by1 > 4) {
      parts.push('Head')
      boxes.Head = [Math.max(bx1, cx - r), by1, Math.min(bx2, cx + r), bottom]
    }
  }
  // Upper body: a shoulder is enough (hips may be out of the photo)
  if (shoulderY !== null) {
    const bottom = clampY(hipY ?? by2)
    if (bottom - shoulderY > 4) {
      parts.push('Upper body')
      boxes['Upper body'] = [bx1, clampY(shoulderY - 0.02 * bh), bx2, bottom]
    }
  }
  // Lower body: a knee (hips to ankles)
  if (kneeY !== null) {
    const top = clampY(hipY ?? kneeY - 0.25 * bh)
    const bottom = clampY(feetYs.length ? Math.min(...feetYs) : by2)
    if (bottom - top > 4) {
      parts.push('Lower body')
      boxes['Lower body'] = [bx1, top, bx2, bottom]
    }
  }
  // Feet: ankle, heel or toes
  if (feetYs.length) {
    const top = clampY(Math.min(...feetYs) - 0.04 * bh)
    const bottom = clampY(Math.max(...feetYs) + 0.04 * bh)
    if (bottom - top > 4) {
      parts.push('Feet')
      boxes.Feet = [bx1, top, bx2, bottom]
    }
  }
  return { parts, boxes }
}

// ---------------------------------------------------------------- check one photo
export async function checkStaffPhoto(file: File): Promise<BodyCheck> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'This file is not a photo.' }
  if (file.size > MAX_FILE_MB * 1024 * 1024) return { ok: false, reason: `The photo is larger than ${MAX_FILE_MB} MB.` }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return { ok: false, reason: 'This photo cannot be opened. Use a JPG or PNG photo.' }
  }
  try {
    if (Math.min(bitmap.width, bitmap.height) < 200)
      return { ok: false, reason: 'The photo is too small (at least 200 × 200 pixels).' }
    const canvas = drawScaled(bitmap, MAX_SIZE)
    const w = canvas.width
    const h = canvas.height
    const jpeg = await toJpeg(canvas) // the whole photo: not cropped
    const base = { ok: true as const, jpeg, preview: URL.createObjectURL(jpeg) }
    // nothing usable found: keep the photo, the admin draws the boxes and picks the angle
    const manual = (note: string): BodyCheck => ({
      ...base,
      needs: true,
      note,
      angle: null,
      parts: [],
      partBoxes: {},
      personBox: [0, 0, 1, 1],
    })

    let m: Models
    try {
      m = await loadModels()
    } catch {
      return manual('The person checker could not be loaded: draw the body part boxes and choose the angle.')
    }

    // 1. People in the photo
    const people = (m.detector.detect(canvas).detections ?? [])
      .filter((d) => d.boundingBox && (d.categories[0]?.score ?? 0) >= PERSON_SCORE)
      .map((d) => {
        const b = d.boundingBox!
        return { box: [b.originX, b.originY, b.originX + b.width, b.originY + b.height] as Box, score: d.categories[0].score }
      })
      .sort((a, b) => area(b.box) - area(a.box))
    const pose = m.pose.detect(canvas)
    const lm = pose.landmarks?.[0] ?? null
    const world = pose.worldLandmarks?.[0]

    let person: Box | null = people[0]?.box ?? null
    if (
      person &&
      people
        .slice(1)
        .some((p) => p.score >= OTHER_PERSON_SCORE && area(p.box) >= OTHER_PERSON_AREA * area(person!) && iou(p.box, person!) < 0.3)
    )
      return manual('More than one person found: draw the boxes on this staff only, and choose the angle.')
    if (!person && lm) {
      // the detector missed them but the landmarks found a body: their box
      const pts = lm.filter((p) => (p.visibility ?? 0) >= 0.3 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
      if (pts.length >= 4) {
        const xs = pts.map((p) => p.x * w)
        const ys = pts.map((p) => p.y * h)
        const pad = 0.1 * (Math.max(...ys) - Math.min(...ys))
        person = [Math.max(0, Math.min(...xs) - pad), Math.max(0, Math.min(...ys) - 2 * pad), Math.min(w, Math.max(...xs) + pad), Math.min(h, Math.max(...ys) + pad)]
      }
    }
    if (!person) return manual('No person found automatically: draw the body part boxes and choose the angle.')
    person = [Math.max(0, person[0]), Math.max(0, person[1]), Math.min(w, person[2]), Math.min(h, person[3])]

    // 2. Angle and parts (landmarks of the person found above only)
    const centre = lm
      ? (() => {
          const pts = [L_SHOULDER, R_SHOULDER, NOSE, L_EAR, R_EAR].filter((i) => (lm[i].visibility ?? 0) >= 0.3)
          if (!pts.length) return null
          return [pts.reduce((s, i) => s + lm[i].x * w, 0) / pts.length, pts.reduce((s, i) => s + lm[i].y * h, 0) / pts.length]
        })()
      : null
    const ownLm = lm && centre && centre[0] >= person[0] && centre[0] <= person[2] && centre[1] >= person[1] && centre[1] <= person[3] ? lm : null
    const angle = ownLm ? facingAngle(ownLm, world) : null
    let { parts, boxes } = findParts(ownLm, person, w, h)
    let needs = angle === null || !ownLm
    if (!parts.length) {
      ;({ parts, boxes } = findParts(null, person, w, h))
      needs = true
    }
    const rel = (b: Box): [number, number, number, number] => {
      const r = (v: number, max: number) => Math.round(Math.min(1, Math.max(0, v / max)) * 1000) / 1000
      return [r(b[0], w), r(b[1], h), r(b[2], w), r(b[3], h)]
    }
    const partBoxes: PartBoxes = {}
    for (const p of parts) if (boxes[p]) partBoxes[p] = rel(boxes[p]!)
    const small = (person[3] - person[1]) / h < MIN_PERSON_HEIGHT
    const note = needs
      ? 'Body points not clear: check the boxes and choose the angle.'
      : small
        ? 'The person is small in this photo: check the boxes.'
        : undefined
    return { ...base, needs: needs || small, note, angle, parts, partBoxes, personBox: rel(person) }
  } finally {
    bitmap.close()
  }
}

// Part boxes for parts the admin picked (no landmarks): bands of the person's box
export function bandBoxes(parts: BodyPart[], personBox: [number, number, number, number]): PartBoxes {
  const share: Record<BodyPart, number> = { Head: 0.16, 'Upper body': 0.36, 'Lower body': 0.36, Feet: 0.12 }
  const ordered = BODY_PARTS.filter((p) => parts.includes(p))
  const total = ordered.reduce((s, p) => s + share[p], 0) || 1
  const [x1, y1, x2, y2] = personBox
  const out: PartBoxes = {}
  let y = y1
  for (const p of ordered) {
    const ph = (share[p] / total) * (y2 - y1)
    out[p] = [x1, Math.round(y * 1000) / 1000, x2, Math.round((y + ph) * 1000) / 1000]
    y += ph
  }
  return out
}
