import { useEffect, useRef, useState } from 'react'
import { setAdminToken, supabase } from './lib/supabase'
import Dashboard from './dashboard'
import LoginPage from './Loginpage'
import './Login.css'

const TOKEN_KEY = 'cctv_admin_token'
const LOGIN_AT_KEY = 'cctv_admin_login_at' // when the admin signed in (ms)
const SESSION_LIMIT_MS = 5 * 60 * 1000 // a sign-in lasts 5 minutes
const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.'

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
function readLoginAt(): number | null {
  try {
    const v = Number(localStorage.getItem(LOGIN_AT_KEY))
    return v > 0 ? v : null
  } catch {
    return null
  }
}
function saveLoginAt(time: number | null) {
  try {
    if (time) localStorage.setItem(LOGIN_AT_KEY, String(time))
    else localStorage.removeItem(LOGIN_AT_KEY)
  } catch {
    // storage blocked: the in-memory sign-in time is still used
  }
}

// Start on the admin sign-in page; show the dashboard only to signed-in admins
export default function App() {
  const [adminName, setAdminName] = useState<string | null>(null)
  const [ready, setReady] = useState(false) // saved session checked
  const [sessionNotice, setSessionNotice] = useState('') // shown on the sign-in page
  const loginAtRef = useRef<number | null>(null)
  const endingRef = useRef(false)

  // Reopening the site: still signed in?
  useEffect(() => {
    const token = readToken()
    if (!token) {
      setReady(true)
      return
    }
    setAdminToken(token)
    const loginAt = readLoginAt()
    if (!loginAt || Date.now() - loginAt >= SESSION_LIMIT_MS) {
      // Signed in more than 5 minutes ago: end that session on the server too
      supabase.rpc('admin_logout').then(() => {
        setAdminToken(null)
        saveToken(null)
        saveLoginAt(null)
        if (loginAt) setSessionNotice(SESSION_ENDED_MESSAGE)
        setReady(true)
      })
      return
    }
    supabase.rpc('admin_check').then(({ data, error }) => {
      if (!error && typeof data === 'string' && data) {
        loginAtRef.current = loginAt
        setAdminName(data)
      } else {
        setAdminToken(null)
        saveToken(null)
        saveLoginAt(null)
      }
      setReady(true)
    })
  }, [])

  // Signed in: end the session 5 minutes after sign-in
  useEffect(() => {
    if (!adminName) return
    const loginAt = loginAtRef.current ?? Date.now()
    const check = () => {
      if (Date.now() - loginAt >= SESSION_LIMIT_MS) void endSession()
    }
    const timer = window.setTimeout(check, Math.max(0, loginAt + SESSION_LIMIT_MS - Date.now()))
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
    const result = data as { token: string; admin_name: string } | null
    if (!result) return 'Wrong admin name or password.'
    const now = Date.now()
    loginAtRef.current = now
    saveLoginAt(now)
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
    saveLoginAt(null)
    loginAtRef.current = null
    setAdminName(null)
  }

  // 5 minutes are up: sign out and show the message on the sign-in page
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