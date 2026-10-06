import { useEffect, useRef, useState } from 'react'
import { setAdminToken, supabase } from './lib/supabase'
import Dashboard from './dashboard'
import LoginPage from './Loginpage'
import './Login.css'

const TOKEN_KEY = 'cctv_admin_token'
const EXPIRES_AT_KEY = 'cctv_admin_expires_at' // when the session ends (ms)
const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again between 9:00 am and 11:00 pm.'

// 11:00 pm Malaysia time (UTC+8, no daylight saving) today, in ms.
// Used only if the server did not send expires_at.
function todaySessionEnd(): number {
  const offset = 8 * 60 * 60 * 1000
  const day = 24 * 60 * 60 * 1000
  const myDayStart = Math.floor((Date.now() + offset) / day) * day
  return myDayStart + 23 * 60 * 60 * 1000 - offset
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
  const expiresAtRef = useRef<number | null>(null)
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
      // Past 11:00 pm of the sign-in day: end that session on the server too
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
        expiresAtRef.current = expiresAt
        setAdminName(data)
      } else {
        setAdminToken(null)
        saveToken(null)
        saveExpiresAt(null)
      }
      setReady(true)
    })
  }, [])

  // Signed in: end the session at 11:00 pm
  useEffect(() => {
    if (!adminName) return
    const expiresAt = expiresAtRef.current ?? todaySessionEnd()
    const check = () => {
      if (Date.now() >= expiresAt) void endSession()
    }
    const timer = window.setTimeout(check, Math.max(0, expiresAt - Date.now()))
    // Timers can run late in background tabs, so check again when the tab is shown
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [adminName])

  async function signIn(name: string, password: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('admin_login', { p_name: name, p_password: password })
    if (error) return error.message
    const result = data as { token: string; admin_name: string; expires_at?: string } | null
    if (!result) return 'Wrong admin name or password.'
    const serverEnd = result.expires_at ? Date.parse(result.expires_at) : NaN
    const expiresAt = Number.isFinite(serverEnd) ? serverEnd : todaySessionEnd()
    expiresAtRef.current = expiresAt
    saveExpiresAt(expiresAt)
    setAdminToken(result.token)
    saveToken(result.token)
    setSessionNotice('')
    setAdminName(result.admin_name)
    return null
  }

  async function signOut() {
    await supabase.rpc('admin_logout')
    setAdminToken(null)
    saveToken(null)
    saveExpiresAt(null)
    expiresAtRef.current = null
    setAdminName(null)
  }

  // 11:00 pm reached: sign out and show the message on the sign-in page
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

  return <Dashboard adminName={adminName} onSignOut={signOut} />
}