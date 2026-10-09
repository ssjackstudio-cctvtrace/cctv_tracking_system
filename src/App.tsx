import { useEffect, useRef, useState } from 'react'
import { setAdminToken, supabase } from './lib/supabase'
import Dashboard from './dashboard'
import LoginPage from './Loginpage'
import './Login.css'

const TOKEN_KEY = 'cctv_admin_token'
const EXPIRES_AT_KEY = 'cctv_admin_expires_at' // when the session ends (ms): last activity + 10 min
const IDLE_LIMIT_MS = 10 * 60 * 1000 // signed out after 10 minutes with no activity
const IDLE_WARNING_MS = 8 * 60 * 1000 // "Stay signed in?" shown after 8 minutes
const TOUCH_EVERY_MS = 60 * 1000 // tell the server "still active" at most once a minute
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'] as const
const SESSION_ENDED_MESSAGE = 'You were signed out after 10 minutes of inactivity. Please sign in again.'

// 95 seconds → "1:35"
function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
function saveToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage blocked: the admin just signs in again after a refresh
  }
}
function readExpiresAt(): number | null {
  try {
    const v = Number(localStorage.getItem(EXPIRES_AT_KEY))
    return v > 0 ? v : null
  } catch {
    return null
  }
}
function saveExpiresAt(time: number | null) {
  try {
    if (time) localStorage.setItem(EXPIRES_AT_KEY, String(time))
    else localStorage.removeItem(EXPIRES_AT_KEY)
  } catch {
    // storage blocked: the in-memory end time is still used
  }
}

// Start on the admin sign-in page; show the dashboard only to signed-in admins
export default function App() {
  const [adminName, setAdminName] = useState<string | null>(null)
  const [ready, setReady] = useState(false) // saved session checked
  const [sessionNotice, setSessionNotice] = useState('') // shown on the sign-in page
  const [warningLeft, setWarningLeft] = useState<number | null>(null) // seconds left while the warning shows
  const warningRef = useRef(false)
  const lastActivityRef = useRef(0) // last mouse / key / touch / scroll (ms)
  const lastTouchRef = useRef(0) // last admin_touch call (ms)
  const touchTimerRef = useRef<number | undefined>(undefined)
  const endingRef = useRef(false)

  // Reopening the site: still signed in?
  useEffect(() => {
    const token = readToken()
    if (!token) {
      setReady(true)
      return
    }
    setAdminToken(token)
    const expiresAt = readExpiresAt()
    if (!expiresAt || Date.now() >= expiresAt) {
      // Inactive for 10 minutes or more: end that session on the server too
      supabase.rpc('admin_logout').then(() => {
        setAdminToken(null)
        saveToken(null)
        saveExpiresAt(null)
        if (expiresAt) setSessionNotice(SESSION_ENDED_MESSAGE)
        setReady(true)
      })
      return
    }
    supabase.rpc('admin_check').then(({ data, error }) => {
      if (!error && typeof data === 'string' && data) {
        setAdminName(data)
      } else {
        setAdminToken(null)
        saveToken(null)
        saveExpiresAt(null)
      }
      setReady(true)
    })
  }, [])

  // Tell the server the admin is still active: the session now ends 10 minutes from now
  async function touchServer() {
    lastTouchRef.current = Date.now()
    const { data, error } = await supabase.rpc('admin_touch')
    if (!error && !data) void endSession() // the server already ended this session
  }

  // Mouse, key, touch or scroll: restart the 10-minute inactivity count
  function markActive() {
    const now = Date.now()
    if (now - lastActivityRef.current < 1000) return // ignore bursts (e.g. mouse moves)
    lastActivityRef.current = now
    saveExpiresAt(now + IDLE_LIMIT_MS) // also tells other open tabs
    // Reach the server at most once a minute, always including the latest activity
    window.clearTimeout(touchTimerRef.current)
    const wait = TOUCH_EVERY_MS - (now - lastTouchRef.current)
    if (wait <= 0) void touchServer()
    else touchTimerRef.current = window.setTimeout(() => void touchServer(), wait)
  }

  // "Yes, stay signed in" on the warning
  function staySignedIn() {
    warningRef.current = false
    setWarningLeft(null)
    lastActivityRef.current = 0
    lastTouchRef.current = 0 // reach the server right away
    markActive()
  }

  // Signed in: warn after 8 minutes of inactivity, sign out after 10
  useEffect(() => {
    if (!adminName) return
    lastActivityRef.current = 0
    lastTouchRef.current = 0
    markActive() // signing in or reopening the site counts as activity

    const check = () => {
      const idle = Date.now() - lastActivityRef.current
      if (idle >= IDLE_LIMIT_MS) {
        void endSession()
      } else if (idle >= IDLE_WARNING_MS) {
        warningRef.current = true
        setWarningLeft(Math.ceil((IDLE_LIMIT_MS - idle) / 1000))
      } else if (warningRef.current) {
        // active again in another tab
        warningRef.current = false
        setWarningLeft(null)
      }
    }
    // While the warning shows, only the "Yes" button keeps the admin signed in
    const onActivity = () => {
      if (!warningRef.current) markActive()
    }
    // Activity in another open tab of the site counts too
    const onStorage = (e: StorageEvent) => {
      if (e.key !== EXPIRES_AT_KEY || !e.newValue) return
      const otherTabActivity = Number(e.newValue) - IDLE_LIMIT_MS
      if (otherTabActivity > lastActivityRef.current) {
        lastActivityRef.current = otherTabActivity
        check()
      }
    }

    const timer = window.setInterval(check, 1000)
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true, capture: true }))
    window.addEventListener('storage', onStorage)
    // Timers can run late in background tabs, so check again when the tab is shown
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(touchTimerRef.current)
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }))
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      warningRef.current = false
      setWarningLeft(null)
    }
  }, [adminName])

  async function signIn(name: string, password: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('admin_login', { p_name: name, p_password: password })
    if (error) return error.message
    const result = data as { token: string; admin_name: string; expires_at?: string } | null
    if (!result) return 'Wrong admin name or password.'
    saveExpiresAt(Date.now() + IDLE_LIMIT_MS)
    setAdminToken(result.token)
    saveToken(result.token)
    setSessionNotice('')
    setAdminName(result.admin_name)
    return null
  }

  async function signOut() {
    window.clearTimeout(touchTimerRef.current)
    await supabase.rpc('admin_logout')
    setAdminToken(null)
    saveToken(null)
    saveExpiresAt(null)
    setAdminName(null)
  }

  // 10 minutes without activity: sign out and show the message on the sign-in page
  async function endSession() {
    if (endingRef.current) return
    endingRef.current = true
    await signOut()
    setSessionNotice(SESSION_ENDED_MESSAGE)
    endingRef.current = false
  }

  if (!ready) {
    return (
      <div className="lg">
        <p className="lg-loading">Loading…</p>
      </div>
    )
  }

  if (!adminName) return <LoginPage onSignIn={signIn} notice={sessionNotice} />

  return (
    <>
      <Dashboard adminName={adminName} onSignOut={signOut} />
      {warningLeft !== null && (
        <div className="idle-overlay">
          <div
            className="idle-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="idle-title"
            aria-describedby="idle-text"
          >
            <h2 id="idle-title">Are you still there?</h2>
            <p id="idle-text">
              You have been inactive for 8 minutes. You will be signed out in{' '}
              <strong>{formatCountdown(warningLeft)}</strong>. Do you want to stay signed in?
            </p>
            <div className="idle-actions">
              <button type="button" className="idle-btn idle-btn-primary" autoFocus onClick={staySignedIn}>
                Yes, stay signed in
              </button>
              <button type="button" className="idle-btn" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}