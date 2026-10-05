import { useEffect, useState } from 'react'
import { setAdminToken, supabase } from './lib/supabase'
import Dashboard from './dashboard'
import LoginPage from './Loginpage'
import './Login.css'

const TOKEN_KEY = 'cctv_admin_token'

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

// Start on the admin sign-in page; show the dashboard only to signed-in admins
export default function App() {
  const [adminName, setAdminName] = useState<string | null>(null)
  const [ready, setReady] = useState(false) // saved session checked

  // Reopening the site: still signed in?
  useEffect(() => {
    const token = readToken()
    if (!token) {
      setReady(true)
      return
    }
    setAdminToken(token)
    supabase.rpc('admin_check').then(({ data, error }) => {
      if (!error && typeof data === 'string' && data) setAdminName(data)
      else {
        setAdminToken(null)
        saveToken(null)
      }
      setReady(true)
    })
  }, [])

  async function signIn(name: string, password: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('admin_login', { p_name: name, p_password: password })
    if (error) return error.message
    const result = data as { token: string; admin_name: string } | null
    if (!result) return 'Wrong admin name or password.'
    setAdminToken(result.token)
    saveToken(result.token)
    setAdminName(result.admin_name)
    return null
  }

  async function signOut() {
    await supabase.rpc('admin_logout')
    setAdminToken(null)
    saveToken(null)
    setAdminName(null)
  }

  if (!ready) {
    return (
      <div className="lg">
        <p className="lg-loading">Loading…</p>
      </div>
    )
  }

  if (!adminName) return <LoginPage onSignIn={signIn} />

  return <Dashboard adminName={adminName} onSignOut={signOut} />
}
