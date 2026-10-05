import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
}

// Admin session token (from admin_login). Sent with every request in the
// x-admin-token header; RLS only returns data for a valid admin session.
let adminToken: string | null = null
export function setAdminToken(token: string | null) {
  adminToken = token
}

// Publishable key only. Safe in the browser because RLS protects the data.
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      if (adminToken) headers.set('x-admin-token', adminToken)
      return fetch(input, { ...init, headers })
    },
  },
})
