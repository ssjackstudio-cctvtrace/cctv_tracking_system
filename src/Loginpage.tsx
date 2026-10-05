import { useState, type FormEvent } from 'react'
import { Logo } from './dashboard'
import './Login.css'

// Admin sign-in only. There is no sign-up: admins are added by hand
// into the public.admin table in Supabase.
type Props = { onSignIn: (name: string, password: string) => Promise<string | null> }

export default function LoginPage({ onSignIn }: Props) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
            <div className="lg-brand-sub">CCTV Tracking</div>
          </div>
        </div>

        <h1>Admin sign in</h1>
        <p className="lg-lead">Sign in with your admin account to continue.</p>

        {error && (
          <p className="lg-error" role="alert">
            {error}
          </p>
        )}

        <label className="lg-field">
          Admin name
          <input
            type="text"
            autoComplete="username"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="lg-field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button type="submit" className="lg-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
