// Biometric photo check (Add Staff / Staff Details → PDPA consent → photos).
// A photo can only be uploaded when it shows ONE person and the VIEW of the
// body is clear: Front, Back, Left side or Right side. The check also finds
// which PARTS of the body are in the photo (Head, Upper body, Lower body, Feet)
// and where they are, so the edge box can learn each part from each side
// (4 views x 4 parts = 16 kinds, 360° recognition; supabase/biometric_photo.sql).
//
// Runs in the browser with MediaPipe Pose Landmarker (33 body points per
// person). The library and the model are loaded from their CDN the first time a
// photo is checked; the photo itself is checked on this computer, not sent away.

const MP_VERSION = '0.10.35'
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'

// Tuning
const VISIBLE = 0.5 // a body point counts as seen at this visibility (0-1)
const MIN_BODY_HEIGHT = 0.25 // the person must fill at least 25% of the photo height
const SIDE_RATIO = 0.35 // shoulder width / torso length below this = side view
const MAX_CHECK_SIZE = 1280 // longest side used for the check
const MAX_UPLOAD_SIZE = 1600 // longest side of the uploaded JPEG
const MAX_FILE_MB = 15

import type { BodyPart, BodyView } from './types'
export type { BodyPart, BodyView }
export const BODY_VIEWS: BodyView[] = ['Front', 'Left side', 'Right side', 'Back']
export const BODY_PARTS: BodyPart[] = ['Head', 'Upper body', 'Lower body', 'Feet']
export type PartBoxes = Partial<Record<BodyPart, [number, number, number, number]>> // x1, y1, x2, y2 (0-1)

export type BodyCheck =
  | {
      ok: true
      view: BodyView
      wholeBody: boolean
      parts: BodyPart[]
      partBoxes: PartBoxes
      label: string
      jpeg: Blob
    }
  | { ok: false; reason: string }

// "Whole body · Front body", "Left side body · Head, Upper body"
export function bodyLabel(view: BodyView, wholeBody: boolean, parts?: BodyPart[]): string {
  const v = `${view} body`
  if (wholeBody) return `Whole body · ${v}`
  return parts && parts.length ? `${v} · ${parts.join(', ')}` : v
}

// ---------------------------------------------------------------- model
type Landmark = { x: number; y: number; z: number; visibility?: number }
type PoseLandmarker = { detect(image: HTMLCanvasElement): { landmarks: Landmark[][] } }

let landmarker: Promise<PoseLandmarker> | null = null
function loadLandmarker(): Promise<PoseLandmarker> {
  landmarker ??= (async () => {
    const mp = await import(/* @vite-ignore */ MP_BUNDLE)
    const vision = await mp.FilesetResolver.forVisionTasks(MP_WASM)
    const create = (delegate: 'GPU' | 'CPU') =>
      mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate },
        runningMode: 'IMAGE',
        numPoses: 3, // more than one person is refused, so look for them
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
      }) as Promise<PoseLandmarker>
    try {
      return await create('GPU')
    } catch {
      return await create('CPU')
    }
  })().catch((e) => {
    landmarker = null // try again next time
    throw e
  })
  return landmarker
}

// ---------------------------------------------------------------- image
async function drawScaled(bitmap: ImageBitmap, maxSide: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the photo'))), 'image/jpeg', 0.85),
  )

// ---------------------------------------------------------------- body view and parts
// MediaPipe body points
const NOSE = 0, L_EYE = 2, R_EYE = 5, L_EAR = 7, R_EAR = 8
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16
const L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28
const L_HEEL = 29, R_HEEL = 30, L_FOOT = 31, R_FOOT = 32
const HEAD_POINTS = [NOSE, 1, L_EYE, 3, 4, R_EYE, 6, L_EAR, R_EAR, 9, 10]
const FEET_POINTS = [L_ANKLE, R_ANKLE, L_HEEL, R_HEEL, L_FOOT, R_FOOT]

type Classified = { view: BodyView; wholeBody: boolean; parts: BodyPart[]; partBoxes: PartBoxes }

function classify(lm: Landmark[], w: number, h: number): Classified | string {
  const vis = (i: number) => lm[i]?.visibility ?? 0
  const inFrame = (i: number) => lm[i].x >= 0 && lm[i].x <= 1 && lm[i].y >= 0 && lm[i].y <= 1
  const seen = (i: number) => vis(i) >= VISIBLE && inFrame(i)
  const any = (...ids: number[]) => ids.some(seen)
  const P = (i: number) => ({ x: lm[i].x * w, y: lm[i].y * h })

  // The torso must be in the photo
  if (!any(L_SHOULDER, R_SHOULDER) || !any(L_HIP, R_HIP))
    return 'The body is not clear: the shoulders and hips must be in the photo.'

  // Size of the person in the photo
  const ys = lm.filter((_, i) => seen(i)).map((p) => p.y)
  if (Math.max(...ys) - Math.min(...ys) < MIN_BODY_HEIGHT)
    return 'The person is too small in the photo. Take the photo closer or crop it.'

  // Torso length (shoulder centre → hip centre, or one side when the other is hidden)
  const mid = (a: number, b: number) =>
    seen(a) && seen(b) ? { x: (P(a).x + P(b).x) / 2, y: (P(a).y + P(b).y) / 2 } : seen(a) ? P(a) : P(b)
  const sh = mid(L_SHOULDER, R_SHOULDER)
  const hip = mid(L_HIP, R_HIP)
  const torso = Math.hypot(sh.x - hip.x, sh.y - hip.y)
  if (torso < 1) return 'The body is not clear in the photo.'

  // ---- view: shoulder width compared with torso length (narrow = side view)
  const bothShoulders = seen(L_SHOULDER) && seen(R_SHOULDER)
  const dx = P(L_SHOULDER).x - P(R_SHOULDER).x // > 0: the person's left shoulder is on the right of the photo (facing the camera)
  const ratio = bothShoulders ? Math.abs(dx) / torso : 0

  let view: BodyView | null = null
  if (ratio < SIDE_RATIO) {
    // Side: which side faces the camera?
    const dz = lm[L_SHOULDER].z - lm[R_SHOULDER].z // smaller z = nearer the camera
    const noseOffset = seen(NOSE) ? (P(NOSE).x - sh.x) / torso : 0
    if (Math.abs(dz) > 0.05) view = dz < 0 ? 'Left side' : 'Right side'
    // Facing the left of the photo shows the person's left side
    else if (Math.abs(noseOffset) > 0.1) view = noseOffset < 0 ? 'Left side' : 'Right side'
    else if (seen(L_EAR) !== seen(R_EAR)) view = seen(L_EAR) ? 'Left side' : 'Right side'
  } else {
    // Front or back: is the face visible?
    const face = (vis(NOSE) + vis(L_EYE) + vis(R_EYE)) / 3
    if (face >= 0.6) view = 'Front'
    else if (face < 0.3) view = 'Back'
    else view = dx > 0 ? 'Front' : 'Back'
  }
  if (!view)
    return 'Could not tell which side of the body this is. Upload a photo of the front, back, left side or right side of the body.'

  // ---- parts: where each one is (pixels), then 0-1 boxes inside the photo
  const T = torso
  const xs = (ids: number[]) => ids.filter(seen).map((i) => P(i).x)
  const ysOf = (ids: number[]) => ids.filter(seen).map((i) => P(i).y)
  const box = (x1: number, y1: number, x2: number, y2: number): [number, number, number, number] => {
    const c = (v: number, max: number) => Math.round(Math.min(1, Math.max(0, v / max)) * 1000) / 1000
    return [c(x1, w), c(y1, h), c(x2, w), c(y2, h)]
  }
  const partBoxes: PartBoxes = {}
  const parts: BodyPart[] = []

  // Head: the space above the shoulders must be in the photo (also from the back, where the face points are hidden)
  const headTop = sh.y - 0.65 * T
  const headX = xs(HEAD_POINTS)
  const headInFrame = HEAD_POINTS.some((i) => inFrame(i) && vis(i) >= 0.2)
  if (headTop >= -0.05 * T && headInFrame) {
    const cx = headX.length ? headX.reduce((a, b) => a + b, 0) / headX.length : sh.x
    const half = Math.max(0.33 * T, bothShoulders ? Math.abs(dx) * 0.4 : 0)
    parts.push('Head')
    partBoxes.Head = box(cx - half, headTop, cx + half, sh.y + 0.05 * T)
  }

  // Upper body: shoulders to hips (always there: checked above), arms included
  {
    const x = xs([L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_ELBOW, R_ELBOW, L_WRIST, R_WRIST])
    const pad = 0.12 * T
    parts.push('Upper body')
    partBoxes['Upper body'] = box(Math.min(...x) - pad, sh.y - 0.05 * T, Math.max(...x) + pad, hip.y + 0.08 * T)
  }

  // Lower body: hips to ankles (a knee must be seen)
  const feetY = ysOf(FEET_POINTS)
  if (any(L_KNEE, R_KNEE)) {
    const x = xs([L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE])
    const kneeY = Math.max(...ysOf([L_KNEE, R_KNEE]))
    const bottom = any(L_ANKLE, R_ANKLE) ? Math.max(...ysOf([L_ANKLE, R_ANKLE])) : kneeY + 0.5 * T
    const pad = 0.15 * T
    parts.push('Lower body')
    partBoxes['Lower body'] = box(Math.min(...x) - pad, hip.y - 0.05 * T, Math.max(...x) + pad, bottom)
  }

  // Feet: ankles, heels and toes
  if (feetY.length) {
    const x = xs(FEET_POINTS)
    const ankleY = any(L_ANKLE, R_ANKLE) ? Math.min(...ysOf([L_ANKLE, R_ANKLE])) : Math.min(...feetY)
    const pad = 0.15 * T
    parts.push('Feet')
    partBoxes.Feet = box(Math.min(...x) - pad, ankleY - 0.12 * T, Math.max(...x) + pad, Math.max(...feetY) + 0.1 * T)
  }

  const wholeBody = parts.length === BODY_PARTS.length
  return { view, wholeBody, parts, partBoxes }
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

    let model: PoseLandmarker
    try {
      model = await loadLandmarker()
    } catch {
      return { ok: false, reason: 'The body checker could not be loaded. Check the internet connection and try again.' }
    }

    const canvas = await drawScaled(bitmap, MAX_CHECK_SIZE)
    const poses = model.detect(canvas).landmarks
    if (poses.length === 0) return { ok: false, reason: 'No person found in the photo.' }
    if (poses.length > 1) return { ok: false, reason: 'More than one person in the photo. Upload a photo of this staff only.' }

    const result = classify(poses[0], canvas.width, canvas.height)
    if (typeof result === 'string') return { ok: false, reason: result }

    // Same picture, bigger: the 0-1 part boxes stay right
    const jpeg = await toJpeg(await drawScaled(bitmap, MAX_UPLOAD_SIZE))
    return { ok: true, ...result, label: bodyLabel(result.view, result.wholeBody, result.parts), jpeg }
  } finally {
    bitmap.close()
  }
}
