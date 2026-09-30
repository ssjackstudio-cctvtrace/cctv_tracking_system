import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import type { Branch, BranchEditable } from './types'
import BranchCard from './BranchCard'

const COLUMNS =
  'branch_id, branch_name, house_unit, street, township, formatted_address, postal_code, city, state, country, google_place_id, latitude, longitude, created_at'

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // 1. Track who is logged in
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  // 2. Load branches once when the page opens
  useEffect(() => {
    supabase
      .from('branch')
      .select(COLUMNS)
      .order('branch_name', { ascending: true })
      .then(({ data, error }) => {
        if (error) setMessage(`Failed to load branches: ${error.message}`)
        else setBranches(data as Branch[])
        setLoading(false)
      })
  }, [])

  // 3. Update
  async function handleSave(branchId: string, changes: BranchEditable): Promise<boolean> {
    setBusy(true)
    const { data, error } = await supabase
      .from('branch')
      .update(changes)
      .eq('branch_id', branchId)
      .select(COLUMNS)
    setBusy(false)

    if (error) {
      setMessage(`Update failed: ${error.message}`)
      return false
    }
    // RLS blocks silently: no error, but zero rows come back
    if (!data || data.length === 0) {
      setMessage('Update was blocked. Are you logged in, and does the RLS policy exist?')
      return false
    }

    setBranches((prev) =>
      prev.map((b) => (b.branch_id === branchId ? (data[0] as Branch) : b)),
    )
    setMessage('')
    return true
  }

  // 4. Delete
  async function handleDelete(branch: Branch): Promise<void> {
    if (!window.confirm(`Delete "${branch.branch_name}"? This cannot be undone.`)) return

    setBusy(true)
    const { data, error } = await supabase
      .from('branch')
      .delete()
      .eq('branch_id', branch.branch_id)
      .select('branch_id')
    setBusy(false)

    if (error) {
      setMessage(`Delete failed: ${error.message}`)
      return
    }
    if (!data || data.length === 0) {
      setMessage('Delete was blocked. Are you logged in, and does the RLS policy exist?')
      return
    }

    setBranches((prev) => prev.filter((b) => b.branch_id !== branch.branch_id))
    setMessage('')
  }

  // 5. Login
  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setMessage(error.message)
    else {
      setEmail('')
      setPassword('')
    }
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Our Branches</h1>
        {session && (
          <button onClick={() => supabase.auth.signOut()}>
            Log out ({session.user.email})
          </button>
        )}
      </header>

      {!session && (
        <form onSubmit={handleLogin} className="login">
          <strong>Admin login</strong>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit">Log in</button>
        </form>
      )}

      {message && <p className="error">{message}</p>}
      {loading && <p>Loading branches…</p>}
      {!loading && branches.length === 0 && !message && <p>No branches found.</p>}

      <div className="grid">
        {branches.map((b) => (
          <BranchCard
            key={b.branch_id}
            branch={b}
            isAdmin={!!session}
            busy={busy}
            onSave={handleSave}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </main>
  )
}