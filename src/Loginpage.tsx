import { useEffect, useState, type FormEvent } from 'react'
import { Logo } from './dashboard'
import './Login.css'

// Admin sign-in only. There is no sign-up: admins are added by hand
// into the public.admin table in Supabase.
type Props = {
  onSignIn: (name: string, password: string) => Promise<string | null>
  notice?: string // e.g. "Your session has ended…"
}

export default function LoginPage({ onSignIn, notice }: Props) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false) // true only while the eye is held down
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Browser tab title for the sign-in page
  useEffect(() => {
    document.title = 'Login - JackStudio Retail System Tracking'
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const err = await onSignIn(name.trim(), password)
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <div className="lg">
      <form className="lg-card" onSubmit={onSubmit}>
        <div className="lg-brand">
          <Logo />
          <div>
            <div className="lg-brand-name">JackStudio</div>
            <div className="lg-brand-sub">Retail System Tracking</div>
          </div>
        </div>

        <h1>Admin sign in</h1>
        <p className="lg-lead">Sign in with your admin account to continue.</p>

        {!error && notice && (
          <p className="lg-error" role="alert">
            {notice}
          </p>
        )}

        {error && (
          <p className="lg-error" role="alert">
            {error}
          </p>
        )}

        <label className="lg-field">
          Admin Name
          <input
            type="text"
            autoComplete="username"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g: admin"
          />
        </label>

        <label className="lg-field">
          Password
          <span className="lg-pw">
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="e.g: abc123"
            />
            {/* Press and hold to show the password; let go to hide it again */}
            <button
              type="button"
              className="lg-eye"
              aria-label="Hold to show password"
              title="Hold to show password"
              aria-pressed={showPassword}
              onPointerDown={(e) => {
                e.preventDefault() // keep the cursor in the password box
                setShowPassword(true)
              }}
              onPointerUp={() => setShowPassword(false)}
              onPointerLeave={() => setShowPassword(false)}
              onPointerCancel={() => setShowPassword(false)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  setShowPassword(true)
                }
              }}
              onKeyUp={() => setShowPassword(false)}
              onBlur={() => setShowPassword(false)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
                {!showPassword && <path d="M3 3l18 18" />}
              </svg>
            </button>
          </span>
        </label>

        <button type="submit" className="lg-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}