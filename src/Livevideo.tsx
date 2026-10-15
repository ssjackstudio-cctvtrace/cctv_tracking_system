import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { getAdminToken } from './lib/supabase'

// Live video from the edge box (edge/edge/live_server.py), over a WebSocket.
// Each message is one picture plus where each tracked person is in it.

// One tracked person in the picture: track = visit.track_id, b = box (0–1)
export type LiveBox = { track: string; b: [number, number, number, number]; area: 'in' | 'out' | null }
export type LiveFrame = { f: number; w: number; h: number; boxes: LiveBox[]; counts: { In: number; Out: number } }
export type LiveState = 'connecting' | 'live' | 'off' | 'failed'

const RETRY_MS = 3_000
const FAILED_AFTER = 2 // failed connections in a row before showing the snapshot instead

// https://box.ts.net → wss://box.ts.net/live/<camera id>?token=…
function liveSocketUrl(liveUrl: string, cameraId: string, width: number, fps: number, token: string) {
  const base = liveUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')
  const q = new URLSearchParams({ token, w: String(width), fps: String(fps) })
  return `${base}/live/${cameraId}?${q}`
}

// True while the browser tab is shown (no video is downloaded while it is hidden,
// to save the shop's mobile data)
function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

export function LiveVideo({
  cameraId,
  liveUrl,
  width = 640,
  fps = 10,
  draw,
  onSaved,
  onState,
  grabFrameRef,
  className,
}: {
  cameraId: string
  liveUrl: string
  width?: number // picture width asked from the box (smaller = less mobile data)
  fps?: number // pictures per second
  draw?: (ctx: CanvasRenderingContext2D, frame: LiveFrame) => void // extra drawing on top of each picture
  onSaved?: () => void // the box saved a visit / cctv_event row for this camera
  onState?: (state: LiveState, message: string) => void
  grabFrameRef?: MutableRefObject<(() => string | null) | null> // current picture as a JPEG data URL
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastBitmap = useRef<ImageBitmap | null>(null)
  const visible = usePageVisible()
  // Keep the newest callbacks without reconnecting
  const cb = useRef({ draw, onSaved, onState })
  cb.current = { draw, onSaved, onState }

  useEffect(() => {
    if (!grabFrameRef) return
    grabFrameRef.current = () => {
      const bmp = lastBitmap.current
      if (!bmp) return null
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')?.drawImage(bmp, 0, 0)
      return c.toDataURL('image/jpeg', 0.9)
    }
    return () => {
      grabFrameRef.current = null
    }
  }, [grabFrameRef])

  useEffect(() => {
    if (!visible) return
    let stopped = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let decoding = false
    let pending: { head: LiveFrame; jpeg: Blob } | null = null
    const setState = (s: LiveState, msg = '') => cb.current.onState?.(s, msg)

    // Draw the newest picture; pictures that arrive while one is decoding are skipped
    const show = async () => {
      if (decoding || !pending) return
      decoding = true
      const { head, jpeg } = pending
      pending = null
      try {
        const bmp = await createImageBitmap(jpeg)
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (canvas && ctx && !stopped) {
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width
            canvas.height = bmp.height
          }
          ctx.drawImage(bmp, 0, 0)
          cb.current.draw?.(ctx, head)
          lastBitmap.current?.close()
          lastBitmap.current = bmp
        } else bmp.close()
      } catch {
        // broken picture: skip it
      }
      decoding = false
      if (pending) show()
    }

    const connect = () => {
      const token = getAdminToken()
      if (!token) {
        setState('failed', 'Not signed in')
        return
      }
      setState(failures >= FAILED_AFTER ? 'failed' : 'connecting')
      ws = new WebSocket(liveSocketUrl(liveUrl, cameraId, width, fps, token))
      ws.binaryType = 'arraybuffer'
      let gotSomething = false
      ws.onmessage = (e) => {
        gotSomething = true
        failures = 0
        if (typeof e.data === 'string') {
          let msg: { type?: string; live?: boolean; msg?: string } = {}
          try {
            msg = JSON.parse(e.data)
          } catch {
            return
          }
          if (msg.type === 'db') cb.current.onSaved?.()
          else if (msg.type === 'status') setState(msg.live ? 'live' : 'off', msg.msg ?? '')
          else if (msg.type === 'error') setState('failed', msg.msg ?? 'Live video refused')
          return
        }
        const buf = e.data as ArrayBuffer
        const n = new DataView(buf).getUint32(0)
        const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as LiveFrame
        pending = { head, jpeg: new Blob([new Uint8Array(buf, 4 + n)], { type: 'image/jpeg' }) }
        setState('live')
        show()
      }
      ws.onclose = (e) => {
        if (stopped) return
        if (e.code === 4401) return // not signed in: stop trying until the page is opened again
        if (!gotSomething) failures++
        if (failures >= FAILED_AFTER) setState('failed', 'Cannot reach the edge box live video')
        retry = setTimeout(connect, RETRY_MS)
      }
    }
    connect()

    return () => {
      stopped = true
      clearTimeout(retry)
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    }
  }, [cameraId, liveUrl, width, fps, visible])

  useEffect(
    () => () => {
      lastBitmap.current?.close()
      lastBitmap.current = null
    },
    [],
  )

  return <canvas ref={canvasRef} className={className} />
}
