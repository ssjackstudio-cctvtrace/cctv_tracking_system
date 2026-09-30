import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

// Change a name here if your Supabase table is called something else
export const TABLES = {
  branch: 'branch',
  camera: 'camera',
  visit: 'visit',
  cctvEvent: 'cctv_event',
  recognitionEvent: 'recognition_event',
  transaction: 'transaction',
} as const

// Loads rows from one table. Returns empty rows (not an error) when there is no data.
export function useTable<T>(table: string, orderBy?: string, ascending = false, limit = 100) {
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const base = supabase.from(table).select('*')
    const query = orderBy ? base.order(orderBy, { ascending }) : base
    query.limit(limit).then(({ data, error }) => {
      if (cancelled) return
      if (error) setError(error.message)
      else setRows((data ?? []) as T[])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [table, orderBy, ascending, limit])

  return { rows, loading, error }
}

export const formatTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-MY') : '—'

export const shortId = (id: string | null) => (id ? id.slice(0, 8) : '—')